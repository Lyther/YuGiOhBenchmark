import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "../src/cards/catalog.js";
import { applyEdits, exportDeck, sectionFor } from "../src/deck/deck.js";

// The card data `npm run cards` downloaded.
const catalog = await loadCatalog(fileURLToPath(new URL("../data/cards", import.meta.url)));

test("Fusion, Synchro, Xyz and Link cards belong in the extra deck; everything else in main", () => {
  assert.equal(sectionFor(44508094, catalog), "extra");
  assert.equal(sectionFor(84013237, catalog), "extra");
  assert.equal(sectionFor(1861629, catalog), "extra");
  assert.equal(sectionFor(16178681, catalog), "main", "a main-deck Pendulum");
  assert.equal(sectionFor(55144522, catalog), "main");
  assert.equal(sectionFor(99999999, catalog), "main", "unknown codes default to main");
});

test("edits apply import, clear, remove, add, move in that order, by name, prefix or code", () => {
  const start = { main: [89631139, 89631139, 46986414], extra: [44508094], side: [14558127] };
  const edited = applyEdits(start, {
    remove: [{ card: "Blue-Eyes White Dragon", count: 1 }],
    add: [{ card: "Decode Talker", count: 1 }, { card: 55144522, count: 2 }, { card: "Maxx", section: "side" }],
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
