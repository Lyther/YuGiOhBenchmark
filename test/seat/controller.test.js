import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import {
  DeckErrorType,
  ErrorMessageType,
  OcgcoreCommonConstants as C,
  PlayerChangeState,
  YGOProCtosChat,
  YGOProCtosHandResult,
  YGOProCtosHsReady,
  YGOProCtosHsStart,
  YGOProCtosJoinGame,
  YGOProCtosPlayerInfo,
  YGOProCtosResponse,
  YGOProCtosSurrender,
  YGOProCtosTimeConfirm,
  YGOProCtosTpResult,
  YGOProCtosUpdateDeck,
  YGOProMsgDraw,
  YGOProMsgHint,
  YGOProMsgNewTurn,
  YGOProMsgRetry,
  YGOProMsgSelectChain,
  YGOProMsgSelectIdleCmd,
  YGOProMsgStart,
  YGOProMsgWin,
  YGOProStocChangeSide,
  YGOProStocChat,
  YGOProStocDuelEnd,
  YGOProStocDuelStart,
  YGOProStocErrorMsg,
  YGOProStocHandResult,
  YGOProStocHsPlayerChange,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocSelectHand,
  YGOProStocSelectTp,
  YGOProStocTimeLimit,
  YGOProStocTypeChange,
} from "ygopro-msg-encode";

import { AnswerError } from "../../src/game/prompts/index.js";
import { createLogger } from "../../src/log.js";
import { SeatError, createSeat } from "../../src/seat/controller.js";
import { createRecorder } from "../../src/seat/record.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { createLink } from "../helpers/link.js";
import { gamePacket, stocPacket } from "../helpers/wire.js";

const catalog = await fixtureCatalog();
const log = createLogger("silent");
const ROOM = "M,TM0,NF#ctl";
const NAME = "opus-seat";
const DECK = Object.freeze({ main: [89631139, 89631139, 46986414], extra: [84013237], side: [14558127] });
const HOST_INFO = { lflist: 0, rule: 5, mode: 1, duel_rule: 5, no_check_deck: 0, no_shuffle_deck: 0, start_lp: 8000, start_hand: 5, draw_count: 1, time_limit: 0 };
const BLUE_EYES = 89631139;

async function setup(t, overrides = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "ygo-seat-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const link = createLink();
  const record = createRecorder({ runDir, room: ROOM, name: NAME });
  const config = { host: "koishi.example", port: 2339, name: NAME, room: ROOM, version: 0x1362, waitMs: 2000, ...overrides.config };
  const seat = createSeat({ config, catalog, deck: DECK, record, connect: link.connect, log, replayGraceMs: overrides.replayGraceMs ?? 40 });
  t.after(() => seat.close());
  return { seat, link, folder: record.folder };
}

const types = (packets) => packets.map((packet) => packet.constructor);
const lastEvent = (seat) => seat.snapshot().events.at(-1);
const status = (position, state) => ({ status: (position << 4) | state });

async function joinRoom(seat, link) {
  const pending = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  link.deliver(stocPacket(YGOProStocTypeChange, { type: 0x10 | 0 }));
  link.deliver(stocPacket(YGOProStocHsPlayerEnter, { name: "gpt-seat", pos: 1 }));
  link.deliver(stocPacket(YGOProStocHsPlayerChange, status(0, PlayerChangeState.READY)));
  link.deliver(stocPacket(YGOProStocHsPlayerChange, status(1, PlayerChangeState.READY)));
  link.deliver(stocPacket(YGOProStocDuelStart));
  link.deliver(stocPacket(YGOProStocSelectHand));
  await pending;
}

async function startDuel(seat, link, me = 0) {
  link.deliver(gamePacket(YGOProMsgStart, {
    playerType: me, duelRule: 5, startLp0: 8000, startLp1: 8000,
    player0: { deckCount: 35, extraCount: 1 }, player1: { deckCount: 35, extraCount: 15 },
  }));
}

function idle(player = 0) {
  return gamePacket(YGOProMsgSelectIdleCmd, {
    player, summonableCount: 0, summonableCards: [], spSummonableCount: 0, spSummonableCards: [], reposableCount: 0,
    reposableCards: [], msetableCount: 0, msetableCards: [], ssetableCount: 0, ssetableCards: [], activatableCount: 0,
    activatableCards: [], canBp: 1, canEp: 1, canShuffle: 0,
  });
}

test("before any submit the seat holds the deck prompt and opens no socket", async (t) => {
  const { seat, link } = await setup(t);
  const view = seat.snapshot();
  assert.equal(view.phase, "deck");
  assert.equal(view.prompt.kind, "deck");
  assert.equal(view.prompt.seq, 1);
  await assert.rejects(seat.answer({ choose: [1] }), AnswerError);
  assert.throws(() => seat.chat("hello"), SeatError);
  assert.equal(await seat.wait(), "prompt");
  assert.equal(seat.snapshot().prompt.seq, 1);
  assert.equal(link.connects.length, 0);
});

test("submitting joins with one version retry, readies the deck and lets the host start", async (t) => {
  const { seat, link, folder } = await setup(t);
  const pending = seat.answer({ submit: true });
  await tick();
  assert.deepEqual(types(link.sent), [YGOProCtosPlayerInfo, YGOProCtosJoinGame]);
  assert.equal(link.sent[0].name, NAME);
  assert.equal(link.sent[1].pass, ROOM);
  assert.equal(link.take()[1].version, 0x1362);
  assert.equal(seat.snapshot().phase, "lobby");
  link.deliver(stocPacket(YGOProStocErrorMsg, { msg: ErrorMessageType.VERERROR, code: 0x1363 }));
  await tick();
  assert.equal(link.connects.length, 2, "one reconnect with the server's version");
  assert.equal(link.take()[1].version, 0x1363);
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  const deckPackets = link.take();
  assert.deepEqual(types(deckPackets), [YGOProCtosUpdateDeck, YGOProCtosHsReady]);
  assert.deepEqual([...deckPackets[0].deck.main, ...deckPackets[0].deck.extra], [...DECK.main, ...DECK.extra]);
  assert.deepEqual(deckPackets[0].deck.side, DECK.side);
  link.deliver(stocPacket(YGOProStocTypeChange, { type: 0x10 | 0 }));
  link.deliver(stocPacket(YGOProStocHsPlayerEnter, { name: "gpt-seat", pos: 1 }));
  assert.equal(seat.snapshot().opponent, "gpt-seat");
  link.deliver(stocPacket(YGOProStocHsPlayerChange, status(0, PlayerChangeState.READY)));
  assert.deepEqual(link.take(), []);
  link.deliver(stocPacket(YGOProStocHsPlayerChange, status(1, PlayerChangeState.READY)));
  assert.deepEqual(types(link.take()), [YGOProCtosHsStart]);
  link.deliver(stocPacket(YGOProStocSelectHand));
  assert.equal(await pending, "prompt");
  assert.equal(seat.snapshot().phase, "rps");
  await seat.close();
  assert.match(await readFile(join(folder, "duel-1.ydk"), "utf8"), /#main\n89631139\n89631139\n46986414\n#extra\n84013237\n!side\n14558127/);
});

test("a deck error returns to the deck prompt with the server's reason and resubmits on the same socket", async (t) => {
  const { seat, link } = await setup(t);
  const pending = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  link.take();
  link.deliver(stocPacket(YGOProStocHsPlayerChange, status(0, PlayerChangeState.NOTREADY)));
  link.deliver(stocPacket(YGOProStocErrorMsg, { msg: ErrorMessageType.DECKERROR, code: ((DeckErrorType.MAINCOUNT << 28) | 3) >>> 0 }));
  assert.equal(await pending, "prompt");
  const view = seat.snapshot();
  assert.equal(view.phase, "deck");
  assert.equal(view.prompt.kind, "deck");
  assert.match(view.prompt.rejected, /Main Deck.*40/);
  assert.equal(lastEvent(seat).kind, "rejected");
  const again = seat.answer({ submit: true });
  await tick();
  assert.deepEqual(types(link.take()), [YGOProCtosUpdateDeck, YGOProCtosHsReady]);
  assert.equal(link.connects.length, 1);
  link.deliver(stocPacket(YGOProStocErrorMsg, { msg: ErrorMessageType.DECKERROR, code: ((DeckErrorType.UNKNOWNCARD << 28) | BLUE_EYES) >>> 0 }));
  await again;
  assert.match(seat.snapshot().prompt.rejected, /Blue-Eyes White Dragon/);
});

test("rock-paper-scissors, first player, duel prompts, empty-chain auto-pass, keepalive and server retry", async (t) => {
  const { seat, link } = await setup(t);
  await joinRoom(seat, link);
  link.take();
  const afterHand = seat.answer({ choose: [2] });
  await tick();
  const [hand] = link.take();
  assert.ok(hand instanceof YGOProCtosHandResult);
  assert.equal(hand.res, 3, "Paper");
  link.deliver(stocPacket(YGOProStocHandResult, { res1: 3, res2: 1 }));
  assert.match(lastEvent(seat).text, /you Paper, opponent Rock/);
  link.deliver(stocPacket(YGOProStocSelectTp));
  await afterHand;
  assert.equal(seat.snapshot().phase, "first");
  const afterFirst = seat.answer({ choose: [1] });
  await tick();
  const [tp] = link.take();
  assert.ok(tp instanceof YGOProCtosTpResult);
  assert.equal(tp.res, 1);
  await startDuel(seat, link);
  assert.equal(seat.snapshot().phase, "duel");
  assert.equal(seat.snapshot().board.me, 0);
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 0 }));
  link.deliver(gamePacket(YGOProMsgDraw, { player: 0, count: 1, cards: [BLUE_EYES] }));
  link.deliver(gamePacket(YGOProMsgSelectChain, { player: 0, count: 0, specialCount: 0, hint0: 0, hint1: 0, chains: [] }));
  const [pass] = link.take();
  assert.ok(pass instanceof YGOProCtosResponse, "an empty chain window is passed by the seat");
  assert.deepEqual([...pass.response], [255, 255, 255, 255]);
  assert.equal(lastEvent(seat).kind, "auto");
  link.deliver(gamePacket(YGOProMsgHint, { type: C.HINT_SELECTMSG, player: 0, desc: 501 }));
  link.deliver(idle(0));
  await afterFirst;
  const prompt = seat.snapshot().prompt;
  assert.equal(prompt.kind, "command");
  link.deliver(stocPacket(YGOProStocTimeLimit, { player: 0, left_time: 0 }));
  assert.deepEqual(types(link.take()), [YGOProCtosTimeConfirm], "keepalive confirmed while the model thinks");
  const afterEnd = seat.answer({ choose: [2] });
  await tick();
  const [endTurn] = link.take();
  assert.deepEqual([...endTurn.response], [7, 0, 0, 0]);
  link.deliver(gamePacket(YGOProMsgRetry, {}));
  await afterEnd;
  const retried = seat.snapshot().prompt;
  assert.equal(retried.kind, "command");
  assert.ok(retried.seq > prompt.seq);
  assert.match(retried.rejected, /rejected/);
});

async function playDuel(seat, link, { winner, me = 0 }) {
  await startDuel(seat, link, me);
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 0 }));
  link.deliver(gamePacket(YGOProMsgWin, { player: winner, type: 1 }));
}

test("siding, side errors, and the match ends only after one replay per duel", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await playDuel(seat, link, { winner: 0 });
  link.deliver(stocPacket(YGOProStocChangeSide));
  assert.equal(await seat.wait(), "prompt");
  assert.equal(seat.snapshot().phase, "side");
  assert.equal(seat.snapshot().prompt.kind, "side");
  link.take();
  const sideSubmit = seat.answer({ submit: true });
  await tick();
  assert.deepEqual(types(link.take()), [YGOProCtosUpdateDeck]);
  link.deliver(stocPacket(YGOProStocErrorMsg, { msg: ErrorMessageType.SIDEERROR, code: 0 }));
  await sideSubmit;
  assert.match(seat.snapshot().prompt.rejected, /Side/);
  const resubmit = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocDuelStart));
  const firstDuelVersion = seat.snapshot().board.version;
  await playDuel(seat, link, { winner: 1, me: 1 });
  assert.ok(seat.snapshot().board.version > firstDuelVersion, "board versions keep rising across duels");
  link.deliver(stocPacket(YGOProStocDuelEnd));
  assert.notEqual(seat.snapshot().phase, "ended", "replays have not arrived yet");
  assert.equal(seat.snapshot().waiting, "server");
  link.deliver(Buffer.from([4, 0, 23, 1, 2, 3]));
  assert.notEqual(seat.snapshot().phase, "ended");
  link.deliver(Buffer.from([4, 0, 23, 4, 5, 6]));
  assert.equal(await resubmit, "ended");
  assert.equal(seat.snapshot().phase, "ended");
  assert.deepEqual(seat.snapshot().match.score, { me: 2, opponent: 0, draws: 0 });
  const atEnd = await readFile(join(folder, "results.jsonl"), "utf8");
  assert.match(atEnd, /"type":"match"/, "the run folder is complete when ended is reported");
  assert.deepEqual((await readdir(folder)).filter((file) => file.endsWith(".yrp")).sort(), ["replay-1.yrp", "replay-2.yrp"]);
  await seat.close();
  assert.deepEqual((await readdir(folder)).sort(), ["duel-1.ydk", "duel-2.ydk", "replay-1.yrp", "replay-2.yrp", "results.jsonl"]);
  assert.deepEqual([...await readFile(join(folder, "replay-2.yrp"))], [4, 5, 6], "unparseable replays are still saved raw");
  const lines = (await readFile(join(folder, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "win"], ["duel", "win"], ["match", "win"]]);
  assert.equal(lines[0].reason, "LP reached 0");
  assert.equal(lines[0].first, true);
  assert.equal(lines[1].first, false);
});

test("a one-duel match ends after its single replay, and a missing replay ends after the grace window", async (t) => {
  const one = await setup(t);
  await joinRoom(one.seat, one.link);
  await playDuel(one.seat, one.link, { winner: 1 });
  one.link.deliver(stocPacket(YGOProStocDuelEnd));
  one.link.deliver(Buffer.from([4, 0, 23, 9, 9, 9]));
  assert.equal(one.seat.snapshot().phase, "ended");
  assert.deepEqual(one.seat.snapshot().match.score, { me: 0, opponent: 1, draws: 0 });

  const late = await setup(t, { replayGraceMs: 30 });
  await joinRoom(late.seat, late.link);
  await playDuel(late.seat, late.link, { winner: 0 });
  late.link.deliver(stocPacket(YGOProStocDuelEnd));
  assert.equal(await late.seat.wait(), "ended");

  const closed = await setup(t, { replayGraceMs: 10_000 });
  await joinRoom(closed.seat, closed.link);
  await playDuel(closed.seat, closed.link, { winner: 0 });
  closed.link.deliver(stocPacket(YGOProStocDuelEnd));
  const waiting = closed.seat.wait();
  closed.link.serverClose();
  assert.equal(await waiting, "ended", "the server closing after DUEL_END ends the wait");
});

test("a disconnect mid-duel is a phase with a reason and an aborted line", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await startDuel(seat, link);
  const waiting = seat.wait();
  link.serverClose();
  assert.equal(await waiting, "disconnected");
  assert.equal(seat.snapshot().phase, "disconnected");
  assert.match(seat.snapshot().disconnect.reason, /server-closed/);
  await assert.rejects(seat.answer({ choose: [1] }), SeatError);
  assert.equal(await seat.wait(), "disconnected");
  await seat.close();
  const [line] = (await readFile(join(folder, "results.jsonl"), "utf8")).trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(line.type, "aborted");
  assert.equal(line.phase, "duel");
  assert.equal(line.reason, "server-closed");
});

test("a chat wake followed by match-end packets still waits for the run-folder writes", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await playDuel(seat, link, { winner: 0 });
  const pending = seat.wait();
  // Same TCP data callback: chat resolves the waiter, then match/replay packets
  // arrive before the tool's continuation runs. The recorder is real async I/O.
  link.deliver(stocPacket(YGOProStocChat, { player_type: 1, msg: "gg" }));
  link.deliver(stocPacket(YGOProStocDuelEnd));
  link.deliver(Buffer.from([4, 0, 23, 1, 2, 3]));
  await pending;
  assert.equal(seat.snapshot().phase, "ended");
  assert.match(await readFile(join(folder, "results.jsonl"), "utf8"), /"type":"match"/);
  assert.deepEqual([...await readFile(join(folder, "replay-1.yrp"))], [1, 2, 3]);
});

test("chat goes out unchanged; opponent lines wake a wait; server lines are tagged; own echoes are dropped", async (t) => {
  const { seat, link } = await setup(t);
  await joinRoom(seat, link);
  link.take();
  assert.deepEqual(seat.chat("gg\nwell played"), { sent: "gg\nwell played" });
  const [chat] = link.take();
  assert.ok(chat instanceof YGOProCtosChat);
  assert.equal(chat.msg, "gg\nwell played");
  link.deliver(stocPacket(YGOProStocChat, { player_type: 0, msg: "gg\nwell played" }));
  link.deliver(stocPacket(YGOProStocChat, { player_type: 8, msg: "[Server]: welcome" }));
  assert.deepEqual(lastEvent(seat), { ...lastEvent(seat), kind: "chat", from: "server", text: "[Server]: welcome" });
  const answered = seat.answer({ choose: [1] });
  await tick();
  link.take();
  link.deliver(stocPacket(YGOProStocChat, { player_type: 1, msg: "your move" }));
  assert.equal(await answered, "chat", "an opponent line wakes a waiting call");
  const chats = seat.snapshot().events.filter((event) => event.kind === "chat");
  assert.deepEqual(chats.map((event) => [event.from, event.text]), [["server", "[Server]: welcome"], ["opponent", "your move"]]);
});

test("unknown game messages become unreadable events; one blocking call at a time; surrender only in a duel", async (t) => {
  const { seat, link } = await setup(t);
  await joinRoom(seat, link);
  assert.throws(() => seat.surrender(), SeatError, "not in the duel phase yet");
  const first = seat.answer({ choose: [1] });
  await tick();
  await assert.rejects(seat.wait(), /already waiting/);
  await startDuel(seat, link);
  link.deliver(Buffer.from([3, 0, 1, 0xfe, 7]));
  assert.equal(lastEvent(seat).kind, "unreadable");
  assert.match(lastEvent(seat).text, /254/);
  link.deliver(idle(0));
  assert.equal(await first, "prompt");
  link.take();
  const surrendered = seat.surrender();
  await tick();
  assert.deepEqual(types(link.take()), [YGOProCtosSurrender]);
  link.deliver(gamePacket(YGOProMsgWin, { player: 1, type: 0 }));
  link.deliver(stocPacket(YGOProStocChangeSide));
  assert.equal(await surrendered, "prompt");
});
