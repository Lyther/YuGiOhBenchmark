import assert from "node:assert/strict";
import test from "node:test";

import { OcgcoreCommonConstants as C } from "ygopro-msg-encode";

import { cardName, phaseLabel, positionLabel, zoneLabel } from "../../src/game/labels.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";

const catalog = await fixtureCatalog();

test("zones are named from the reader's side, with extra monster and field zones spelled out", () => {
  assert.equal(zoneLabel({ side: "me", zone: "monster", index: 2 }), "your M3");
  assert.equal(zoneLabel({ side: "opponent", zone: "monster", index: 5 }), "opponent's EMZ left");
  assert.equal(zoneLabel({ side: "opponent", zone: "monster", index: 6 }), "opponent's EMZ right");
  assert.equal(zoneLabel({ side: "me", zone: "spell", index: 0 }), "your S1");
  assert.equal(zoneLabel({ side: "me", zone: "spell", index: 5 }), "your field zone");
  assert.equal(zoneLabel({ side: "opponent", zone: "grave", index: 3 }), "opponent's GY");
  assert.equal(zoneLabel({ side: "me", zone: "hand", index: 1 }), "your hand");
  assert.equal(zoneLabel({ side: "me", zone: "extra", index: 0 }), "your Extra Deck");
  assert.equal(zoneLabel({ side: "opponent", zone: "banished", index: 0 }), "opponent's banished");
  assert.equal(zoneLabel({ side: "me", zone: "deck", index: 0 }), "your Deck");
});

test("positions use the contract words and spell zones only say face-up or face-down", () => {
  assert.equal(positionLabel(C.POS_FACEUP_ATTACK, "monster"), "faceup-attack");
  assert.equal(positionLabel(C.POS_FACEDOWN_ATTACK, "monster"), "facedown-attack");
  assert.equal(positionLabel(C.POS_FACEUP_DEFENSE, "monster"), "faceup-defense");
  assert.equal(positionLabel(C.POS_FACEDOWN_DEFENSE, "monster"), "facedown-defense");
  assert.equal(positionLabel(C.POS_FACEUP_ATTACK, "spell"), "faceup");
  assert.equal(positionLabel(C.POS_FACEDOWN_DEFENSE, "spell"), "facedown");
});

test("phases read like the game client", () => {
  assert.equal(phaseLabel(C.PHASE_DRAW), "Draw Phase");
  assert.equal(phaseLabel(C.PHASE_MAIN1), "Main Phase 1");
  assert.equal(phaseLabel(C.PHASE_BATTLE_STEP), "Battle Phase");
  assert.equal(phaseLabel(C.PHASE_DAMAGE), "Damage Step");
  assert.equal(phaseLabel(C.PHASE_DAMAGE_CAL), "Damage Calculation");
  assert.equal(phaseLabel(C.PHASE_MAIN2), "Main Phase 2");
  assert.equal(phaseLabel(C.PHASE_END), "End Phase");
  assert.equal(phaseLabel(0), "before the first phase");
});

test("card names come from the catalog, with a visible fallback", () => {
  assert.equal(cardName(89631139, catalog), "Blue-Eyes White Dragon");
  assert.equal(cardName(0, catalog), "face-down card");
  assert.equal(cardName(424242, catalog), "#424242 (no local text)");
});
