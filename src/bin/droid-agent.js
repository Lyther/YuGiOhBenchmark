import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { readConfig } from "../config.js";
import { readProgress, runFolder } from "../seat/record.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SEAT = join(REPO, "src", "bin", "seat.js");
const STEER = join(REPO, "src", "bin", "steer.js");
const PROMPT = join(REPO, "prompts", "play-match.md");
const CARDS = join(REPO, "data", "cards");
// Droid's per-call limit for the seat, above its 240 s wait budget (README).
const CALL_TIMEOUT_MS = 300_000;
const HOOK_TIMEOUT_S = 10;
const LISTING_TIMEOUT_MS = 120_000;
const DEFAULT_SESSIONS = 8;
// Every tool but the seat's and the ToolSearch call that loads them.
const NON_SEAT_TOOLS = "^(?!ygo___|mcp__ygo__|ToolSearch$)";
const AUTH_FILES = ["auth.v2.file", "auth.v2.key", "auth.v2.keyring"];
const LABEL = /^[A-Za-z0-9._-]+$/;

export function shellQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

// The agent's private Droid home holds only these two files and the operator's
// login: the seat's MCP entry, and the steer hook pointed at the same seat.
export function droidConfig({ node, runDir, room, name, seatLog, deck, cardsDir = CARDS }) {
  const env = { YGO_ROOM: room, YGO_NAME: name, YGO_CARDS_DIR: cardsDir, YGO_RUN_DIR: runDir, YGO_CAPTURE: "1", ...(deck ? { YGO_DECK: deck } : {}) };
  const seat = `exec ${shellQuote(node)} ${shellQuote(SEAT)} 2>>${shellQuote(seatLog)}`;
  const steer = [node, STEER, runDir, room, name].map(shellQuote).join(" ");
  return {
    mcp: { mcpServers: { ygo: { type: "stdio", command: "/bin/sh", args: ["-c", seat], env, timeout: CALL_TIMEOUT_MS } } },
    hooks: { PostToolUse: [{ matcher: NON_SEAT_TOOLS, hooks: [{ type: "command", timeout: HOOK_TIMEOUT_S, command: steer }] }] },
  };
}

// The MCP servers named in `droid exec --list-tools` output.
export function mcpServers(listing) {
  return [...new Set([...listing.matchAll(/\[MCP\] ([^:\s]+):/g)].map((match) => match[1]))];
}

function linkExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeHome(factory, config, operatorFactory) {
  mkdirSync(factory, { recursive: true });
  writeFileSync(join(factory, "mcp.json"), `${JSON.stringify(config.mcp, null, 2)}\n`);
  writeFileSync(join(factory, "hooks.json"), `${JSON.stringify(config.hooks, null, 2)}\n`);
  // Linked, not copied: Droid writes a refreshed login through the link, so
  // the operator's own sessions keep a current one.
  const linked = AUTH_FILES.filter((file) => existsSync(join(operatorFactory, file)));
  for (const file of linked) {
    if (!linkExists(join(factory, file))) symlinkSync(join(operatorFactory, file), join(factory, file));
  }
  return linked;
}

function options() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" }, label: { type: "string" }, model: { type: "string" }, room: { type: "string" },
      name: { type: "string" }, effort: { type: "string" }, deck: { type: "string" }, sessions: { type: "string" }, prompt: { type: "string" },
    },
  });
  const missing = ["dir", "label", "model", "room"].filter((key) => !values[key]);
  if (missing.length) throw new Error(`missing --${missing.join(", --")}`);
  if (!LABEL.test(values.label)) throw new Error("--label takes letters, digits, '.', '_' and '-' only");
  const sessions = Number(values.sessions ?? DEFAULT_SESSIONS);
  if (!Number.isInteger(sessions) || sessions < 1) throw new Error("--sessions must be a positive integer");
  const name = values.name ?? `${values.label}-seat`;
  // The seat's own rules for the room and the name.
  readConfig({ YGO_ROOM: values.room, YGO_NAME: name }, { roomRequired: true });
  return { ...values, name, sessions, dir: resolve(values.dir), deck: values.deck && resolve(values.deck), prompt: resolve(values.prompt ?? PROMPT) };
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function runSession(args, { cwd, env, base }, onChild) {
  return new Promise((done) => {
    const child = spawn("droid", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    onChild(child);
    // Each stream line gets the epoch time it arrived, as the transcript tools expect.
    const out = createWriteStream(`${base}.jsonl`);
    let pending = "";
    const write = (line) => out.write(`${(Date.now() / 1000).toFixed(3)} ${line}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      lines.forEach(write);
    });
    child.stderr.pipe(createWriteStream(`${base}.stderr`));
    child.once("error", (error) => done(`not started: ${error.message}`));
    child.once("close", (code, signal) => {
      if (pending) write(pending);
      out.end();
      done(code ?? signal);
    });
  });
}

async function main() {
  const opts = options();
  const agentDir = join(opts.dir, opts.label);
  const logs = join(opts.dir, "logs");
  const home = join(opts.dir, `${opts.label}.droid-home`);
  const factory = join(home, ".factory");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const sessionsLog = join(logs, `${opts.label}-sessions.log`);
  const note = (line) => {
    process.stdout.write(`${stamp()} ${line}\n`);
    appendFileSync(sessionsLog, `${stamp()} ${line}\n`);
  };
  const config = droidConfig({
    node: process.execPath, runDir: agentDir, room: opts.room, name: opts.name, deck: opts.deck, seatLog: join(logs, `${opts.label}-seat.log`),
  });
  const operatorFactory = join(process.env.FACTORY_HOME_OVERRIDE || homedir(), ".factory");
  const linked = writeHome(factory, config, operatorFactory);
  if (!linked.length && !process.env.FACTORY_API_KEY) throw new Error(`no Droid login in ${operatorFactory}; log in to Droid or set FACTORY_API_KEY`);
  const env = { ...process.env, FACTORY_HOME_OVERRIDE: home };
  // FACTORY_HOME_OVERRIDE is undocumented, so check that it took: the agent
  // must see the seat and none of the operator's MCP servers.
  const listing = spawnSync("droid", ["exec", "-m", opts.model, "--list-tools"], { cwd: agentDir, env, encoding: "utf8", timeout: LISTING_TIMEOUT_MS });
  if (listing.error || listing.status !== 0) throw new Error(`droid exec --list-tools failed: ${listing.error?.message ?? listing.stderr.trim()}`);
  const servers = mcpServers(listing.stdout);
  if (servers.join() !== "ygo") throw new Error(`the agent would see MCP servers [${servers.join(", ")}], not only ygo; this Droid may not honor FACTORY_HOME_OVERRIDE`);

  const seatFolder = runFolder(agentDir, opts.room, opts.name);
  const args = ["exec", "-m", opts.model, ...(opts.effort ? ["-r", opts.effort] : []), "--auto", "high", "--add-tools", "MCP:ygo", "-o", "stream-json", readFileSync(opts.prompt, "utf8")];
  let child = null;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  }
  for (let session = 1; session <= opts.sessions && !stopping; session += 1) {
    if (readProgress(seatFolder)?.ended) break;
    note(`session ${session} starts`);
    const base = join(logs, `${opts.label}-${session}-${stamp().replace(/:/g, "")}`);
    const exit = await runSession(args, { cwd: agentDir, env, base }, (started) => { child = started; });
    child = null;
    note(`session ${session} ended (exit ${exit})`);
  }
  const ended = Boolean(readProgress(seatFolder)?.ended);
  note(ended ? "match end recorded; no more sessions" : stopping ? "stopped" : `no match end after ${opts.sessions} sessions`);
  process.exitCode = ended ? 0 : 1;
}

// argv[1] keeps any symlink in the launch path; import.meta.url is the real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`droid-agent: ${error.message}\n`);
    process.exitCode = 2;
  });
}
