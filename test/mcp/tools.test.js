import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { writeFixtureCards } from "../helpers/fixture-catalog.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SEAT = join(ROOT, "src/bin/seat.js");
const DECK = join(ROOT, "decks/sample.ydk");

// The real seat process over real stdio MCP, offline: no tool here submits a
// deck, so no socket is opened (AD-04). Cards come from the fixture set.
async function startSeat(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo-tools-"));
  await writeFixtureCards(join(dir, "cards"));
  const stdout = [];
  const onSpawn = ({ process: child }) => child.once("spawn", () => {
    if (child.spawnargs.includes(SEAT)) child.stdout.on("data", (chunk) => stdout.push(chunk));
  });
  subscribe("child_process", onSpawn);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SEAT], cwd: ROOT, stderr: "pipe",
    env: {
      YGO_ROOM: "M,TM0,NF#toolstest", YGO_NAME: "tools-seat", YGO_CARDS_DIR: join(dir, "cards"), YGO_RUN_DIR: join(dir, "runs"),
      YGO_DECK: DECK, YGO_WAIT_MS: "1000", YGO_LOG_LEVEL: "warn", YGO_HOST: "127.0.0.1", YGO_PORT: "9",
    },
  });
  const client = new Client({ name: "tools-test", version: "0.0.0" }, { supportedProtocolVersions: ["2025-06-18"] });
  await client.connect(transport, { timeout: 20_000 });
  unsubscribe("child_process", onSpawn);
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 10_000 });
    return { isError: result.isError === true, text: result.content[0].text };
  };
  return { client, call, stdout: () => Buffer.concat(stdout).toString("utf8") };
}

test("the tool list, schemas, annotations and size key form the seat contract", async (t) => {
  const { client } = await startSeat(t);
  const { tools } = await client.listTools();
  const snapshot = tools.map((tool) => ({
    name: tool.name,
    inputs: Object.keys(tool.inputSchema.properties ?? {}).sort(),
    readOnly: tool.annotations?.readOnlyHint === true,
    maxChars: tool._meta?.["anthropic/maxResultSizeChars"],
  }));
  assert.deepEqual(snapshot, [
    { name: "wait", inputs: ["format", "full"], readOnly: false, maxChars: 500000 },
    { name: "answer", inputs: ["cancel", "card", "choose", "counts", "finish", "format", "submit"], readOnly: false, maxChars: 500000 },
    { name: "deck_show", inputs: ["format"], readOnly: true, maxChars: 500000 },
    { name: "deck_edit", inputs: ["add", "clear", "format", "import", "move", "remove"], readOnly: false, maxChars: 500000 },
    { name: "card", inputs: ["code", "format", "name"], readOnly: true, maxChars: 500000 },
    { name: "card_search", inputs: ["atkMax", "atkMin", "attribute", "defMax", "defMin", "format", "kind", "level", "levelMax", "levelMin", "limit", "name", "offset", "race", "setname", "text", "types"], readOnly: true, maxChars: 500000 },
    { name: "chat", inputs: ["text"], readOnly: false, maxChars: 500000 },
    { name: "surrender", inputs: ["format"], readOnly: false, maxChars: 500000 },
  ]);
});

test("the deck loaded from YGO_DECK is offered for submit before any socket opens", async (t) => {
  const { call } = await startSeat(t);
  const text = await call("wait");
  assert.equal(text.isError, false);
  assert.match(text.text, /^Phase: deck · room M,TM0,NF#toolstest · you: tools-seat$/m);
  assert.match(text.text, /Main 40, Extra 1, Side 8/);
  const view = JSON.parse((await call("wait", { format: "json" })).text);
  assert.equal(view.prompt.kind, "deck");
  assert.deepEqual(view.events, [], "the first wait already delivered everything");
  const wrong = await call("answer", { choose: [1] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /takes submit\. Next: Submit your deck/);
  const surrender = await call("surrender");
  assert.equal(surrender.isError, true);
  assert.match(surrender.text, /only during a duel/);
});

test("card lookups and searches answer from the local card data", async (t) => {
  const { call, stdout } = await startSeat(t);
  const byName = await call("card", { name: "decode" });
  assert.match(byName.text, /^Decode Talker \(1861629\)$/m);
  const byCode = JSON.parse((await call("card", { code: 89631139, format: "json" })).text);
  assert.equal(byCode.name, "Blue-Eyes White Dragon");
  assert.equal(byCode.strings, undefined);
  const ambiguous = await call("card", { name: "Pot of" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /did you mean: Pot of Desires, Pot of Greed/);
  assert.equal((await call("card", {})).isError, true);
  const search = await call("card_search", { kind: "spell" });
  assert.match(search.text, /^2 cards match; showing 1-2:$/m);
  const json = JSON.parse((await call("card_search", { types: ["synchro"], format: "json" })).text);
  assert.deepEqual(json.cards.map((card) => card.code), [44508094]);
  assert.equal(json.total, 1);
  const lines = stdout().split("\n").filter((line) => line.trim());
  assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", "stdout carries only JSON-RPC");
});

test("deck tools show, edit and import the working deck that the next submit sends", async (t) => {
  const { call } = await startSeat(t);
  assert.match((await call("deck_show")).text, /^Deck: Main 40 · Extra 1 · Side 8$/m);
  assert.match((await call("deck_show", { format: "ydk" })).text, /^#main$/m);
  const edited = await call("deck_edit", { remove: [{ card: 89631139, count: 3 }], add: [{ card: "Pot of Greed", count: 2 }, { card: "Decode Talker" }] });
  assert.equal(edited.isError, false);
  assert.match(edited.text, /^Deck: Main 39 · Extra 2 · Side 8$/m);
  assert.match(edited.text, /^  3x Pot of Greed \(55144522\)$/m, "one copy was already in the sample deck");
  assert.match((await call("wait")).text, /Main 39, Extra 2, Side 8/, "the deck prompt follows the working deck");
  const unknown = await call("deck_edit", { add: [{ card: "Pot of" }] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /did you mean: Pot of Desires, Pot of Greed/);
  assert.match((await call("deck_show")).text, /Main 39/, "a rejected edit changes nothing");
  const imported = JSON.parse((await call("deck_edit", { import: "ydke://o6lXBaOpVwVKcEkD!viOnAg==!ryPeAA==!", format: "json" })).text);
  assert.deepEqual(imported.counts, { main: 3, extra: 1, side: 1 });
  assert.equal((await call("deck_edit", {})).isError, true);
});
