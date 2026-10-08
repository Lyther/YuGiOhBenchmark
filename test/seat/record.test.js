import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecorder, runFolder } from "../../src/seat/record.js";

async function runDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const fixedNow = () => new Date("2026-10-07T12:00:00.000Z");

test("the run folder is the sanitized room id and player name", () => {
  assert.equal(runFolder("/runs", "M,TM0,NF#abc123", "opus-seat"), join("/runs", "abc123", "opus-seat"));
  assert.match(runFolder("/runs", "M,TM0,NF#a/b c", "名前"), /^\/runs\/a_b_c-[0-9a-f]{8}\/__-[0-9a-f]{8}$/);
  assert.notEqual(runFolder("/runs", "r", "名前"), runFolder("/runs", "r", "名称"), "names that sanitize alike stay distinct");
  assert.match(runFolder("/runs", "M,TM0,NF#..", ".."), /^\/runs\/__-[0-9a-f]{8}\/__-[0-9a-f]{8}$/, "no path traversal");
  assert.equal(runFolder("/runs", "plainroom", "x"), join("/runs", "plainroom", "x"));
});

test("a run folder is claimed once, so a rerun or a colliding seat cannot mix into it", async (t) => {
  const dir = await runDir(t);
  const first = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" });
  first.claim();
  await first.result({ type: "duel", duel: 1 });
  const again = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" });
  assert.throws(() => again.claim(), /already exists.*fresh room id or another YGO_NAME/);
  assert.deepEqual(await readdir(join(dir, "abc123")), ["opus-seat"]);
});

test("results are appended as JSON lines and decks and replays are written once each", async (t) => {
  const dir = await runDir(t);
  const recorder = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat", now: fixedNow });
  await recorder.deck(1, "#main\n89631139\n#extra\n!side\n");
  await recorder.replay(Uint8Array.from([0x31, 0x70, 0x72, 0x79]));
  await recorder.replay(Uint8Array.from([1, 2, 3]));
  await recorder.result({ type: "duel", duel: 1, result: "win", reason: "LP reached 0", reasonCode: 1, turns: 7, first: true });
  await recorder.result({ type: "match", result: "win", score: { me: 1, opponent: 0, draws: 0 }, opponent: "gpt-seat" });
  const folder = join(dir, "abc123", "opus-seat");
  assert.deepEqual((await readdir(folder)).sort(), ["duel-1.ydk", "replay-1.yrp", "replay-2.yrp", "results.jsonl"]);
  assert.deepEqual([...await readFile(join(folder, "replay-1.yrp"))], [0x31, 0x70, 0x72, 0x79]);
  assert.equal(await readFile(join(folder, "duel-1.ydk"), "utf8"), "#main\n89631139\n#extra\n!side\n");
  const lines = (await readFile(join(folder, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], {
    type: "duel", room: "M,TM0,NF#abc123", duel: 1, result: "win", reason: "LP reached 0",
    reasonCode: 1, turns: 7, first: true, at: "2026-10-07T12:00:00.000Z",
  });
  assert.equal(lines[1].type, "match");
  assert.equal(lines[1].room, "M,TM0,NF#abc123");
  await assert.rejects(recorder.deck(1, "#main\n"), /exists/, "a written deck is never overwritten");
});

test("session capture stores each packet with its millisecond offset and full bytes", async (t) => {
  const dir = await runDir(t);
  let clock = 1000;
  const recorder = createRecorder({ runDir: dir, room: "M,TM0,NF#cap", name: "seat", capture: true, monotonic: () => clock });
  recorder.startCapture();
  clock = 1250;
  recorder.packet(Buffer.from([2, 0, 0x19, 7]));
  clock = 1300;
  recorder.packet(Buffer.from([1, 0, 0x20]));
  await recorder.close();
  const bytes = await readFile(join(dir, "cap", "seat", "session.bin"));
  assert.deepEqual([...bytes], [
    250, 0, 0, 0, 4, 0, 2, 0, 0x19, 7,
    44, 1, 0, 0, 3, 0, 1, 0, 0x20,
  ]);
});

test("without capture no session file is created", async (t) => {
  const dir = await runDir(t);
  const recorder = createRecorder({ runDir: dir, room: "M,TM0,NF#nocap", name: "seat" });
  recorder.startCapture();
  recorder.packet(Buffer.from([1, 0, 0x20]));
  await recorder.result({ type: "aborted", phase: "lobby", duel: 1, reason: "server-closed" });
  await recorder.close();
  assert.deepEqual(await readdir(join(dir, "nocap", "seat")), ["results.jsonl"]);
});
