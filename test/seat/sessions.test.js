import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";

import { YGOProStocGameMsg, YGOProStocReplay } from "ygopro-msg-encode";

import { parseDeck } from "../../src/deck/deck.js";
import { createLogger } from "../../src/log.js";
import { parseServerPacket } from "../../src/protocol/packets.js";
import { createSeat } from "../../src/seat/controller.js";
import { createRecorder } from "../../src/seat/record.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { createLink } from "../helpers/link.js";

const catalog = await fixtureCatalog();
const ROOM = "M,TM0,NF#smc1c37f09";

async function records(name) {
  const bytes = await readFile(new URL(`../fixtures/sessions/${name}.bin`, import.meta.url));
  const packets = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt16LE(offset + 4);
    packets.push({ ms: bytes.readUInt32LE(offset), packet: bytes.subarray(offset + 6, offset + 6 + length) });
    offset += 6 + length;
  }
  return packets;
}

// The smoke run's answers: fixed lobby answers, surrender at a duel prompt.
function act(seat, label) {
  const { prompt, phase } = seat.snapshot();
  if (!prompt) return null;
  if (prompt.kind === "deck" || prompt.kind === "side") return seat.answer({ submit: true });
  if (prompt.kind === "rps") return seat.answer({ choose: [label === "a" ? 1 : 3] });
  if (prompt.kind === "first") return seat.answer({ choose: [1] });
  return phase === "duel" ? seat.surrender() : null;
}

async function replay(t, label) {
  const runDir = await mkdtemp(join(tmpdir(), "ygo-session-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const link = createLink();
  const record = createRecorder({ runDir, room: ROOM, name: `smoke-${label}` });
  const seat = createSeat({
    config: { host: "koishi.momobako.com", port: 2339, name: `smoke-${label}`, room: ROOM, version: 0x1362, waitMs: 2000 },
    catalog, deck: { main: [89631139], extra: [], side: [] }, record, connect: link.connect, log: createLogger("silent"),
  });
  let pending = act(seat, label);
  await tick();
  for (const { packet } of await records(`smoke-${label}`)) {
    link.deliver(packet);
    if (seat.snapshot().prompt && pending) {
      await pending;
      pending = null;
    }
    pending ??= act(seat, label);
    await tick();
  }
  assert.equal(await (pending ?? seat.wait()), "ended");
  return { seat, link, folder: record.folder };
}

test("every packet of both captured smoke sessions parses with the codec", async () => {
  for (const name of ["smoke-a", "smoke-b"]) {
    const packets = await records(name);
    assert.ok(packets.length > 100, `${name} has ${packets.length} packets`);
    let replays = 0;
    for (const { packet } of packets) {
      const { message } = parseServerPacket(packet);
      assert.notEqual(message.kind, "unknown", `${name}: unknown STOC id ${packet[2]}`);
      if (message instanceof YGOProStocGameMsg) assert.ok(message.msg, `${name}: unknown game message ${packet[3]}`);
      if (message instanceof YGOProStocReplay) replays += 1;
    }
    assert.equal(replays, 2);
  }
});

test("replaying seat b's capture reproduces the live match: lost 0-2, folder complete", async (t) => {
  const { seat, link, folder } = await replay(t, "b");
  const state = seat.snapshot();
  assert.equal(state.phase, "ended");
  assert.deepEqual(state.match.score, { me: 0, opponent: 2, draws: 0 });
  assert.equal(state.opponent, "smoke-a-2c16");
  const kinds = link.sent.map((packet) => packet.constructor.name);
  assert.equal(kinds.filter((kind) => kind === "YGOProCtosSurrender").length, 2);
  assert.equal(kinds.filter((kind) => kind === "YGOProCtosTpResult").length, 2, "b chose first after RPS and after losing duel 1");
  const server = state.events.filter((event) => event.kind === "chat" && event.from === "server").map((event) => event.text);
  assert.ok(server.some((line) => line.includes("3分钟")), "the server's side-deck timer reaches the model");
  assert.ok(state.events.some((event) => event.kind === "chat" && event.from === "opponent" && event.text === "smoke a: hello"));
  const lines = (await readFile(join(folder, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "loss"], ["duel", "loss"], ["match", "loss"]]);
  assert.equal(lines[0].reason, "Surrendered");
  assert.deepEqual((await readdir(folder)).filter((file) => file.endsWith(".yrp")).sort(), ["replay-1.yrp", "replay-2.yrp"]);
  await seat.close();
});

test("replaying seat a's capture reproduces the live match: won 2-0 without a single prompt in a duel", async (t) => {
  const { seat, link } = await replay(t, "a");
  assert.deepEqual(seat.snapshot().match.score, { me: 2, opponent: 0, draws: 0 });
  assert.equal(link.sent.filter((packet) => packet.constructor.name === "YGOProCtosSurrender").length, 0);
  assert.equal(seat.snapshot().board.duel, 2);
  await seat.close();
});

// The live rejoin probe on 2026-10-08 (fixtures/sessions/README.md): seat a's
// lobby answers, then a duel prompt is held (dropped) or surrendered.
function probeAct(seat, { duel, side }) {
  const { prompt } = seat.snapshot();
  if (!prompt) return null;
  if (prompt.kind === "deck") return seat.answer({ submit: true });
  if (prompt.kind === "side") return side === "submit" ? seat.answer({ submit: true }) : null;
  if (prompt.kind === "rps" || prompt.kind === "first") return seat.answer({ choose: [1] });
  return duel === "surrender" ? seat.surrender() : null;
}

async function feed(seat, link, name, plan) {
  let pending = probeAct(seat, plan);
  await tick();
  for (const { packet } of await records(name)) {
    link.deliver(packet);
    if (seat.snapshot().prompt && pending) {
      await pending;
      pending = null;
    }
    pending ??= probeAct(seat, plan);
    await tick();
  }
  return pending;
}

test("replaying a live rejoin: the seat comes back mid-duel and while siding, and finishes the match", async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), "ygo-rejoin-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const room = "M,TM0,NF#rc03a2fb92";
  const deck = parseDeck(await readFile(new URL("../../decks/sample.ydk", import.meta.url), "utf8"));
  const link = createLink();
  const record = createRecorder({ runDir, room, name: "rc-a-733d" });
  const seat = createSeat({
    config: { host: "koishi.momobako.com", port: 2339, name: "rc-a-733d", room, version: 0x1362, waitMs: 2000 },
    catalog, deck, record, connect: link.connect, log: createLogger("silent"), rejoinBaseMs: 1, random: () => 0.5,
  });
  const kinds = () => link.take().map((packet) => packet.constructor.name);
  await feed(seat, link, "rejoin-a-1", { duel: "hold" });
  assert.equal(seat.snapshot().prompt.kind, "command", "the first duel prompt is pending when the link drops");
  kinds();
  link.serverClose();
  await delay(20);
  await feed(seat, link, "rejoin-a-2", { duel: "surrender", side: "hold" });
  assert.deepEqual(kinds(), ["YGOProCtosPlayerInfo", "YGOProCtosJoinGame", "YGOProCtosUpdateDeck", "YGOProCtosSurrender"]);
  const { board } = seat.snapshot();
  assert.deepEqual([board.duel, board.turn, board.lp.me, board.lp.opponent, board.sides.me.deck], [1, 1, 8000, 8000, 35]);
  assert.ok(board.sides.me.hand.every((card) => card.code), "the reload's queries named every card in hand");
  assert.equal(seat.snapshot().prompt.kind, "side");
  link.serverClose();
  await delay(20);
  const last = await feed(seat, link, "rejoin-a-3", { duel: "surrender", side: "submit" });
  assert.equal(await last, "ended");
  assert.equal(link.connects.length, 3);
  assert.deepEqual(kinds(), ["YGOProCtosPlayerInfo", "YGOProCtosJoinGame", "YGOProCtosUpdateDeck", "YGOProCtosUpdateDeck",
    "YGOProCtosTpResult", "YGOProCtosSurrender"], "the lobby deck to rejoin, then the side deck; never READY");
  const texts = seat.snapshot().events.map((event) => event.text);
  for (const pattern of [/Lost the connection \(server-closed\); rejoining/, /Back in the match/, /Duel 1 continues from the server's copy/]) {
    assert.ok(texts.some((text) => pattern.test(text)), String(pattern));
  }
  const lines = (await readFile(join(record.folder, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.type, line.result]), [["duel", "loss"], ["duel", "loss"], ["match", "loss"]]);
  assert.deepEqual((await readdir(record.folder)).sort(), ["duel-1.ydk", "duel-2.ydk", "replay-1.yrp", "replay-2.yrp", "results.jsonl", "seat.json"]);
  await seat.close();
});
