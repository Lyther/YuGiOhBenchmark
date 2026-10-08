import {
  DeckErrorType,
  ErrorMessageType,
  OcgcoreCommonConstants as C,
  PlayerChangeState,
  YGOProMsgHint,
  YGOProMsgRetry,
  YGOProMsgStart,
  YGOProMsgWin,
  YGOProStocChangeSide,
  YGOProStocChat,
  YGOProStocDuelEnd,
  YGOProStocDuelStart,
  YGOProStocErrorMsg,
  YGOProStocGameMsg,
  YGOProStocHandResult,
  YGOProStocHsPlayerChange,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocReplay,
  YGOProStocSelectHand,
  YGOProStocSelectTp,
  YGOProStocTimeLimit,
  YGOProStocTypeChange,
} from "ygopro-msg-encode";

import { exportDeck } from "../deck/deck.js";
import { applyBoard, createBoard } from "../game/board.js";
import { describeEvent } from "../game/events.js";
import { cardName } from "../game/labels.js";
import { RPS_CHOICES } from "../game/prompts/choices.js";
import { buildPrompt, isPromptMessage, lobbyPrompt, resolveAnswer } from "../game/prompts/index.js";
import {
  encodeChat, encodeHandResult, encodeJoinGame, encodeLeaveGame, encodePlayerInfo, encodeReady, encodeResponse,
  encodeStart, encodeSurrender, encodeTimeConfirm, encodeTpResult, encodeUpdateDeck,
} from "../protocol/packets.js";

// A seat-state problem a tool reports as isError; nothing is sent.
export class SeatError extends Error {}

const REPLAY_GRACE_MS = 15_000;
const OBSERVER = 7;
const LOST_CONNECTION = 0x4;
const CONTROL_CHARS = /\p{Cc}/gu;
const PLAYER_TYPES = 4;
const RPS_NAMES = Object.fromEntries(RPS_CHOICES.map(([label, value]) => [value, label]));
const SIDE_REFUSED = "the Side Deck was refused: keep the same Main, Extra and Side counts and only swap cards between them";
const RETRY_TEXT = "The server rejected the previous answer (MSG_RETRY); choose again.";
const DECK_ERRORS = Object.freeze({
  [DeckErrorType.LFLIST]: (card) => `${card} is not allowed by the banlist`,
  [DeckErrorType.OCGONLY]: (card) => `${card} is OCG-only here`,
  [DeckErrorType.TCGONLY]: (card) => `${card} is TCG-only here`,
  [DeckErrorType.UNKNOWNCARD]: (card) => `the server does not know ${card}`,
  [DeckErrorType.CARDCOUNT]: (card) => `too many copies of ${card}`,
  [DeckErrorType.MAINCOUNT]: (_, count) => `the Main Deck must hold 40 to 60 cards (the server counted ${count})`,
  [DeckErrorType.EXTRACOUNT]: (_, count) => `the Extra Deck may hold at most 15 cards (the server counted ${count})`,
  [DeckErrorType.SIDECOUNT]: (_, count) => `the Side Deck may hold at most 15 cards (the server counted ${count})`,
  [DeckErrorType.NOTAVAIL]: (card) => `${card} is not available on this server`,
});

export function createSeat(dependencies) {
  return new Seat(dependencies);
}

function copyDeck(deck) {
  return { main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
}

function autoText({ prompt, auto }) {
  if (prompt.kind === "chain" && prompt.options[0]?.label === "Pass") return "Passed a chain window: nothing can be chained";
  const chosen = auto.counts
    ? auto.counts.map(({ option, count }) => `${count} from ${prompt.options[option - 1].label}`)
    : auto.choose.map((n) => prompt.options[n - 1].label);
  return `Answered automatically, only one legal answer (${prompt.kind}): ${chosen.join(", ")}`;
}

// The seat state machine (contracts.md Domain Model). It is the only holder of
// mutable seat state; packet handling never waits for the model.
class Seat {
  static #stoc = new Map([
    [YGOProStocErrorMsg, (seat, message) => seat.#onError(message)],
    [YGOProStocJoinGame, (seat, message) => seat.#onJoin(message)],
    [YGOProStocTypeChange, (seat, message) => seat.#onTypeChange(message)],
    [YGOProStocHsPlayerEnter, (seat, message) => seat.#onPlayerEnter(message)],
    [YGOProStocHsPlayerChange, (seat, message) => seat.#onPlayerChange(message)],
    [YGOProStocDuelStart, (seat) => seat.#onDuelStart()],
    [YGOProStocSelectHand, (seat) => seat.#onSelectHand()],
    [YGOProStocHandResult, (seat, message) => seat.#onHandResult(message)],
    [YGOProStocSelectTp, (seat) => seat.#onSelectTp()],
    [YGOProStocChangeSide, (seat) => seat.#onChangeSide()],
    [YGOProStocTimeLimit, (seat) => seat.#send(encodeTimeConfirm())],
    [YGOProStocChat, (seat, message) => seat.#onChat(message)],
    [YGOProStocReplay, (seat, _message, raw) => seat.#onReplay(raw)],
    [YGOProStocDuelEnd, (seat) => seat.#onDuelEnd()],
    [YGOProStocGameMsg, (seat, message, raw) => seat.#onGame(message, raw)],
  ]);

  static #game = new Map([
    [YGOProMsgStart, (seat, msg) => seat.#onStart(msg)],
    [YGOProMsgHint, (seat, msg) => seat.#onHint(msg)],
    [YGOProMsgWin, (seat, msg) => seat.#onWin(msg)],
    [YGOProMsgRetry, (seat) => seat.#onRetry()],
  ]);

  #config; #catalog; #record; #connect; #log; #graceMs;
  #connection = null;
  #joined = false;
  #versionRetried = false;
  #reconnecting = false;
  #closing = false;
  #selfType = null;
  #ready = [false, false];
  #startSent = false;
  #waiter = null;
  #replayTimer = null;
  #duelsPlayed = 0;
  #replaysReceived = 0;
  #decksRecorded = new Set();
  #sideSubmitted = false;
  #forfeit = null;
  #finished = null;
  #state;

  constructor({ config, catalog, deck, record, connect, log, replayGraceMs = REPLAY_GRACE_MS }) {
    this.#config = config;
    this.#catalog = catalog;
    this.#record = record;
    this.#connect = connect;
    this.#log = log;
    this.#graceMs = replayGraceMs;
    this.#state = {
      phase: "deck", room: config.room, name: config.name, host: false, opponent: null, opponentReady: false,
      prompt: null, lastPrompt: null, promptSeq: 0, events: [], board: null, hint: null,
      deck: copyDeck(deck), submitted: null, delivered: { event: 0, boardVersion: -1 },
      match: { duel: 0, results: [], score: { me: 0, opponent: 0, draws: 0 } }, disconnect: null, waiting: null,
    };
    this.#setPrompt(lobbyPrompt("deck", { text: this.#deckText() }));
  }

  get catalog() {
    return this.#catalog;
  }

  get connected() {
    return Boolean(this.#connection && !this.#connection.closed && this.#joined);
  }

  snapshot() {
    return this.#state;
  }

  markDelivered({ event, boardVersion }) {
    const delivered = this.#state.delivered;
    delivered.event = Math.max(delivered.event, event);
    delivered.boardVersion = Math.max(delivered.boardVersion, boardVersion);
  }

  async wait() {
    if (this.#waiter) return Promise.reject(new SeatError("a call is already waiting; let it return first"));
    const ready = this.#readyReason();
    const reason = ready ?? await new Promise((resolve) => {
      const timer = setTimeout(() => this.#wake("timeout"), this.#config.waitMs);
      timer.unref?.();
      this.#waiter = { resolve, timer };
    });
    // A chat or prompt can wake this call earlier in the same packet batch
    // that ends the match. Check the final state before returning any view.
    if (this.#state.phase === "ended") {
      await this.#finished;
      return "ended";
    }
    return reason;
  }

  async answer(answer) {
    this.#requireIdle();
    this.#requireLive();
    const prompt = this.#state.prompt;
    if (!prompt) throw new SeatError("no prompt is pending; call wait");
    const action = resolveAnswer(prompt, answer);
    this.#state.prompt = null;
    this.#state.lastPrompt = prompt;
    try {
      await this.#perform(action, prompt);
    } catch (error) {
      if (!this.#state.prompt && this.#state.phase !== "disconnected") this.#state.prompt = prompt;
      throw error;
    }
    return this.wait();
  }

  chat(text) {
    this.#requireLive();
    if (!this.connected) throw new SeatError("not connected yet: chat works after the first deck submit");
    this.#send(encodeChat(text));
    return { sent: text };
  }

  surrender() {
    this.#requireIdle();
    this.#requireLive();
    if (this.#state.phase !== "duel") throw new SeatError(`surrender works only during a duel (phase ${this.#state.phase})`);
    this.#send(encodeSurrender());
    this.#state.prompt = null;
    return this.wait();
  }

  setDeck(deck) {
    this.#state.deck = copyDeck(deck);
    if (this.#state.prompt?.kind === "deck") this.#state.prompt = { ...this.#state.prompt, text: this.#deckText() };
  }

  async close() {
    if (this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#replayTimer);
    if (this.#connection && !this.#connection.closed) {
      try {
        this.#connection.send(encodeLeaveGame());
      } catch (error) {
        this.#log.debug({ err: error }, "leave not sent");
      }
      await this.#connection.close();
    }
    this.#wake("disconnected");
    await this.#record.close();
  }

  // Waiting and prompts --------------------------------------------------------

  #readyReason() {
    if (this.#state.prompt) return "prompt";
    if (this.#state.phase === "ended" || this.#state.phase === "disconnected") return this.#state.phase;
    return null;
  }

  #wake(reason) {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reason);
  }

  #requireIdle() {
    if (this.#waiter) throw new SeatError("a call is already waiting; let it return first");
  }

  #requireLive() {
    const { phase, disconnect } = this.#state;
    if (phase === "disconnected") throw new SeatError(`the seat is disconnected (${disconnect.reason}); start a new match`);
    if (phase === "ended") throw new SeatError("the match is over");
  }

  #setPrompt(prompt) {
    this.#state.promptSeq += 1;
    this.#state.prompt = { ...prompt, seq: this.#state.promptSeq };
    this.#state.hint = null;
    this.#wake("prompt");
  }

  #event(kind, text, extra = {}) {
    const state = this.#state;
    state.events.push({ seq: state.events.length + 1, duel: state.match.duel, turn: state.board?.turn ?? 0, kind, text, ...extra });
  }

  #deckText() {
    const { main, extra, side } = this.#state.deck;
    return `Your deck: Main ${main.length}, Extra ${extra.length}, Side ${side.length} (the server checks it). Submit it to join the room.`;
  }

  #sideText() {
    const last = this.#state.match.results.at(-1);
    return `Duel ${this.#state.match.duel} is over (${last?.result ?? "no result"}). Side Deck: submit your deck as it is, or edit it first.`;
  }

  // Sending ------------------------------------------------------------------

  #send(bytes) {
    if (!this.#connection || this.#connection.closed) throw new SeatError("not connected");
    this.#connection.send(bytes);
  }

  async #perform(action, prompt) {
    if (action.type === "deck") {
      if (this.#connection) this.#submitDeck(prompt.kind === "side");
      else await this.#join();
      return;
    }
    if (action.type === "hand") this.#send(encodeHandResult(action.value));
    else if (action.type === "tp") this.#send(encodeTpResult(action.goFirst));
    else this.#send(encodeResponse(action.bytes));
  }

  #submitDeck(side) {
    this.#state.submitted = copyDeck(this.#state.deck);
    this.#send(encodeUpdateDeck(this.#state.deck));
    this.#sideSubmitted = side;
    if (side) return;
    this.#state.phase = "lobby";
    this.#send(encodeReady());
  }

  async #join() {
    // Claim the run folder before contacting the server: a rerun or a seat
    // with a colliding name must not mix its files into another match's.
    try {
      this.#record.claim();
    } catch (error) {
      throw new SeatError(error.message);
    }
    this.#state.phase = "lobby";
    this.#state.submitted = copyDeck(this.#state.deck);
    await this.#open(this.#config.version);
  }

  async #open(version) {
    this.#joined = false;
    try {
      this.#connection = await this.#connect({
        host: this.#config.host,
        port: this.#config.port,
        timeoutMs: this.#config.connectTimeoutMs,
        onMessage: (parsed, packet) => this.#onPacket(parsed, packet),
        onError: (error, packet) => this.#onUnreadable(error, packet),
        onClose: (closed) => this.#onClose(closed),
      });
    } catch (error) {
      this.#disconnect(`connect failed: ${error.message}`);
      return;
    }
    this.#record.startCapture();
    this.#connection.send(encodePlayerInfo(this.#config.name));
    this.#connection.send(encodeJoinGame(version, this.#config.room));
  }

  // Receiving ------------------------------------------------------------------

  #onPacket({ message, raw }, packet) {
    this.#record.packet(packet);
    const handle = Seat.#stoc.get(message?.constructor);
    if (handle) handle(this, message, raw);
    else this.#log.debug({ id: packet[2], type: message?.constructor?.name ?? message?.kind }, "server packet not used");
  }

  #onUnreadable(error, packet) {
    this.#record.packet(packet);
    if (packet[2] === YGOProStocReplay.identifier) {
      this.#onReplay(packet.subarray(3));
      return;
    }
    this.#log.error({ err: error, id: packet[2] }, "unreadable server packet");
    this.#event("unreadable", `Unreadable server packet ${packet[2]}: ${error.message}`);
  }

  #onClose({ reason, error }) {
    if (this.#closing || this.#reconnecting || this.#state.phase === "ended") return;
    if (this.#replayTimer !== null) {
      this.#finishMatch();
      return;
    }
    this.#disconnect(error ? `${reason}: ${error.message}` : reason);
  }

  #disconnect(reason) {
    const phase = this.#state.phase;
    if (phase === "ended" || phase === "disconnected") return;
    this.#state.phase = "disconnected";
    this.#state.disconnect = { reason };
    this.#state.prompt = null;
    this.#state.waiting = null;
    this.#log.warn({ reason, phase }, "seat disconnected");
    this.#writeResult({ type: "aborted", phase, duel: this.#state.match.duel, reason });
    this.#wake("disconnected");
  }

  #writeResult(line) {
    this.#record.result(line).catch((error) => this.#writeFailed("results.jsonl", error));
  }

  #writeFailed(what, error) {
    this.#log.error({ err: error, what }, "run folder write failed");
    this.#event("server", `Could not write ${what}: ${error.message}`);
  }

  // Lobby --------------------------------------------------------------------

  #onError(message) {
    if (message.msg === ErrorMessageType.VERERROR) {
      this.#onVersion(message.code).catch((error) => this.#disconnect(`reconnect failed: ${error.message}`));
      return;
    }
    if (message.msg === ErrorMessageType.DECKERROR) {
      this.#onDeckError(message.code >>> 0);
      return;
    }
    if (message.msg === ErrorMessageType.SIDEERROR) {
      this.#sideSubmitted = false;
      this.#event("rejected", SIDE_REFUSED);
      this.#setPrompt({ ...lobbyPrompt("side", { text: this.#sideText() }), rejected: SIDE_REFUSED });
      return;
    }
    this.#disconnect(`join rejected: ${ErrorMessageType[message.msg] ?? message.msg} ${message.code}`);
  }

  async #onVersion(offered) {
    if (this.#versionRetried || offered === this.#config.version) {
      this.#disconnect(`server rejected client version 0x${this.#config.version.toString(16)} (it offered 0x${offered.toString(16)})`);
      return;
    }
    this.#versionRetried = true;
    this.#log.info({ version: this.#config.version, offered }, "version mismatch; reconnecting once");
    this.#reconnecting = true;
    await this.#connection.close();
    this.#reconnecting = false;
    this.#connection = null;
    await this.#open(offered);
  }

  #onDeckError(code) {
    const describe = DECK_ERRORS[code >>> 28];
    const detail = code & 0x0fffffff;
    const reason = describe ? `deck refused: ${describe(cardName(detail, this.#catalog), detail)}` : `the server refused the deck data (code ${code})`;
    this.#state.phase = "deck";
    this.#event("rejected", reason);
    this.#setPrompt({ ...lobbyPrompt("deck", { text: this.#deckText() }), rejected: reason });
  }

  #onJoin({ info }) {
    this.#joined = true;
    const format = ["single duel", "match (Bo3)", "tag duel"][info.mode] ?? `mode ${info.mode}`;
    const banlist = info.lflist ? `banlist ${info.lflist}` : "no banlist";
    const clock = info.time_limit ? `${info.time_limit} s clock` : "no clock";
    this.#event("lobby", `Joined room ${this.#config.room}: ${format}, ${banlist}, ${clock}`);
    this.#submitDeck(false);
  }

  #onTypeChange(message) {
    this.#selfType = message.playerPosition;
    this.#state.host = message.isHost;
  }

  #onPlayerEnter({ name: raw, pos }) {
    if (pos === this.#selfType) return;
    // The name is the other client's text and appears in the model's view.
    const name = raw.replace(CONTROL_CHARS, " ");
    this.#state.opponent = name;
    this.#event("lobby", `${name} joined the room`);
  }

  #onPlayerChange({ playerPosition: position, playerState }) {
    if (playerState === PlayerChangeState.LEAVE && position !== this.#selfType) {
      this.#event("lobby", `${this.#state.opponent ?? "The opponent"} left the room`);
      this.#state.opponent = null;
    }
    if (position > 1) return;
    this.#ready[position] = playerState === PlayerChangeState.READY;
    if (position === this.#selfType && this.#ready[position]) this.#deckAccepted(1);
    if (position !== this.#selfType) this.#state.opponentReady = this.#ready[position];
    if (!this.#ready[position]) this.#startSent = false;
    if (this.#state.host && this.#ready[0] && this.#ready[1] && !this.#startSent) {
      this.#startSent = true;
      this.#send(encodeStart());
    }
  }

  #deckAccepted(duel) {
    if (this.#decksRecorded.has(duel)) return;
    this.#decksRecorded.add(duel);
    this.#event("lobby", `Deck accepted for duel ${duel}`);
    const text = exportDeck(this.#state.submitted ?? this.#state.deck, "ydk");
    this.#record.deck(duel, text).catch((error) => this.#writeFailed(`duel-${duel}.ydk`, error));
  }

  // A seat that leaves while siding also makes the server send DUEL_START to
  // whoever has not submitted; that is no accepted deck.
  #onDuelStart() {
    if (this.#state.phase === "side" && this.#sideSubmitted) this.#deckAccepted(this.#state.match.duel + 1);
  }

  #onSelectHand() {
    this.#state.phase = "rps";
    this.#setPrompt(lobbyPrompt("rps"));
  }

  #onHandResult({ res1, res2 }) {
    const outcome = res1 === res2 ? "a tie, play again" : (res1 - res2 + 3) % 3 === 2 ? "you win" : "opponent wins";
    this.#event("lobby", `Rock-paper-scissors: you ${RPS_NAMES[res1]}, opponent ${RPS_NAMES[res2]} (${outcome})`);
  }

  #onSelectTp() {
    const text = this.#state.match.duel === 0
      ? "You won rock-paper-scissors: go first or second?"
      : "You lost the last duel: go first or second?";
    this.#state.phase = "first";
    this.#setPrompt(lobbyPrompt("first", { text }));
  }

  #onChangeSide() {
    this.#sideSubmitted = false;
    this.#state.phase = "side";
    this.#setPrompt(lobbyPrompt("side", { text: this.#sideText() }));
  }

  // During a duel the server tags chat with the duel player index, otherwise
  // with the lobby position.
  #onChat({ player_type: type, msg }) {
    const self = this.#state.phase === "duel" ? this.#state.board?.me : this.#selfType;
    if (type === self) return;
    const from = type === OBSERVER ? "observer" : type < PLAYER_TYPES ? "opponent" : "server";
    this.#event("chat", msg, { from });
    if (from === "opponent") this.#wake("chat");
  }

  // Match end ----------------------------------------------------------------

  #onReplay(raw) {
    this.#replaysReceived += 1;
    this.#record.replay(Uint8Array.from(raw)).catch((error) => this.#writeFailed("a replay file", error));
    if (this.#replayTimer !== null && this.#replaysReceived >= this.#duelsPlayed) this.#finishMatch();
  }

  // srvpro sends the replays it held right after DUEL_END; the match is
  // reported over once one replay per duel arrived, the server closed, or the
  // grace window passed, so the run folder is complete first.
  #onDuelEnd() {
    this.#state.waiting = "server";
    this.#state.prompt = null;
    if (this.#replaysReceived >= this.#duelsPlayed) {
      this.#finishMatch();
      return;
    }
    this.#replayTimer = setTimeout(() => this.#finishMatch(), this.#graceMs);
    this.#replayTimer.unref?.();
  }

  #finishMatch() {
    if (this.#state.phase === "ended") return;
    clearTimeout(this.#replayTimer);
    this.#replayTimer = null;
    const { score } = this.#state.match;
    const byScore = score.me > score.opponent ? "win" : score.me < score.opponent ? "loss" : "draw";
    const result = this.#forfeit ?? byScore;
    this.#state.phase = "ended";
    this.#state.waiting = null;
    const how = this.#forfeit ? " by forfeit" : "";
    this.#event("duel", `The match is over: ${result}${how}, ${score.me}-${score.opponent}${score.draws ? ` with ${score.draws} draws` : ""}`);
    const forfeit = this.#forfeit ? { forfeit: true } : {};
    this.#writeResult({ type: "match", result, score: { ...score }, opponent: this.#state.opponent, ...forfeit });
    // The run folder must be complete before any call reports the match over.
    this.#finished = this.#record.flush().catch((error) => this.#writeFailed("the run folder", error));
    this.#finished.then(() => this.#wake("ended"));
  }

  // Duel ---------------------------------------------------------------------

  #onGame({ msg }, raw) {
    if (!msg) {
      this.#log.error({ id: raw[0] }, "unreadable game message");
      this.#event("unreadable", `Unreadable game message ${raw[0]}`);
      return;
    }
    const handle = Seat.#game.get(msg.constructor);
    if (handle) {
      handle(this, msg);
      return;
    }
    if (isPromptMessage(msg)) {
      this.#onPrompt(msg);
      return;
    }
    const board = this.#state.board;
    if (!board) return;
    const event = describeEvent(msg, { board, catalog: this.#catalog });
    if (event) this.#event(event.kind, event.text);
    this.#state.board = applyBoard(board, msg, { catalog: this.#catalog });
  }

  #onStart(msg) {
    const { match } = this.#state;
    match.duel += 1;
    this.#duelsPlayed = match.duel;
    this.#state.board = createBoard({ duel: match.duel, start: msg, version: (this.#state.board?.version ?? -1) + 1 });
    this.#state.phase = "duel";
    this.#state.prompt = null;
    this.#event("duel", `Duel ${match.duel} starts: ${this.#state.board.me === 0 ? "you go first" : "you go second"}`);
  }

  #onHint(msg) {
    if (msg.type === C.HINT_SELECTMSG) {
      this.#state.hint = msg.desc;
      return;
    }
    const event = this.#state.board && describeEvent(msg, { board: this.#state.board, catalog: this.#catalog });
    if (event) this.#event(event.kind, event.text);
  }

  #onWin(msg) {
    const { board, match } = this.#state;
    // In a duel the server numbers players by duel position. Outside one it
    // has restored lobby positions (single_duel.cpp siding and LeaveGame).
    const inDuel = this.#state.phase === "duel";
    const me = (inDuel ? board?.me : this.#selfType) ?? 0;
    const result = msg.player === me ? "win" : msg.player === 1 - me ? "loss" : "draw";
    const reason = this.#catalog.victoryReason(msg.type) ?? `#${msg.type}`;
    // A lost connection ends the whole match: the player who stayed wins it.
    if (msg.type === LOST_CONNECTION) this.#forfeit = result;
    if (!inDuel) {
      this.#state.prompt = null;
      this.#event("win", `The match ended before duel ${match.duel + 1} was played: you ${result === "win" ? "win" : "lose"} it (${reason})`);
      return;
    }
    if (result === "win") match.score.me += 1;
    else if (result === "loss") match.score.opponent += 1;
    else match.score.draws += 1;
    const line = { duel: match.duel, result, reason, reasonCode: msg.type, turns: board?.turn ?? 0, first: me === 0 };
    match.results.push(line);
    const event = board && describeEvent(msg, { board, catalog: this.#catalog });
    if (event) this.#event(event.kind, event.text);
    this.#state.prompt = null;
    this.#writeResult({ type: "duel", ...line });
  }

  #onRetry() {
    const last = this.#state.lastPrompt;
    if (!last) {
      this.#event("unreadable", "The server asked for a retry, but no answer was sent");
      return;
    }
    this.#event("rejected", RETRY_TEXT);
    this.#setPrompt({ ...last, rejected: RETRY_TEXT });
  }

  #onPrompt(msg) {
    const board = this.#state.board;
    if (board && msg.responsePlayer() !== board.me) return;
    const built = buildPrompt(msg, { board, catalog: this.#catalog, hint: this.#state.hint });
    if (built.unsupported) {
      this.#log.error({ type: built.unsupported }, "prompt type not supported");
      this.#event("unreadable", `Unsupported prompt ${built.unsupported}`);
      return;
    }
    if (!built.auto) {
      this.#setPrompt(built.prompt);
      return;
    }
    const action = resolveAnswer(built.prompt, built.auto);
    this.#state.lastPrompt = built.prompt;
    this.#state.hint = null;
    this.#send(encodeResponse(action.bytes));
    this.#event("auto", autoText(built));
  }
}
