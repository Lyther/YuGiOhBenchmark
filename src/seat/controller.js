import {
  OcgcoreCommonConstants as C,
  DeckErrorType,
  ErrorMessageType,
  PlayerChangeState,
  YGOProMsgHint,
  YGOProMsgMatchKill,
  YGOProMsgReloadField,
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

import { exportDeck, parseDeck } from "../deck/deck.js";
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
export class SeatError extends Error { }

const REPLAY_GRACE_MS = 15_000;
// A lost connection is rejoined with backoff 1, 2, 4, 8, 16, 16 s, each with
// jitter in [0.5, 1.5): about 47 s, inside srvpro's reconnect wait (90 s by
// default; 2339 held a dropped seat for 298 s on 2026-10-08).
const REJOIN_ATTEMPTS = 6;
const REJOIN_BASE_MS = 1000;
const REJOIN_CAP_MS = 16_000;
// Rejoins per match, so a flapping link cannot loop forever.
const MATCH_REJOINS = 10;
// A packet the seat cannot handle reloads the duel through a rejoin, at most
// this often per duel; a deterministic fault would otherwise repeat.
const FAULT_REJOINS = 2;
// srvpro answers a recognized rejoin within a second; silence means it no
// longer holds the match (it may even have made a fresh room of that name).
const RESTORE_MS = 15_000;
const OBSERVER = 7;
const LOST_CONNECTION = 0x4;
const CONTROL_CHARS = /\p{Cc}/gu;
const PLAYER_TYPES = 4;
const RPS_NAMES = Object.fromEntries(RPS_CHOICES.map(([label, value]) => [value, label]));
const SIDE_REFUSED = "the Side Deck was refused: keep the same Main, Extra and Side counts and only swap cards between them";
const RETRY_TEXT = "The server rejected the previous answer (MSG_RETRY); choose again.";
const SCORE_KEYS = Object.freeze({ win: "me", loss: "opponent", draw: "draws" });
const UNSEEN = "the seat did not see it end";
const REJOINING = "the seat is rejoining the match after a lost connection; call wait";
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

function resumeNote(found) {
  if (!found || found.refused || !found.started) return null;
  return `This run folder holds an interrupted match (${found.results.length} duels finished). Submit now to rejoin it with the deck it started with; the server holds the seat only for a few minutes.`;
}

// `unknown` counts duels that ended unseen; it is present only when nonzero.
function tally(score, result) {
  const key = SCORE_KEYS[result] ?? "unknown";
  score[key] = (score[key] ?? 0) + 1;
}

function scoreOf(results) {
  const score = { me: 0, opponent: 0, draws: 0 };
  for (const { result } of results) tally(score, result);
  return score;
}

// The known duels decide the match only if no unknown result could change it.
function matchResult({ me, opponent, unknown = 0 }) {
  if (me > opponent + unknown) return "win";
  if (opponent > me + unknown) return "loss";
  return unknown ? "unknown" : "draw";
}

function scoreText({ me, opponent, draws, unknown }) {
  const draw = draws ? ` with ${draws} draws` : "";
  return `${me}-${opponent}${draw}${unknown ? `; ${unknown} duel result${unknown > 1 ? "s" : ""} unknown` : ""}`;
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
    [YGOProMsgMatchKill, (seat, msg) => seat.#onMatchKill(msg)],
    [YGOProMsgReloadField, (seat, msg) => seat.#onReloadField(msg)],
    [YGOProMsgRetry, (seat) => seat.#onRetry()],
  ]);

  #config; #catalog; #record; #connect; #log; #graceMs; #random; #rejoinBaseMs; #restoreMs;
  #connection = null;
  #generation = 0;
  #version;
  #joined = false;
  #versionRetried = false;
  #closing = false;
  // srvpro keeps a dropped seat only once a duel has started (duel_stage past
  // BEGIN), and lets it back with the deck bytes sent in the lobby.
  #started = false;
  #startDeck = null;
  #rejoin = null;
  #rejoinTimer = null;
  #restoreTimer = null;
  #resumeNote = null;
  #rejoins = 0;
  #faults = 0;
  #reloadTurn = null;
  // From a reload's MSG_START to its MSG_RELOAD_FIELD the server rebuilds a
  // duel in progress: those turns and phases are not new.
  #restoring = false;
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
  #matchKill = false;
  #decided = null;
  #finished = null;
  #state;

  constructor({
    config, catalog, deck, record, connect, log, replayGraceMs = REPLAY_GRACE_MS, rejoinBaseMs = REJOIN_BASE_MS, random = Math.random,
    restoreMs = RESTORE_MS,
  }) {
    this.#config = config;
    this.#catalog = catalog;
    this.#record = record;
    this.#connect = connect;
    this.#log = log;
    this.#graceMs = replayGraceMs;
    this.#rejoinBaseMs = rejoinBaseMs;
    this.#restoreMs = restoreMs;
    this.#random = random;
    this.#state = {
      phase: "deck", room: config.room, name: config.name, host: false, opponent: null, opponentReady: false,
      prompt: null, lastPrompt: null, promptSeq: 0, events: [], board: null, hint: null,
      deck: copyDeck(deck), submitted: null, delivered: { event: 0, boardVersion: -1 },
      match: { duel: 0, results: [], score: { me: 0, opponent: 0, draws: 0 } }, disconnect: null, waiting: null,
    };
    this.#resumeNote = resumeNote(record.inspect());
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
    if (this.#rejoin) throw new SeatError(REJOINING);
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

  // A started match is not left on purpose: srvpro keeps a dropped seat for a
  // while, so a restarted seat can still resume it (contracts.md Rejoin).
  async close(why = "seat stopped") {
    if (this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#replayTimer);
    clearTimeout(this.#rejoinTimer);
    clearTimeout(this.#restoreTimer);
    const { phase, match } = this.#state;
    const resumable = this.#started && phase !== "ended" && phase !== "disconnected";
    if (resumable) this.#writeResult({ type: "interrupted", phase, duel: match.duel, turn: this.#state.board?.turn ?? 0, reason: why });
    if (this.#connection && !this.#connection.closed) {
      if (!resumable) this.#sendLeave();
      await this.#connection.close();
    }
    this.#wake("disconnected");
    await this.#record.close();
  }

  #sendLeave() {
    try {
      this.#connection.send(encodeLeaveGame());
    } catch (error) {
      this.#log.debug({ err: error }, "leave not sent");
    }
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
    if (this.#resumeNote) return this.#resumeNote;
    const { main, extra, side } = this.#state.deck;
    return `Your deck: Main ${main.length}, Extra ${extra.length}, Side ${side.length} (the server checks it). Submit it to join the room.`;
  }

  #sideText() {
    const last = this.#state.match.results.at(-1);
    return `Duel ${this.#state.match.duel} is over (${last?.result ?? "no result"}). Side Deck: submit your deck as it is, or edit it first.`;
  }

  // Sending ------------------------------------------------------------------

  #send(bytes) {
    if (!this.#connection || this.#connection.closed) throw new SeatError(this.#rejoin ? REJOINING : "not connected");
    this.#connection.send(bytes);
  }

  async #perform(action, prompt) {
    if (this.#rejoin) throw new SeatError(REJOINING);
    if (action.type === "deck") {
      if (this.#connection) this.#submitDeck(prompt.kind === "side");
      else await this.#join();
      return;
    }
    if (action.type === "hand") this.#send(encodeHandResult(action.value));
    else if (action.type === "tp") this.#send(encodeTpResult(action.goFirst));
    else this.#send(encodeResponse(action.bytes));
  }

  #submitDeck(side, deck = this.#state.deck) {
    this.#state.submitted = copyDeck(deck);
    this.#send(encodeUpdateDeck(deck));
    // srvpro checks a rejoin against the last deck sent before the first duel.
    if (!this.#started) this.#startDeck = this.#state.submitted;
    this.#sideSubmitted = side;
    if (side) return;
    this.#state.phase = "lobby";
    this.#send(encodeReady());
  }

  async #join() {
    // Claim the run folder before contacting the server: a rerun or a seat
    // with a colliding name must not mix its files into another match's.
    let found;
    try {
      found = this.#record.claim();
    } catch (error) {
      throw new SeatError(error.message);
    }
    this.#state.phase = "lobby";
    if (found) this.#resume(found);
    this.#state.submitted = copyDeck(this.#state.deck);
    await this.#open(this.#config.version);
  }

  // A restarted seat continues the match its folder holds (contracts.md
  // Rejoin): results, decks and replay count come back from the folder.
  #resume({ started, duel, turn, results, decks, replays }) {
    const { match } = this.#state;
    match.results = results.map(({ duel: number, result, reason, reasonCode, turns, first }) => ({ duel: number, result, reason, reasonCode, turns, first }));
    match.score = scoreOf(match.results);
    // seat.json names the last duel that started, finished or not.
    match.duel = Math.max(match.results.length, duel);
    this.#duelsPlayed = match.duel;
    this.#replaysReceived = replays;
    for (const number of decks.keys()) this.#decksRecorded.add(number);
    if (decks.size) this.#state.deck = parseDeck(decks.get(Math.max(...decks.keys())));
    this.#startDeck = decks.has(1) ? parseDeck(decks.get(1)) : copyDeck(this.#state.deck);
    // The checkpointed turn belongs to the duel still in progress, if any.
    if (this.#inProgress()) this.#reloadTurn = turn;
    this.#started = started;
    if (started) {
      this.#rejoin = { reason: "the seat restarted", attempts: 0 };
      this.#state.waiting = "rejoin";
    }
    this.#resumeNote = null;
    this.#event("lobby", `Resuming the interrupted match in this folder: ${match.results.length} duels finished, score ${scoreText(match.score)}`);
  }

  // The last duel that started has no result yet.
  #inProgress() {
    const { match } = this.#state;
    return match.results.length < match.duel;
  }

  // The duel in progress is over without an MSG_WIN the seat handled: it ended
  // while the seat was away, or in a packet that failed. srvpro never resends
  // a result, and its later choices do not reveal one.
  #missedDuel() {
    if (!this.#inProgress()) return;
    const { match } = this.#state;
    const line = { duel: match.duel, result: "unknown", reason: UNSEEN };
    match.results.push(line);
    tally(match.score, line.result);
    this.#event("win", `Duel ${match.duel} ended while the seat could not see it; its result is unknown`);
    this.#writeResult({ type: "duel", ...line });
  }

  #checkpoint(fields) {
    this.#record.checkpoint(fields).catch((error) => this.#writeFailed("seat.json", error));
  }

  async #open(version) {
    this.#joined = false;
    this.#version = version;
    // Callbacks of a dropped connection are ignored, including its close.
    const generation = ++this.#generation;
    const current = (handle) => (...args) => {
      if (generation === this.#generation) handle(...args);
    };
    try {
      this.#connection = await this.#connect({
        host: this.#config.host,
        port: this.#config.port,
        timeoutMs: this.#config.connectTimeoutMs,
        onMessage: current((parsed, packet) => this.#onPacket(parsed, packet)),
        onError: current((error, packet) => this.#onUnreadable(error, packet)),
        onClose: current((closed) => this.#onClose(closed)),
      });
    } catch (error) {
      if (this.#rejoin) this.#scheduleRejoin(`connect failed: ${error.message}`);
      else this.#disconnect(`connect failed: ${error.message}`);
      return;
    }
    if (this.#closing) {
      await this.#drop();
      return;
    }
    // Its onClose reports a connection that is already gone.
    if (this.#connection.closed) return;
    this.#record.startCapture();
    this.#connection.send(encodePlayerInfo(this.#config.name));
    this.#connection.send(encodeJoinGame(version, this.#config.room));
  }

  // Receiving ------------------------------------------------------------------

  #onPacket({ message, raw }, packet) {
    this.#record.packet(packet);
    const handle = Seat.#stoc.get(message?.constructor);
    if (!handle) {
      this.#log.debug({ id: packet[2], type: message?.constructor?.name ?? message?.kind }, "server packet not used");
      return;
    }
    try {
      handle(this, message, raw);
    } catch (error) {
      this.#onFault(error, packet);
    }
  }

  #onUnreadable(error, packet) {
    this.#record.packet(packet);
    if (packet[2] === YGOProStocReplay.identifier) {
      this.#onReplay(packet.subarray(3));
      return;
    }
    this.#onFault(error, packet);
  }

  // A packet the seat could not read or handle: its state may now be stale.
  // In a started match the server's copy is reloaded through a rejoin; the
  // fault itself never ends the match or records a result.
  #onFault(error, packet) {
    this.#log.error({ err: error, id: packet[2], packet: packet.subarray(0, 256).toString("hex") }, "server packet not handled");
    this.#event("unreadable", `The seat could not handle server packet ${packet[2]}: ${error.message}`);
    if (!this.#started || this.#rejoin || this.#closing || !this.#isLive()) return;
    if (this.#faults >= FAULT_REJOINS) {
      this.#event("unreadable", "The seat keeps failing in this duel and stops reloading it; the board may be out of date");
      return;
    }
    this.#faults += 1;
    this.#startRejoin(`seat error: ${error.message}`);
  }

  #isLive() {
    return this.#state.phase !== "ended" && this.#state.phase !== "disconnected";
  }

  #onClose({ reason, error }) {
    // A restore deadline ends with the connection it was waiting on.
    clearTimeout(this.#restoreTimer);
    if (this.#closing || this.#state.phase === "ended") return;
    if (this.#replayTimer !== null) {
      this.#finishMatch();
      return;
    }
    const why = error ? `${reason}: ${error.message}` : reason;
    if (this.#rejoin) this.#scheduleRejoin(why);
    else this.#startRejoin(why);
  }

  // Resume first: the seat comes back instead of giving the match up. Before
  // the first duel this is a fresh join; afterwards srvpro restores the seat.
  #startRejoin(reason) {
    if (!this.#isLive()) return;
    if (this.#rejoins >= MATCH_REJOINS) {
      this.#disconnect(`${reason}; no rejoin left (${MATCH_REJOINS} this match)`);
      return;
    }
    this.#rejoins += 1;
    this.#rejoin = { reason, attempts: 0 };
    // srvpro resends a started match's pending prompt; the deck prompt is ours.
    if (this.#started) this.#state.prompt = null;
    this.#ready = [false, false];
    this.#startSent = false;
    this.#state.waiting = "rejoin";
    this.#log.warn({ reason, phase: this.#state.phase }, "connection lost; rejoining");
    this.#event("server", `Lost the connection (${reason}); rejoining the match`);
    this.#drop().catch((error) => this.#log.debug({ err: error }, "dropped connection not closed")).then(() => this.#scheduleRejoin(reason));
  }

  #scheduleRejoin(reason) {
    const rejoin = this.#rejoin;
    if (!rejoin || this.#closing) return;
    // One retry is pending at a time.
    clearTimeout(this.#rejoinTimer);
    if (rejoin.attempts >= REJOIN_ATTEMPTS) {
      this.#disconnect(`could not rejoin after ${REJOIN_ATTEMPTS} attempts (first: ${rejoin.reason}; last: ${reason})`);
      return;
    }
    rejoin.attempts += 1;
    const step = Math.min(this.#rejoinBaseMs * 2 ** (rejoin.attempts - 1), REJOIN_CAP_MS);
    // An attempt that throws counts as failed; nothing may escape a timer.
    this.#rejoinTimer = setTimeout(() => this.#open(this.#version).catch((error) => this.#scheduleRejoin(error.message)), step * (0.5 + this.#random()));
  }

  // Closes the connection without leaving the game, so srvpro keeps the seat.
  async #drop() {
    const connection = this.#connection;
    this.#connection = null;
    this.#joined = false;
    this.#generation += 1;
    if (connection && !connection.closed) await connection.close();
  }

  // The rejoin succeeded or gave up: no pending retry or deadline acts later.
  #endRejoin() {
    this.#rejoin = null;
    clearTimeout(this.#rejoinTimer);
    clearTimeout(this.#restoreTimer);
  }

  #disconnect(reason) {
    const phase = this.#state.phase;
    if (phase === "ended" || phase === "disconnected") return;
    this.#endRejoin();
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
    // 2339 checks the version before it looks for a held seat, so a restarted
    // seat's rejoin gets the same single retry as a first join.
    if (message.msg === ErrorMessageType.VERERROR) {
      this.#onVersion(message.code).catch((error) => this.#disconnect(`reconnect failed: ${error.message}`));
      return;
    }
    if (this.#rejoin && this.#started) {
      const detail = message.msg === ErrorMessageType.DECKERROR ? "the deck differs from the one this match started with" : `${ErrorMessageType[message.msg] ?? message.msg} ${message.code}`;
      this.#refuseRejoin(detail);
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
    await this.#drop();
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

  #refuseRejoin(detail) {
    this.#refuse(`the server refused the rejoin: ${detail}`);
  }

  #refuse(reason) {
    this.#disconnect(reason);
    this.#drop().catch((error) => this.#log.debug({ err: error }, "refused connection not closed"));
  }

  #onJoin({ info }) {
    this.#joined = true;
    if (this.#rejoin && this.#started) {
      this.#event("lobby", `Rejoined room ${this.#config.room}; the server is restoring the match`);
      this.#send(encodeUpdateDeck(this.#startDeck));
      const generation = this.#generation;
      this.#restoreTimer = setTimeout(() => {
        if (generation === this.#generation) this.#refuseRejoin(`it did not restore the match within ${RESTORE_MS / 1000} s`);
      }, this.#restoreMs);
      return;
    }
    this.#endRejoin();
    this.#state.waiting = null;
    const format = ["single duel", "match (Bo3)", "tag duel"][info.mode] ?? `mode ${info.mode}`;
    const banlist = info.lflist ? `banlist ${info.lflist}` : "no banlist";
    const clock = info.time_limit ? `${info.time_limit} s clock` : "no clock";
    this.#event("lobby", `Joined room ${this.#config.room}: ${format}, ${banlist}, ${clock}`);
    // After a refused deck the model resubmits; otherwise the join sends the
    // deck it submitted, not edits made since (2339 deals whatever is sent).
    if (this.#state.phase !== "deck") this.#submitDeck(false, this.#state.submitted ?? this.#state.deck);
  }

  #onTypeChange(message) {
    // srvpro makes anyone it has no player place for an observer: a full
    // room, a duel under way, or a rejoin the match no longer holds. An
    // observer would mirror another player's duel and record it as its own.
    if (message.playerPosition > 1) {
      if (this.#rejoin && this.#started) this.#refuseRejoin("it seated this seat as an observer");
      else this.#refuse(`room ${this.#config.room} has no free player seat (the server seated this seat as an observer); use a fresh room id`);
      return;
    }
    this.#selfType = message.playerPosition;
    this.#state.host = message.isHost;
  }

  #onPlayerEnter({ name: raw, pos }) {
    if (pos === this.#selfType) return;
    // The name is the other client's text and appears in the model's view.
    const name = raw.replace(CONTROL_CHARS, " ");
    this.#state.opponent = name;
    // A rejoin lists the players again; the opponent did not just arrive.
    if (!this.#rejoin) this.#event("lobby", `${name} joined the room`);
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
    if (this.#rejoin) {
      this.#endRejoin();
      this.#state.waiting = null;
      this.#event("server", "Back in the match; the server resends the board and any pending prompt");
      return;
    }
    if (!this.#started) this.#checkpoint({ started: true });
    this.#started = true;
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
    this.#missedDuel();
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
    this.#missedDuel();
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
    const result = this.#forfeit ?? this.#decided ?? matchResult(score);
    this.#state.phase = "ended";
    this.#state.waiting = null;
    const how = this.#forfeit ? " by forfeit" : this.#decided ? " by a match-winning effect" : "";
    this.#event("duel", `The match is over: ${result}${how}, ${scoreText(score)}`);
    const decidedBy = this.#forfeit ? { forfeit: true } : this.#decided ? { matchKill: true } : {};
    this.#writeResult({ type: "match", result, score: { ...score }, opponent: this.#state.opponent, ...decidedBy });
    // The run folder must be complete before any call reports the match over.
    this.#finished = this.#record.flush().catch((error) => this.#writeFailed("the run folder", error));
    this.#finished.then(() => this.#wake("ended"));
  }

  // Duel ---------------------------------------------------------------------

  #onGame({ msg }, raw) {
    if (!msg) throw new Error(`unknown game message ${raw[0]}`);
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
    const next = applyBoard(board, msg, { catalog: this.#catalog });
    const restoring = this.#restoring;
    if (event && !restoring) this.#event(event.kind, event.text);
    this.#state.board = next;
    if (next.turn !== board.turn && !restoring) this.#checkpoint({ turn: next.turn });
  }

  // A rejoin's field reload (srvpro RequestField) restarts the stream with an
  // MSG_START whose decks are empty. It continues the duel in progress, or
  // with none in progress shows one that started while the seat was away.
  #onStart(msg) {
    const { match } = this.#state;
    const previous = this.#state.board;
    const reload = msg.player0.deckCount === 0 && msg.player1.deckCount === 0;
    const continues = reload && this.#inProgress();
    const duel = continues ? match.duel : match.duel + 1;
    const board = createBoard({ duel, start: msg, version: (previous?.version ?? -1) + 1 });
    // Only once the board is built: a malformed MSG_START ends no duel.
    if (!continues) this.#missedDuel();
    if (!reload && !this.#decksRecorded.has(duel)) this.#deckAccepted(duel);
    match.duel = duel;
    this.#duelsPlayed = duel;
    this.#state.board = board;
    this.#state.phase = "duel";
    this.#state.prompt = null;
    this.#restoring = reload;
    if (reload) {
      this.#reloadTurn = continues ? (previous?.turn ?? this.#reloadTurn) : null;
      this.#event("duel", `Duel ${duel} continues from the server's copy of the field`);
      return;
    }
    this.#faults = 0;
    this.#reloadTurn = null;
    this.#checkpoint({ duel, turn: 0 });
    this.#event("duel", `Duel ${duel} starts: ${board.me === 0 ? "you go first" : "you go second"}`);
  }

  // The server does not resend the turn count; the seat keeps its own.
  #onReloadField(msg) {
    const board = this.#state.board;
    if (!board) return;
    const next = applyBoard(board, msg, { catalog: this.#catalog });
    if (this.#reloadTurn !== null) next.turn = this.#reloadTurn;
    this.#reloadTurn = null;
    this.#restoring = false;
    this.#state.board = next;
    this.#checkpoint({ duel: next.duel, turn: next.turn });
    this.#event("server", `The server reloaded the field: turn ${next.turn}, your LP ${next.lp.me}, opponent's LP ${next.lp.opponent}`);
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
    const event = inDuel && board ? describeEvent(msg, { board, catalog: this.#catalog }) : null;
    // A lost connection ends the whole match: the player who stayed wins it.
    if (msg.type === LOST_CONNECTION) this.#forfeit = result;
    if (!inDuel) {
      this.#state.prompt = null;
      this.#event("win", `The match ended before duel ${match.duel + 1} was played: you ${result === "win" ? "win" : "lose"} it (${reason})`);
      return;
    }
    // A match-winning effect ends the match after this duel, won by its
    // winner (single_duel.cpp DuelEndProc; srvpro scores it 99).
    if (this.#matchKill && result !== "draw") this.#decided = result;
    this.#matchKill = false;
    tally(match.score, result);
    const line = { duel: match.duel, result, reason, reasonCode: msg.type, turns: board?.turn ?? 0, first: me === 0 };
    match.results.push(line);
    if (event) this.#event(event.kind, event.text);
    this.#state.prompt = null;
    this.#writeResult({ type: "duel", ...line });
  }

  #onMatchKill(msg) {
    this.#matchKill = true;
    const event = this.#state.board && describeEvent(msg, { board: this.#state.board, catalog: this.#catalog });
    if (event) this.#event(event.kind, event.text);
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
