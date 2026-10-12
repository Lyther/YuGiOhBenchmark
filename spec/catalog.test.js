import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "../src/cards/catalog.js";
import { cardName } from "../src/game/labels.js";

// The card data `npm run cards` downloaded. These cards have been printed for
// years, so their values hold from one refresh to the next.
const catalog = await loadCatalog(fileURLToPath(new URL("../data/cards", import.meta.url)));

test("monster, spell and trap rows become cards with English vocabulary", () => {
  const { text, strings, ...blueEyes } = catalog.card(89631139);
  assert.deepEqual(blueEyes, {
    code: 89631139, alias: 0, name: "Blue-Eyes White Dragon", kind: "monster", types: ["normal"],
    attribute: "Light", race: "Dragon", level: 8, atk: 3000, def: 2500, setnames: ["Blue-Eyes"], source: "en-US",
  });
  assert.match(text, /legendary dragon/i);
  assert.equal(strings.length, 16);
  const decode = catalog.card(1861629);
  assert.equal(decode.link, 3);
  assert.deepEqual(decode.linkMarkers, ["bottom-left", "bottom-right", "top"]);
  assert.equal(decode.def, undefined, "a Link monster has no DEF");
  assert.equal(decode.level, undefined);
  assert.deepEqual(decode.types, ["effect", "link"]);
  const utopia = catalog.card(84013237);
  assert.equal(utopia.rank, 4);
  assert.equal(utopia.level, undefined);
  assert.deepEqual(utopia.setnames, ["Number", "Utopia"]);
  const oddEyes = catalog.card(16178681);
  assert.equal(oddEyes.level, 7);
  assert.deepEqual(oddEyes.scales, { left: 4, right: 4 });
  assert.deepEqual(oddEyes.types, ["effect", "pendulum"]);
  assert.deepEqual(catalog.card(14558127).types, ["effect", "tuner"]);
  assert.deepEqual(catalog.card(44508094).types, ["effect", "synchro"]);
  assert.equal(catalog.card(10000).atk, -2, "an unknown ATK keeps the CDB value -2");
  assert.equal(catalog.card(55144522).kind, "spell");
  assert.equal(catalog.card(44095762).kind, "trap");
  assert.equal(catalog.card(89631140).alias, 89631139, "alternate art keeps its alias");
  assert.equal(catalog.card(123), null);
  assert.equal(catalog.isExtraDeck(44508094), true);
  assert.equal(catalog.isExtraDeck(1861629), true);
  assert.equal(catalog.isExtraDeck(16178681), false, "a main-deck Pendulum stays in main");
});

test("descriptions resolve system strings and per-card effect strings", () => {
  assert.equal(catalog.desc(95), "Use the effect of [%ls]?");
  assert.equal(catalog.desc(1861629 << 4), "Negate the activation and destroy");
  assert.equal(catalog.desc((55144522 << 4) | 3), null, "an empty card string is unknown");
  assert.equal(catalog.desc((123 << 4) | 1), null);
  assert.equal(catalog.victoryReason(1), "LP reached 0");
  assert.equal(catalog.counterName(1), "Spell Counter");
  assert.equal(catalog.attributeName(0x20), "Dark");
  assert.equal(catalog.raceName(0x1000000), "Cyberse");
});

test("card names come from the catalog, with a visible fallback", () => {
  assert.equal(cardName(89631139, catalog), "Blue-Eyes White Dragon");
  assert.equal(cardName(0, catalog), "face-down card");
  assert.equal(cardName(424242, catalog), "#424242 (no local text)");
});
