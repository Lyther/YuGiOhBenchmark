import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
// A real process that has exited: the seat that left the folder is gone.
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid;

async function seatState(folder, fields) {
  const state = JSON.parse(await readFile(join(folder, "seat.json"), "utf8"));
  await writeFile(join(folder, "seat.json"), JSON.stringify({ ...state, ...fields }));
}

test("the run folder is the sanitized room id and player name", () => {
  assert.equal(runFolder("/runs", "M,TM0,NF#abc123", "opus-seat"), join("/runs", "abc123", "opus-seat"));
  assert.match(runFolder("/runs", "M,TM0,NF#a/b c", "名前"), /^\/runs\/a_b_c-[0-9a-f]{8}\/__-[0-9a-f]{8}$/);
  assert.notEqual(runFolder("/runs", "r", "名前"), runFolder("/runs", "r", "名称"), "names that sanitize alike stay distinct");
  assert.match(runFolder("/runs", "M,TM0,NF#..", ".."), /^\/runs\/__-[0-9a-f]{8}\/__-[0-9a-f]{8}$/, "no path traversal");
  assert.equal(runFolder("/runs", "plainroom", "x"), join("/runs", "plainroom", "x"));
});

test("a run folder is claimed once, so a colliding seat, a finished match or a foreign folder is refused", async (t) => {
  const dir = await runDir(t);
  const make = () => createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" });
  const first = make();
  assert.equal(first.claim(), null, "a new folder");
  await first.result({ type: "duel", duel: 1 });
  assert.throws(() => make().claim(), /belongs to seat process \d+, which is still running.*another YGO_NAME/);
  await first.result({ type: "match", result: "win" });
  await seatState(first.folder, { pid: DEAD_PID });
  assert.throws(() => make().claim(), /already holds a match that is over \(match\).*fresh room id/);
  await mkdir(join(dir, "abc123", "other-seat"));
  const foreign = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "other-seat" });
  assert.throws(() => foreign.claim(), /already exists and holds no seat state/);
  assert.deepEqual((await readdir(join(dir, "abc123"))).sort(), ["opus-seat", "other-seat"]);
});

test("a folder a stopped seat left mid-match is taken over with its progress", async (t) => {
  const dir = await runDir(t);
  const make = () => createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat", now: fixedNow });
  const first = make();
  first.claim();
  await first.deck(1, "#main\n89631139\n#extra\n!side\n");
  await first.checkpoint({ started: true, duel: 1, turn: 6 });
  await first.result({ type: "duel", duel: 1, result: "loss", reason: "LP reached 0", reasonCode: 1, turns: 6, first: true });
  await first.replay(Uint8Array.from([1]));
  await first.deck(2, "#main\n46986414\n#extra\n!side\n");
  await first.checkpoint({ duel: 2, turn: 3 });
  await first.result({ type: "interrupted", phase: "duel", duel: 2, turn: 3, reason: "stdin closed" });
  await first.close();
  await seatState(first.folder, { pid: DEAD_PID });
  const second = make();
  const found = second.claim();
  assert.deepEqual([found.started, found.duel, found.turn, found.replays], [true, 2, 3, 1]);
  assert.deepEqual(found.results.map((line) => [line.duel, line.result]), [[1, "loss"]]);
  assert.deepEqual([...found.decks.keys()].sort(), [1, 2]);
  assert.match(found.decks.get(1), /89631139/);
  assert.equal(JSON.parse(await readFile(join(second.folder, "seat.json"), "utf8")).pid, process.pid, "the new seat owns the folder");
  assert.equal(await second.replay(Uint8Array.from([2])), 2, "replays keep their numbering");
});

test("a folder left before any duel started is reused afresh", async (t) => {
  const dir = await runDir(t);
  const first = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" });
  first.claim();
  await first.deck(1, "#main\n89631139\n#extra\n!side\n");
  await first.close();
  await seatState(first.folder, { pid: DEAD_PID });
  const found = createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" }).claim();
  assert.equal(found.started, false);
  assert.equal(found.decks.size, 0);
  assert.deepEqual((await readdir(first.folder)).sort(), ["seat.json"], "the unplayed lobby deck is dropped");
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

test("a resumed seat cuts off a result line a hard stop left unfinished, so its own lines parse", async (t) => {
  const dir = await runDir(t);
  const make = () => createRecorder({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat", now: fixedNow });
  const first = make();
  first.claim();
  await first.checkpoint({ started: true, duel: 2 });
  await first.result({ type: "duel", duel: 1, result: "loss" });
  await first.close();
  await appendFile(join(first.folder, "results.jsonl"), '{"type":"duel","duel":2,"re');
  await seatState(first.folder, { pid: DEAD_PID });
  const second = make();
  assert.deepEqual(second.claim().results.map((line) => line.duel), [1]);
  await second.result({ type: "duel", duel: 2, result: "win" });
  const lines = (await readFile(join(second.folder, "results.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(lines.map((line) => JSON.parse(line).duel), [1, 2]);
});

test("a deck write cut short leaves no deck file for a resume to choke on", { skip: process.platform === "win32" && "needs ulimit" }, async (t) => {
  const dir = await runDir(t);
  const options = JSON.stringify({ runDir: dir, room: "M,TM0,NF#abc123", name: "opus-seat" });
  const script = `import { createRecorder } from ${JSON.stringify(new URL("../../src/seat/record.js", import.meta.url).href)};
await createRecorder(${options}).deck(1, "#main\\n89631139\\n#extra\\n!side\\n");`;
  // A zero file-size limit fails the write after the file is opened, as a hard stop there would.
  const child = spawnSync("/bin/sh", ["-c", 'ulimit -f 0; exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.match(child.stderr, /EFBIG/);
  assert.equal((await readdir(runFolder(dir, "M,TM0,NF#abc123", "opus-seat"))).includes("duel-1.ydk"), false);
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
