import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRecorder } from "../../src/seat/record.js";

const STEER = fileURLToPath(new URL("../../src/bin/steer.js", import.meta.url));
const ROOM = "M,TM0,NF#abc123";
const NAME = "luna-seat";

async function runDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo-steer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the hook as Droid does: a process with the hook's JSON on stdin.
function hook(dir, toolName, args = [dir, ROOM, NAME]) {
  const input = typeof toolName === "string" ? JSON.stringify({ hook_event_name: "PostToolUse", tool_name: toolName, tool_input: {} }) : toolName.raw;
  const child = spawnSync(process.execPath, [STEER, ...args], { input, encoding: "utf8" });
  return { status: child.status, stderr: child.stderr, context: child.stdout ? JSON.parse(child.stdout).hookSpecificOutput : null };
}

test("the steer hook speaks after a non-seat tool only while the match runs", async (t) => {
  const dir = await runDir(t);
  assert.deepEqual(hook(dir, "Execute"), { status: 0, stderr: "", context: null }, "no seat folder yet: deck building");
  const record = createRecorder({ runDir: dir, room: ROOM, name: NAME });
  record.claim();
  assert.equal(hook(dir, "Execute").context, null, "joined, but no duel has started");
  await record.checkpoint({ started: true, duel: 1, turn: 3 });
  const steered = hook(dir, "Execute");
  assert.equal(steered.status, 0);
  assert.equal(steered.context.hookEventName, "PostToolUse");
  assert.match(steered.context.additionalContext, /^Execute ran outside the game: it did not act in your match, which is still running\. .*ygo___wait.*ygo___answer/);
  assert.match(hook(dir, "Skill").context.additionalContext, /^Skill ran outside the game/);
  for (const tool of ["ygo___answer", "mcp__ygo__wait", "ToolSearch"]) assert.equal(hook(dir, tool).context, null, tool);
  await record.result({ type: "duel", duel: 1, result: "win" });
  assert.match(hook(dir, "Execute").context.additionalContext, /still running/, "between duels the match still runs");
  await record.result({ type: "match", result: "win" });
  assert.equal(hook(dir, "Execute").context, null, "the match is over");
});

test("a steer hook call it cannot read exits 1 and blocks nothing", async (t) => {
  const dir = await runDir(t);
  const missing = hook(dir, "Execute", [dir, ROOM]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^usage: steer\.js <YGO_RUN_DIR> <YGO_ROOM> <YGO_NAME>/);
  const garbled = hook(dir, { raw: "not json" });
  assert.equal(garbled.status, 1);
  assert.match(garbled.stderr, /the hook input is not JSON/);
  assert.equal(garbled.context, null);
});
