import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { readConfig } from "../config.js";
import { runFolder } from "../seat/record.js";

const SEAT = fileURLToPath(new URL("./seat.js", import.meta.url));
const DEFAULT_DECK = fileURLToPath(new URL("../../decks/sample.ydk", import.meta.url));
const CALL_TIMEOUT_MS = 90_000;
const SEAT_WAIT_MS = "20000";
const DEADLINE_MS = 10 * 60_000;
const LOBBY_PROMPTS = new Set(["deck", "side", "rps", "first"]);
// Different hands, so rock-paper-scissors never ties.
const HANDS = Object.freeze({ a: 1, b: 3 });

function say(line) {
  process.stdout.write(`${line}\n`);
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: { ...args, ...(name === "chat" ? {} : { format: "json" }) } }, { timeout: CALL_TIMEOUT_MS });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return name === "chat" ? text : JSON.parse(text);
}

async function startSeat(label, { room, name, deck }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SEAT],
    env: { ...process.env, YGO_ROOM: room, YGO_NAME: name, YGO_DECK: deck, YGO_WAIT_MS: SEAT_WAIT_MS },
    stderr: "inherit",
  });
  const client = new Client({ name: `smoke-${label}`, version: "0.0.0" });
  await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
  return client;
}

function answerFor(label, prompt) {
  if (prompt.kind === "deck" || prompt.kind === "side") {
    if (prompt.rejected) throw new Error(`${label}: ${prompt.kind} refused: ${prompt.rejected}`);
    return { submit: true };
  }
  if (prompt.kind === "rps") return { choose: [HANDS[label]] };
  return { choose: [1] };
}

// Lobby prompts get fixed answers; at the first prompt of every duel the seat
// surrenders. It never answers a duel prompt, so it is not a second player.
async function drive(label, client) {
  let view = await call(client, "wait");
  let chatted = false;
  let heard = false;
  const listen = (current) => {
    heard ||= current.events.some((event) => event.kind === "chat" && event.from === "opponent" && event.text.startsWith("smoke "));
    return current;
  };
  while (view.phase !== "ended" && view.phase !== "disconnected") {
    if (!chatted && !["deck", "lobby"].includes(view.phase)) {
      await call(client, "chat", { text: `smoke ${label}: hello` });
      chatted = true;
    }
    const prompt = view.prompt;
    if (!prompt) view = listen(await call(client, "wait"));
    else if (LOBBY_PROMPTS.has(prompt.kind)) view = listen(await call(client, "answer", answerFor(label, prompt)));
    else {
      say(`${label}: duel ${view.match.duel}, prompt ${prompt.kind}: surrendering`);
      view = listen(await call(client, "surrender"));
    }
  }
  say(`${label}: ${view.phase}${view.disconnected ? ` (${view.disconnected})` : ""}, score ${JSON.stringify(view.match.score)}, heard the other seat's chat: ${heard}`);
  return { ...view, heard };
}

async function checkFolder(runDir, room, name) {
  const folder = runFolder(runDir, room, name);
  const files = await readdir(folder).catch(() => []);
  const lines = (await readFile(join(folder, "results.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const duels = lines.filter((line) => line.type === "duel").length;
  const missing = [];
  if (!lines.some((line) => line.type === "match")) missing.push("a match line");
  const replays = files.filter((file) => /^replay-\d+\.yrp$/.test(file)).length;
  if (replays !== duels) missing.push(`${duels} replays (found ${replays})`);
  for (let duel = 1; duel <= duels; duel += 1) {
    if (!files.includes(`duel-${duel}.ydk`)) missing.push(`duel-${duel}.ydk`);
  }
  return { folder, duels, replays, missing };
}

async function main() {
  const { values } = parseArgs({ options: { room: { type: "string" }, deck: { type: "string" }, names: { type: "string" } } });
  const room = values.room ?? `M,TM0,NF#sm${randomBytes(4).toString("hex")}`;
  const suffix = randomBytes(2).toString("hex");
  const [nameA, nameB] = values.names?.split(",") ?? [`smoke-a-${suffix}`, `smoke-b-${suffix}`];
  const deck = values.deck ?? DEFAULT_DECK;
  const { runDir } = readConfig({ ...process.env, YGO_ROOM: room });
  say(`room ${room} · seats ${nameA}, ${nameB} · deck ${deck}`);
  const clients = [];
  const deadline = setTimeout(() => {
    say(`smoke run exceeded ${DEADLINE_MS / 60_000} minutes`);
    process.exit(1);
  }, DEADLINE_MS);
  try {
    clients.push(await startSeat("a", { room, name: nameA, deck }));
    clients.push(await startSeat("b", { room, name: nameB, deck }));
    const views = await Promise.all([drive("a", clients[0]), drive("b", clients[1])]);
    const checks = await Promise.all([checkFolder(runDir, room, nameA), checkFolder(runDir, room, nameB)]);
    for (const check of checks) say(`${check.folder}: ${check.duels} duels, ${check.replays} replays${check.missing.length ? `, missing ${check.missing.join(", ")}` : ""}`);
    const ok = views.every((view) => view.phase === "ended" && view.heard) && checks.every((check) => check.missing.length === 0);
    say(ok ? "smoke: passed" : "smoke: failed");
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    say(`smoke: failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
