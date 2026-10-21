import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DeckEditError, exportDeck, parseDeck } from "../../src/deck/deck.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";

const catalog = await fixtureCatalog();
const DECK = Object.freeze({
  main: [89631139, 89631139, 46986414, 55144522, 44095762],
  extra: [44508094, 84013237, 1861629],
  side: [14558127, 14558127, 23434538],
});

test("YDK, ydke:// and deck-code exports parse back to the same deck", () => {
  for (const format of ["ydk", "ydke", "code"]) {
    const text = exportDeck(DECK, format);
    assert.deepEqual(parseDeck(text), { main: [...DECK.main], extra: [...DECK.extra], side: [...DECK.side] }, format);
  }
  assert.match(exportDeck(DECK, "ydk"), /^#main$/m);
  assert.match(exportDeck(DECK, "ydke"), /^ydke:\/\//);
  assert.throws(() => exportDeck(DECK, "pdf"), /format/);
});

test("the committed sample deck is a 40-card YDK with one extra and eight side cards", async () => {
  const deck = parseDeck(await readFile(new URL("../../decks/sample.ydk", import.meta.url), "utf8"));
  assert.equal(deck.main.length, 40);
  assert.deepEqual(deck.extra, [84013237]);
  assert.equal(deck.side.length, 8);
});

test("YDK sections are taken as written; the server decides legality", () => {
  const deck = parseDeck("#main\n44508094\n89631139 \r\n#extra\n!side\n");
  assert.deepEqual(deck, { main: [44508094, 89631139], extra: [], side: [] });
});

test("unrecognized or malformed imports are refused with the accepted formats", () => {
  assert.throws(() => parseDeck("just some words"), /YDK text, a ydke:\/\/ URL or a KoishiPro deck code/);
  assert.throws(() => parseDeck("ydke://bad"), /ydke/);
  assert.throws(() => parseDeck("!!!!"), /deck code/);
  assert.throws(() => parseDeck("#main\n0\n"), /code 0/);
  assert.throws(() => parseDeck("#main\n268435456\n"), /code 268435456/);
});

test("a deck code must decode to whole card entries: a word or a cut-off code is refused", () => {
  assert.throws(() => parseDeck("HERO"), /deck code/);
  assert.throws(() => parseDeck("AshBlossom"), /deck code/);
  assert.throws(() => parseDeck(exportDeck(DECK, "code").slice(0, -2)), /deck code/);
});

test("an edit that cannot apply rejects the whole call with the reason", async () => {
  const { applyEdits, DeckEditError } = await import("../../src/deck/deck.js");
  const start = { main: [89631139], extra: [], side: [] };
  assert.throws(() => applyEdits(start, { add: [{ card: "Pot of" }] }, catalog), (error) => error instanceof DeckEditError && /Pot of Desires, Pot of Greed/.test(error.message));
  assert.throws(() => applyEdits(start, { remove: [{ card: 89631139, count: 2 }] }, catalog), /only 1/);
  assert.throws(() => applyEdits(start, { move: [{ card: 46986414, from: "main", to: "side" }] }, catalog), /Dark Magician/);
  assert.throws(() => applyEdits(start, { add: [{ card: 0 }] }, catalog), /code/);
  assert.throws(() => applyEdits(start, {}, catalog), /nothing to do/);
});

test("a deck code that cannot hold the deck says so, and ydk and ydke still can", () => {
  const heavy = { main: Array(5).fill(89631139), extra: [], side: [] };
  assert.throws(() => exportDeck(heavy, "code"), (error) => error instanceof DeckEditError && /deck code cannot hold this deck.*ydk or ydke/.test(error.message));
  for (const format of ["ydk", "ydke"]) assert.equal(parseDeck(exportDeck(heavy, format)).main.length, 5, format);
});

test("a YDK card line with text after the code is still that card, as in ygopro", () => {
  const deck = parseDeck("#main\n14558127 # Ash Blossom\n89631139\t// Blue-Eyes\r\n#extra\n44508094 Stardust Dragon\n!side\n23434538 # Maxx C\r\n");
  assert.deepEqual(deck, { main: [14558127, 89631139], extra: [44508094], side: [23434538] });
});
