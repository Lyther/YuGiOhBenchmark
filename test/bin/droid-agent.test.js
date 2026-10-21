import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { droidConfig, mcpServers } from "../../src/bin/droid-agent.js";
import { createRecorder } from "../../src/seat/record.js";

// A space in every path, so the generated shell commands must quote them.
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the agent's Droid home names only the seat and the steer hook", () => {
  const config = droidConfig({ node: "/opt/node", runDir: "/m/luna", room: "M,TM0,NF#m1", name: "luna-seat", seatLog: "/m/logs/luna-seat.log", deck: "/d/x.ydk" });
  assert.deepEqual(Object.keys(config.mcp.mcpServers), ["ygo"]);
  const seat = config.mcp.mcpServers.ygo;
  assert.equal(seat.command, "/bin/sh");
  assert.equal(seat.timeout, 300_000);
  assert.match(seat.env.YGO_CARDS_DIR, /\/data\/cards$/);
  assert.deepEqual({ ...seat.env, YGO_CARDS_DIR: "-" }, {
    YGO_ROOM: "M,TM0,NF#m1", YGO_NAME: "luna-seat", YGO_CARDS_DIR: "-", YGO_RUN_DIR: "/m/luna", YGO_CAPTURE: "1", YGO_DECK: "/d/x.ydk",
  });
  assert.deepEqual(Object.keys(config.hooks), ["PostToolUse"]);
  const matcher = new RegExp(config.hooks.PostToolUse[0].matcher);
  for (const tool of ["Execute", "Skill", "Read", "WebSearch"]) assert.ok(matcher.test(tool), tool);
  for (const tool of ["ygo___answer", "mcp__ygo__wait", "ToolSearch"]) assert.ok(!matcher.test(tool), tool);
});

test("the hook command reaches the seat's folder through a shell, quotes and spaces included", async (t) => {
  const dir = await scratch(t);
  const room = "M,TM0,NF#it's 1";
  const name = "luna 'seat'";
  const record = createRecorder({ runDir: dir, room, name });
  record.claim();
  await record.checkpoint({ started: true, duel: 1, turn: 1 });
  await record.close();
  const { hooks } = droidConfig({ node: process.execPath, runDir: dir, room, name, seatLog: join(dir, "seat.log") });
  const run = spawnSync("/bin/sh", ["-c", hooks.PostToolUse[0].hooks[0].command], { input: JSON.stringify({ tool_name: "Execute" }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /^Execute ran outside the game/);
});

test("the seat command starts the seat with its stderr appended to the seat log", async (t) => {
  const dir = await scratch(t);
  await mkdir(join(dir, "logs"));
  const seatLog = join(dir, "logs", "luna seat.log");
  const { mcp } = droidConfig({ node: process.execPath, runDir: dir, room: "M,TM0,NF#m1", name: "a", seatLog, cardsDir: join(dir, "no cards") });
  const seat = mcp.mcpServers.ygo;
  const run = spawnSync(seat.command, seat.args, { env: { ...process.env, ...seat.env }, input: "", encoding: "utf8", timeout: 30_000 });
  // Without card data the seat stops at once and says why, in its own log.
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "");
  assert.match(await readFile(seatLog, "utf8"), /seat failed to start/);
});

test("the tool listing check names every MCP server", () => {
  const listing = [
    "MCP",
    "  • ygo___answer ([MCP] ygo:answer) - status: allowed",
    "  • synapse___memory_get ([MCP] synapse:memory_get) - status: allowed",
    "  • ygo___wait ([MCP] ygo:wait) - status: allowed",
    "  • Read - status: allowed",
  ].join("\n");
  assert.deepEqual(mcpServers(listing), ["ygo", "synapse"]);
  assert.deepEqual(mcpServers("  • Read - status: allowed"), []);
});
