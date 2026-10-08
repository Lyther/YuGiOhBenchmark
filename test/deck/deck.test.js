import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { exportDeck, parseDeck, sectionFor } from "../../src/deck/deck.js";
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

test("Fusion, Synchro, Xyz and Link cards belong in the extra deck; everything else in main", () => {
  assert.equal(sectionFor(44508094, catalog), "extra");
  assert.equal(sectionFor(84013237, catalog), "extra");
  assert.equal(sectionFor(1861629, catalog), "extra");
  assert.equal(sectionFor(16178681, catalog), "main", "a main-deck Pendulum");
  assert.equal(sectionFor(55144522, catalog), "main");
  assert.equal(sectionFor(99999999, catalog), "main", "unknown codes default to main");
});

test("edits apply import, clear, remove, add, move in that order, by name or code", async () => {
  const { applyEdits } = await import("../../src/deck/deck.js");
  const start = { main: [89631139, 89631139, 46986414], extra: [44508094], side: [14558127] };
  const edited = applyEdits(start, {
    remove: [{ card: "Blue-Eyes White Dragon", count: 1 }],
    add: [{ card: "decode", count: 1 }, { card: 55144522, count: 2 }, { card: "Maxx", section: "side" }],
    move: [{ card: "Ash Blossom & Joyous Spring", from: "side", to: "main" }],
  }, catalog);
  assert.deepEqual(edited, {
    main: [89631139, 46986414, 55144522, 55144522, 14558127],
    extra: [44508094, 1861629],
    side: [23434538],
  });
  assert.deepEqual(start.main, [89631139, 89631139, 46986414], "the input deck is untouched");
  const replaced = applyEdits(start, { import: exportDeck({ main: [10000], extra: [], side: [] }, "ydke"), add: [{ card: 10000 }] }, catalog);
  assert.deepEqual(replaced, { main: [10000, 10000], extra: [], side: [] });
  assert.deepEqual(applyEdits(start, { clear: true, add: [{ card: 89631139, count: 3 }] }, catalog), { main: [89631139, 89631139, 89631139], extra: [], side: [] });
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
