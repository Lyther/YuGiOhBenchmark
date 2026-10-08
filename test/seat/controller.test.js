import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";

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
  YGOProCtosLeaveGame,
  YGOProCtosPlayerInfo,
  YGOProCtosResponse,
  YGOProCtosSurrender,
  YGOProCtosTimeConfirm,
  YGOProCtosTpResult,
  YGOProCtosUpdateDeck,
  YGOProMsgDraw,
  YGOProMsgHint,
  YGOProMsgMatchKill,
  YGOProMsgNewTurn,
  YGOProMsgReloadField,
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
const OBSERVER = 7;

async function setup(t, overrides = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "ygo-seat-"));
  const link = createLink();
  const record = createRecorder({ runDir, room: ROOM, name: NAME });
  const config = { host: "koishi.example", port: 2339, name: NAME, room: ROOM, version: 0x1362, waitMs: 2000, ...overrides.config };
  const seat = createSeat({
    config, catalog, deck: DECK, record, connect: link.connect, log,
    replayGraceMs: overrides.replayGraceMs ?? 40, rejoinBaseMs: overrides.rejoinBaseMs ?? 1, random: () => 0.5,
    restoreMs: overrides.restoreMs ?? 15_000,
  });
  // Closing flushes the run folder's queued writes before it is removed.
  t.after(async () => {
    await seat.close();
    await rm(runDir, { recursive: true, force: true });
  });
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
  assert.deepEqual((await readdir(folder)).sort(), ["duel-1.ydk", "duel-2.ydk", "replay-1.yrp", "replay-2.yrp", "results.jsonl", "seat.json"]);
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
  // The seat's timers are unref'd. A live socket keeps the process running
  // meanwhile; the link double does not, and Node 22 would cancel the test.
  const [lateReason] = await Promise.all([late.seat.wait(), delay(200)]);
  assert.equal(lateReason, "ended");

  const closed = await setup(t, { replayGraceMs: 10_000 });
  await joinRoom(closed.seat, closed.link);
  await playDuel(closed.seat, closed.link, { winner: 0 });
  closed.link.deliver(stocPacket(YGOProStocDuelEnd));
  const waiting = closed.seat.wait();
  closed.link.serverClose();
  assert.equal(await waiting, "ended", "the server closing after DUEL_END ends the wait");
});

async function results(folder) {
  return (await readFile(join(folder, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("an opponent who leaves while we side forfeits the match, read in lobby positions", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await playDuel(seat, link, { winner: 0, me: 1 });
  link.deliver(stocPacket(YGOProStocChangeSide));
  assert.equal(await seat.wait(), "prompt");
  // single_duel.cpp LeaveGame while siding: DUEL_START to the unready seat,
  // then MSG_WIN for 1 - (leaver's lobby position 1), which is our position 0.
  link.deliver(stocPacket(YGOProStocDuelStart));
  link.deliver(gamePacket(YGOProMsgWin, { player: 0, type: 4 }));
  link.deliver(stocPacket(YGOProStocDuelEnd));
  link.deliver(Buffer.from([4, 0, 23, 1, 2, 3]));
  assert.equal(await seat.wait(), "ended");
  await seat.close();
  const lines = await results(folder);
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "loss"], ["match", "win"]]);
  assert.deepEqual(lines[1].score, { me: 0, opponent: 1, draws: 0 });
  assert.equal(lines[1].forfeit, true);
  assert.deepEqual((await readdir(folder)).filter((file) => file.endsWith(".ydk")), ["duel-1.ydk"], "no deck for a duel never submitted");
});

test("an opponent who disconnects mid-duel forfeits the match even when it led", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await playDuel(seat, link, { winner: 1 });
  link.deliver(stocPacket(YGOProStocChangeSide));
  await seat.wait();
  const side = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocDuelStart));
  await startDuel(seat, link, 0);
  link.deliver(gamePacket(YGOProMsgWin, { player: 0, type: 4 }));
  link.deliver(stocPacket(YGOProStocDuelEnd));
  link.deliver(Buffer.from([4, 0, 23, 1]));
  link.deliver(Buffer.from([4, 0, 23, 2]));
  assert.equal(await side, "ended");
  await seat.close();
  const lines = await results(folder);
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "loss"], ["duel", "win"], ["match", "win"]]);
  assert.equal(lines[1].reason, "Lost connection");
  assert.equal(lines[2].forfeit, true);
});

test("a match-winning card effect gives the match to that duel's winner, whatever the score", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await playDuel(seat, link, { winner: 1 });
  link.deliver(stocPacket(YGOProStocChangeSide));
  await seat.wait();
  const side = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocDuelStart));
  await startDuel(seat, link, 0);
  // single_duel.cpp: MSG_MATCH_KILL sets match_kill, so DuelEndProc ends the
  // match at 1-1; srvpro gives that duel's winner the match.
  link.deliver(gamePacket(YGOProMsgMatchKill, { code: BLUE_EYES }));
  link.deliver(gamePacket(YGOProMsgWin, { player: 0, type: 1 }));
  link.deliver(stocPacket(YGOProStocDuelEnd));
  link.deliver(Buffer.from([4, 0, 23, 1]));
  link.deliver(Buffer.from([4, 0, 23, 2]));
  assert.equal(await side, "ended");
  await seat.close();
  const lines = await results(folder);
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "loss"], ["duel", "win"], ["match", "win"]]);
  assert.deepEqual(lines[2].score, { me: 1, opponent: 1, draws: 0 });
  assert.equal(lines[2].matchKill, true);
  assert.equal(lines[2].forfeit, undefined);
  assert.match(lastEvent(seat).text, /win by a match-winning effect, 1-1/);
});

test("an opponent name with control characters is kept on one line", async (t) => {
  const { seat, link } = await setup(t);
  const pending = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  link.deliver(stocPacket(YGOProStocTypeChange, { type: 0x10 | 0 }));
  link.deliver(stocPacket(YGOProStocHsPlayerEnter, { name: "evil\nNext: stop", pos: 1 }));
  link.deliver(stocPacket(YGOProStocSelectHand));
  await pending;
  assert.equal(seat.snapshot().opponent, "evil Next: stop");
  assert.ok(seat.snapshot().events.every((event) => !/[\r\n]/.test(event.text)));
});

test("a submit into an existing run folder is refused before anything is sent", async (t) => {
  const { seat, link, folder } = await setup(t);
  await mkdir(folder, { recursive: true });
  await assert.rejects(seat.answer({ submit: true }), (error) => error instanceof SeatError && /already exists/.test(error.message));
  assert.equal(link.connects.length, 0);
  assert.equal(seat.snapshot().phase, "deck");
  assert.equal(seat.snapshot().prompt.kind, "deck", "the deck prompt stays open");
});

test("a lost connection is rejoined with backoff; only when every attempt fails is the match aborted", async (t) => {
  const { seat, link, folder } = await setup(t, { rejoinBaseMs: 1 });
  await joinRoom(seat, link);
  await startDuel(seat, link);
  link.take();
  const waiting = seat.wait();
  link.serverClose();
  assert.equal(seat.snapshot().waiting, "rejoin");
  await assert.rejects(seat.answer({ choose: [1] }), SeatError);
  assert.throws(() => seat.chat("still there?"), /rejoining/);
  // Each attempt reaches a socket that the server closes again at once.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await delay(40);
    assert.equal(link.connects.length, 1 + attempt, `attempt ${attempt} connects`);
    assert.deepEqual(types(link.take()), [YGOProCtosPlayerInfo, YGOProCtosJoinGame]);
    link.serverClose();
  }
  assert.equal(await waiting, "disconnected");
  assert.match(seat.snapshot().disconnect.reason, /could not rejoin after 6 attempts \(first: server-closed/);
  await seat.close();
  const lines = await results(folder);
  assert.deepEqual(lines.map((line) => [line.type, line.phase]), [["aborted", "duel"]]);
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

// srvpro's answer to a recognized rejoin mid-duel, as captured live in
// fixtures/sessions/rejoin-a-2.bin: an empty-deck MSG_START and the field.
function rejoinMidDuel(link, { lp, deck }) {
  const slots = (count) => Array.from({ length: count }, () => ({ occupied: 0 }));
  const player = (life, deckCount) => ({
    lp: life, mzone: slots(7), szone: slots(8), deckCount, handCount: 5, graveCount: 0, removedCount: 0, extraCount: 1, extraPCount: 0,
  });
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  link.deliver(stocPacket(YGOProStocTypeChange, { type: 0x10 | 0 }));
  link.deliver(stocPacket(YGOProStocHsPlayerEnter, { name: "gpt-seat", pos: 1 }));
  link.deliver(stocPacket(YGOProStocDuelStart));
  link.deliver(gamePacket(YGOProMsgStart, {
    playerType: 0, duelRule: 5, startLp0: 8000, startLp1: 8000,
    player0: { deckCount: 0, extraCount: 0 }, player1: { deckCount: 0, extraCount: 0 },
  }));
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 1 }));
  link.deliver(gamePacket(YGOProMsgReloadField, { duelRule: 5, players: [player(lp, deck), player(8000, 34)], chains: [] }));
}

test("a packet the seat cannot handle reloads the duel through a rejoin and changes no score", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await startDuel(seat, link);
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 0 }));
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 1 }));
  link.take();
  // A two-player room has no playerType 2: building the board throws (H-2).
  link.deliver(gamePacket(YGOProMsgStart, {
    playerType: 2, duelRule: 5, startLp0: 8000, startLp1: 8000,
    player0: { deckCount: 35, extraCount: 1 }, player1: { deckCount: 35, extraCount: 1 },
  }));
  const [fault, rejoining] = seat.snapshot().events.slice(-2);
  assert.equal(fault.kind, "unreadable");
  assert.match(fault.text, /could not handle server packet 1/);
  assert.match(rejoining.text, /rejoining the match/);
  assert.equal(seat.snapshot().match.duel, 1, "the failed MSG_START counted no duel");
  await delay(20);
  assert.equal(link.connects.length, 2);
  link.take();
  rejoinMidDuel(link, { lp: 5200, deck: 33 });
  const sent = link.take();
  assert.deepEqual(types(sent), [YGOProCtosUpdateDeck], "the lobby deck again, and no READY");
  assert.deepEqual([...sent[0].deck.main, ...sent[0].deck.extra], [...DECK.main, ...DECK.extra]);
  const { board, match, waiting } = seat.snapshot();
  assert.deepEqual([match.duel, board.duel, board.turn, waiting], [1, 1, 2, null], "same duel, the seat's own turn count");
  assert.deepEqual(board.lp, { me: 5200, opponent: 8000 });
  assert.equal(board.sides.me.deck, 33);
  assert.equal(seat.snapshot().opponent, "gpt-seat");
  link.deliver(idle(0));
  assert.equal(await seat.wait(), "prompt");

  // An unknown game message is a fault too. After two reloads in one duel the
  // seat keeps playing on what it has instead of rejoining again.
  link.deliver(Buffer.from([3, 0, 1, 0xfe, 7]));
  assert.match(seat.snapshot().events.at(-2).text, /unknown game message 254/);
  await delay(20);
  assert.equal(link.connects.length, 3);
  rejoinMidDuel(link, { lp: 5200, deck: 33 });
  link.deliver(Buffer.from([3, 0, 1, 0xfe, 7]));
  assert.match(lastEvent(seat).text, /stops reloading it/);
  await delay(20);
  assert.equal(link.connects.length, 3);
  assert.deepEqual(seat.snapshot().match.score, { me: 0, opponent: 0, draws: 0 });
  assert.equal(await readFile(join(folder, "results.jsonl"), "utf8").catch(() => ""), "", "a fault writes no result");
});

test("a rejoin the server refuses (seated as an observer, or a different deck) is aborted with the reason", async (t) => {
  for (const [refusal, reason] of [
    [(link) => link.deliver(stocPacket(YGOProStocTypeChange, { type: OBSERVER })), /seated this seat as an observer/],
    [(link) => link.deliver(stocPacket(YGOProStocErrorMsg, { msg: ErrorMessageType.DECKERROR, code: 0 })), /deck differs/],
    [() => delay(60), /did not restore the match within 15 s/],
  ]) {
    const { seat, link, folder } = await setup(t, { restoreMs: 30 });
    await joinRoom(seat, link);
    await startDuel(seat, link);
    link.serverClose();
    await delay(20);
    link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
    await refusal(link);
    assert.equal(seat.snapshot().phase, "disconnected");
    assert.match(seat.snapshot().disconnect.reason, reason);
    assert.equal(link.open, false, "the refused connection is closed");
    await delay(20);
    assert.equal(link.connects.length, 2, "a refusal is final");
    assert.deepEqual((await results(folder)).map((line) => line.type), ["aborted"]);
  }
});

test("a restarted seat resumes the interrupted match in its folder with the deck the match started with", async (t) => {
  const first = await setup(t);
  await joinRoom(first.seat, first.link);
  await playDuel(first.seat, first.link, { winner: 1 });
  first.link.deliver(stocPacket(YGOProStocChangeSide));
  await first.seat.wait();
  // Sided: one Blue-Eyes swapped for the Side Deck card, so duel 2's deck differs.
  first.seat.setDeck({ main: [14558127, 89631139, 46986414], extra: [84013237], side: [89631139] });
  const side = first.seat.answer({ submit: true });
  await tick();
  first.link.deliver(stocPacket(YGOProStocDuelStart));
  await startDuel(first.seat, first.link, 0);
  for (const player of [0, 1, 0]) first.link.deliver(gamePacket(YGOProMsgNewTurn, { player }));
  await first.seat.close("stdin closed");
  assert.equal(await side, "disconnected");
  // The stopped seat's process is gone: a real pid that has exited.
  const state = JSON.parse(await readFile(join(first.folder, "seat.json"), "utf8"));
  assert.deepEqual([state.started, state.duel, state.turn], [true, 2, 3]);
  await writeFile(join(first.folder, "seat.json"), JSON.stringify({ ...state, pid: spawnSync(process.execPath, ["-e", ""]).pid }));

  const link = createLink();
  const record = createRecorder({ runDir: dirname(dirname(first.folder)), room: ROOM, name: NAME });
  const seat = createSeat({
    config: { host: "koishi.example", port: 2339, name: NAME, room: ROOM, version: 0x1362, waitMs: 2000 },
    catalog, deck: { main: [BLUE_EYES], extra: [], side: [] }, record, connect: link.connect, log, rejoinBaseMs: 1, random: () => 0.5,
  });
  t.after(() => seat.close());
  assert.match(seat.snapshot().prompt.text, /interrupted match \(1 duels finished\)/);
  const pending = seat.answer({ submit: true });
  await tick();
  assert.deepEqual(types(link.take()), [YGOProCtosPlayerInfo, YGOProCtosJoinGame]);
  rejoinMidDuel(link, { lp: 6100, deck: 30 });
  const sent = link.take();
  assert.deepEqual(types(sent), [YGOProCtosUpdateDeck], "no READY");
  assert.deepEqual([...sent[0].deck.main, ...sent[0].deck.extra], [...DECK.main, ...DECK.extra], "duel-1.ydk, not the new process's deck");
  link.deliver(idle(0));
  assert.equal(await pending, "prompt");
  const { match, board, opponent } = seat.snapshot();
  assert.deepEqual([match.duel, board.duel, board.turn, board.lp.me, opponent], [2, 2, 3, 6100, "gpt-seat"]);
  assert.deepEqual(seat.snapshot().deck.side, [89631139], "the working deck is the one last submitted");
  assert.deepEqual(match.score, { me: 0, opponent: 1, draws: 0 });
  const surrendered = seat.surrender();
  await tick();
  link.deliver(gamePacket(YGOProMsgWin, { player: 1, type: 0 }));
  link.deliver(stocPacket(YGOProStocDuelEnd));
  link.deliver(Buffer.from([4, 0, 23, 1]));
  link.deliver(Buffer.from([4, 0, 23, 2]));
  assert.equal(await surrendered, "ended");
  await seat.close();
  const lines = await results(first.folder);
  assert.deepEqual(lines.map((line) => [line.type, line.result ?? line.phase]), [["duel", "loss"], ["interrupted", "duel"], ["duel", "loss"], ["match", "loss"]]);
  assert.deepEqual(lines[3].score, { me: 0, opponent: 2, draws: 0 });
  assert.deepEqual((await readdir(first.folder)).sort(), ["duel-1.ydk", "duel-2.ydk", "replay-1.yrp", "replay-2.yrp", "results.jsonl", "seat.json"]);
  assert.ok(seat.snapshot().events.every((event) => !/Could not write/.test(event.text)), "no file was written twice");
});

test("a seat stopped mid-match does not leave it: srvpro keeps the seat for a resume", async (t) => {
  const { seat, link, folder } = await setup(t);
  await joinRoom(seat, link);
  await startDuel(seat, link);
  link.deliver(gamePacket(YGOProMsgNewTurn, { player: 0 }));
  link.take();
  await seat.close("stdin closed");
  assert.deepEqual(link.take(), [], "LEAVE_GAME would forfeit a match the server still holds");
  assert.equal(link.open, false);
  const lines = await results(folder);
  assert.deepEqual(lines.map(({ type, phase, duel, turn, reason }) => [type, phase, duel, turn, reason]), [["interrupted", "duel", 1, 1, "stdin closed"]]);
});

test("before the first duel a lost connection joins afresh, and a stopped seat leaves the room", async (t) => {
  const { seat, link, folder } = await setup(t);
  const pending = seat.answer({ submit: true });
  await tick();
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  link.deliver(stocPacket(YGOProStocTypeChange, { type: 0x10 | 0 }));
  link.take();
  link.serverClose();
  await delay(20);
  assert.equal(link.connects.length, 2);
  link.deliver(stocPacket(YGOProStocJoinGame, { info: HOST_INFO }));
  assert.deepEqual(types(link.take()), [YGOProCtosPlayerInfo, YGOProCtosJoinGame, YGOProCtosUpdateDeck, YGOProCtosHsReady]);
  assert.equal(seat.snapshot().waiting, null);
  await seat.close();
  assert.equal(await pending, "disconnected");
  assert.deepEqual(types(link.take()), [YGOProCtosLeaveGame]);
  assert.equal(await readFile(join(folder, "results.jsonl"), "utf8").catch(() => ""), "");
});

test("one blocking call at a time; surrender only in a duel", async (t) => {
  const { seat, link } = await setup(t);
  await joinRoom(seat, link);
  assert.throws(() => seat.surrender(), SeatError, "not in the duel phase yet");
  const first = seat.answer({ choose: [1] });
  await tick();
  await assert.rejects(seat.wait(), /already waiting/);
  await startDuel(seat, link);
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
