import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Contract: docs/specs/remaining.md, rows E0-E6. Run alone with
// `node --test spec/seat-entry.test.js`: it stays RED until roadmap P1.9, and
// against today's probe baseline it joins and leaves the live 2339 server once.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEAT = join(ROOT, "src/bin/seat.js");
// Test-only baseline, not a runtime fallback: until the seat exists, spawn the
// current product executable so the RED is about MCP behavior, not a missing file.
const ENTRY = existsSync(SEAT) ? SEAT : join(ROOT, "src/bin/probe.js");
const LABEL = relative(ROOT, ENTRY);
const CARDS_DIR = join(ROOT, "data/cards");
const SERVER = { host: "koishi.momobako.com", port: "2339" };
const ROOM = `M,TM0,NF#sp${randomBytes(4).toString("hex")}`;
const NAME = `spec-${randomBytes(2).toString("hex")}`;
// architecture D-01: Codex and Gemini still open with the 2025-06-18 initialize.
const HANDSHAKE = "2025-06-18";
// Row E2 pinned the Phase 1 list; roadmap P2.1 added deck_show and deck_edit,
// giving the full contract order (contracts.md MCP Tools).
const PHASE1_TOOLS = ["wait", "answer", "deck_show", "deck_edit", "card", "card_search", "chat", "surrender"];
const MAX_RESULT_CHARS = 500000;
// Above the probe's worst case: two 8 s connects plus two 8 s join waits.
const INIT_MS = 45_000;
const CALL_MS = 10_000;
const SETUP_FAILURE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connect timeout|no STOC_JOIN_GAME|join rejected|rejected client version|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|npm run cards/;

test(`${LABEL} serves the Phase 1 MCP seat over stdio`, { timeout: 90_000 }, async (t) => {
  assert.ok(ROOM.length <= 19, `setup: room ${ROOM} exceeds 19 UTF-16 units`);
  if (ENTRY === SEAT) {
    for (const file of ["en-US/cards.cdb", "en-US/strings.conf"]) {
      assert.ok(existsSync(join(CARDS_DIR, file)),
        `BLOCKED, not RED: ${join(CARDS_DIR, file)} is missing; run npm run cards (roadmap P1.4) first`);
    }
  }
  const runDir = await mkdtemp(join(tmpdir(), "ygo-seat-entry-"));
  const child = observeChild(ENTRY);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: ROOT,
    stderr: "pipe",
    env: {
      YGO_HOST: SERVER.host, YGO_PORT: SERVER.port, YGO_ROOM: ROOM, YGO_NAME: NAME,
      YGO_CARDS_DIR: CARDS_DIR, YGO_RUN_DIR: runDir, YGO_WAIT_MS: "1000", YGO_LOG_LEVEL: "info",
    },
  });
  const stderr = collect(transport.stderr);
  const transportErrors = [];
  transport.onerror = (error) => transportErrors.push(error.message);
  const client = new Client({ name: "seat-entry-spec", version: "0.0.0" }, { supportedProtocolVersions: [HANDSHAKE] });
  t.after(async () => {
    child.stop();
    await client.close().catch(() => { });
    await transport.close().catch(() => { });
    child.kill();
    await rm(runDir, { recursive: true, force: true });
  });

  const initError = await client.connect(transport, { timeout: INIT_MS }).then(() => null, (error) => error);
  child.stop();
  if (initError) {
    await child.settled(3000);
    const evidence = { error: initError, exit: child.exit, stdout: child.stdout(), stderr: stderr(), transportErrors };
    const report = describe(evidence);
    assert.equal(setupFailure(evidence), null,
      `SETUP FAILURE, not the intended RED: ${LABEL} never got to the MCP question.\n${report}`);
    assert.ok(speaksAnotherProtocol(evidence),
      `NOT THE INTENDED RED: ${LABEL} failed initialize without the baseline signature (exit 0 after non-JSON-RPC stdout).\n${report}`);
    assert.fail(`RED: ${LABEL} does not answer MCP initialize (protocolVersion ${HANDSHAKE}); `
      + `it wrote non-JSON-RPC stdout and exited 0. Expected the stdio MCP seat of roadmap P1.9.\n${report}`);
  }

  // E2: the Phase 1 tool list, in contract order, each keeping large results inline.
  assert.ok(client.getServerCapabilities()?.tools, `${LABEL} must advertise the tools capability`);
  const { tools } = await client.listTools(undefined, { timeout: CALL_MS });
  assert.deepEqual(tools.map((tool) => tool.name), PHASE1_TOOLS);
  for (const tool of tools) {
    assert.equal(tool._meta?.["anthropic/maxResultSizeChars"], MAX_RESULT_CHARS,
      `${tool.name} must declare anthropic/maxResultSizeChars`);
  }

  // E3: before any submit the seat is in the deck phase of this room, holding the deck prompt.
  const view = await seatView(client);
  assert.equal(view.phase, "deck");
  assert.equal(view.room, ROOM);
  assert.equal(view.you?.name, NAME);
  assert.equal(view.opponent, null, "no lobby before the first deck submit (AD-04)");
  assert.equal(view.disconnected, null);
  assert.equal(view.prompt?.kind, "deck");
  assert.ok(Number.isInteger(view.prompt.seq) && view.prompt.seq >= 1, "prompt.seq is a positive integer");
  assert.ok(typeof view.next === "string" && view.next.length > 0, "next names the call to make");

  // E4, E5: seat-state errors are isError results that change nothing.
  await seatError(client, "answer", { choose: [1] }, "a deck prompt takes only submit");
  await seatError(client, "chat", { text: "hello" }, "chat before the seat connects");
  const again = await seatView(client);
  assert.equal(again.phase, "deck");
  assert.equal(again.opponent, null);
  assert.equal(again.prompt?.seq, view.prompt.seq, "the pending deck prompt survives rejected calls");

  // E6: nothing but the MCP transport writes to stdout.
  const stray = child.stdout().split("\n").filter((line) => line.trim() && !isJsonRpc(line));
  assert.deepEqual(stray, [], "every stdout line is JSON-RPC");
});

async function seatView(client) {
  const result = await client.callTool({ name: "wait", arguments: { format: "json" } }, { timeout: CALL_MS });
  assert.notEqual(result.isError, true, `wait returned isError: ${result.content?.[0]?.text}`);
  assert.equal(result.content?.length, 1, "a seat result is one text block");
  assert.equal(result.content[0].type, "text");
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return assert.fail(`wait {format: "json"} did not return JSON: ${result.content[0].text}`);
  }
}

async function seatError(client, name, args, why) {
  const result = await client.callTool({ name, arguments: args }, { timeout: CALL_MS });
  assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must return isError: ${why}`);
  assert.ok(result.content?.[0]?.type === "text" && result.content[0].text.trim(), `${name} error must say why`);
}

// Finds the child the SDK spawns through Node's public child_process channel,
// so stdout and the exit code can be read without SDK internals.
function observeChild(entry) {
  const chunks = [];
  let child = null;
  let exit = null;
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });
  const onCreate = ({ process: created }) => created.once("spawn", () => {
    if (child || !created.spawnargs.includes(entry)) return;
    child = created;
    created.stdout.on("data", (chunk) => chunks.push(chunk));
    created.once("exit", (code, signal) => {
      exit = { code, signal };
      markExited();
    });
  });
  subscribe("child_process", onCreate);
  return {
    get exit() { return exit; },
    stdout: () => Buffer.concat(chunks).toString("utf8"),
    settled: (ms) => Promise.race([exited, delay(ms, undefined, { ref: false })]),
    stop: () => unsubscribe("child_process", onCreate),
    kill: () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function collect(stream) {
  const chunks = [];
  stream?.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

function isJsonRpc(line) {
  try {
    return JSON.parse(line)?.jsonrpc === "2.0";
  } catch {
    return false;
  }
}

function setupFailure({ error, stderr }) {
  return `${error.code ?? ""} ${error.message}\n${stderr}`.match(SETUP_FAILURE)?.[0] ?? null;
}

function speaksAnotherProtocol({ exit, stdout }) {
  return exit?.code === 0 && stdout.trim().length > 0 && !stdout.split("\n").some(isJsonRpc);
}

function describe({ error, exit, stdout, stderr, transportErrors }) {
  return [
    `entry: ${ENTRY}`,
    `server: ${SERVER.host}:${SERVER.port} · room: ${ROOM} · name: ${NAME}`,
    `client error: ${error.code ?? error.name}: ${error.message}`,
    `child exit: ${exit ? `code ${exit.code}, signal ${exit.signal}` : "still running"}`,
    `transport errors: ${transportErrors.join(" | ") || "none"}`,
    `child stdout (${Buffer.byteLength(stdout)} bytes):\n${excerpt(stdout)}`,
    `child stderr:\n${excerpt(stderr)}`,
  ].join("\n");
}

function excerpt(text) {
  const limit = 3000;
  if (!text) return "(empty)";
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
}
