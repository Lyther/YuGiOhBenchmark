import assert from "node:assert/strict";
import test from "node:test";

import {
  OcgcoreCommonConstants as C,
  YGOProMsgAddCounter,
  YGOProMsgAttack,
  YGOProMsgBattle,
  YGOProMsgChainDisabled,
  YGOProMsgChainEnd,
  YGOProMsgChainNegated,
  YGOProMsgChainSolving,
  YGOProMsgChaining,
  YGOProMsgConfirmCards,
  YGOProMsgDamage,
  YGOProMsgDraw,
  YGOProMsgHint,
  YGOProMsgMove,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgPayLpCost,
  YGOProMsgPosChange,
  YGOProMsgRecover,
  YGOProMsgShuffleDeck,
  YGOProMsgShuffleHand,
  YGOProMsgSpSummoning,
  YGOProMsgStart,
  YGOProMsgSummoning,
  YGOProMsgTossCoin,
  YGOProMsgTossDice,
  YGOProMsgUpdateData,
  YGOProMsgWin,
} from "ygopro-msg-encode";

import { applyBoard, createBoard } from "../../src/game/board.js";
import { describeEvent } from "../../src/game/events.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { gameMessage } from "../helpers/wire.js";

const catalog = await fixtureCatalog();
const BLUE_EYES = 89631139;
const UTOPIA = 84013237;
const DECODE = 1861629;
const POT = 55144522;

function board() {
  const start = gameMessage(YGOProMsgStart, {
    playerType: 0, duelRule: 5, startLp0: 8000, startLp1: 8000,
    player0: { deckCount: 35, extraCount: 15 }, player1: { deckCount: 35, extraCount: 15 },
  });
  let state = createBoard({ duel: 1, start });
  const place = (code, controller, location, sequence, position) => {
    state = applyBoard(state, gameMessage(YGOProMsgMove, {
      code, previous: { controller, location: C.LOCATION_DECK, sequence: 0, position: 0 },
      current: { controller, location, sequence, position }, reason: 0,
    }));
  };
  place(BLUE_EYES, 0, C.LOCATION_MZONE, 2, C.POS_FACEUP_ATTACK);
  place(UTOPIA, 1, C.LOCATION_MZONE, 5, C.POS_FACEUP_ATTACK);
  return state;
}

const state = board();

function event(MessageClass, fields, current = state) {
  return describeEvent(gameMessage(MessageClass, fields), { board: current, catalog });
}

const at = (controller, location, sequence, position = 0) => ({ controller, location, sequence, position });

test("turns, phases and draws are told from the reader's side", () => {
  assert.deepEqual(event(YGOProMsgNewTurn, { player: 0 }), { kind: "turn", text: "Turn 1 (you)" });
  assert.deepEqual(event(YGOProMsgNewPhase, { phase: C.PHASE_BATTLE_START }), { kind: "phase", text: "Battle Phase" });
  assert.deepEqual(event(YGOProMsgDraw, { player: 0, count: 2, cards: [BLUE_EYES, POT] }),
    { kind: "draw", text: "You drew Blue-Eyes White Dragon, Pot of Greed" });
  assert.deepEqual(event(YGOProMsgDraw, { player: 1, count: 2, cards: [0, 0] }), { kind: "draw", text: "Opponent drew 2 cards" });
});

test("summons, moves and position changes name the card and both zones", () => {
  assert.deepEqual(event(YGOProMsgSummoning, { code: BLUE_EYES, controller: 0, location: C.LOCATION_MZONE, sequence: 2, position: C.POS_FACEUP_ATTACK }),
    { kind: "summon", text: "You Normal Summon Blue-Eyes White Dragon to your M3 (faceup-attack)" });
  assert.deepEqual(event(YGOProMsgSpSummoning, { code: UTOPIA, controller: 1, location: C.LOCATION_MZONE, sequence: 5, position: C.POS_FACEUP_ATTACK }),
    { kind: "summon", text: "Opponent Special Summons Number 39: Utopia to opponent's EMZ left (faceup-attack)" });
  assert.deepEqual(event(YGOProMsgMove, {
    code: BLUE_EYES, previous: at(0, C.LOCATION_MZONE, 2, C.POS_FACEUP_ATTACK), current: at(0, C.LOCATION_GRAVE, 0, C.POS_FACEUP), reason: C.REASON_DESTROY | C.REASON_BATTLE,
  }), { kind: "move", text: "Blue-Eyes White Dragon: your M3 → your GY (destroyed by battle)" });
  assert.deepEqual(event(YGOProMsgMove, {
    code: 0, previous: at(1, C.LOCATION_HAND, 0), current: at(1, C.LOCATION_SZONE, 1, C.POS_FACEDOWN), reason: 0,
  }), { kind: "move", text: "face-down card: opponent's hand → opponent's S2 (facedown)" });
  assert.equal(event(YGOProMsgMove, {
    code: BLUE_EYES, previous: at(0, C.LOCATION_HAND, 0), current: at(0, C.LOCATION_MZONE, 2, C.POS_FACEUP_ATTACK), reason: C.REASON_SUMMON,
  }), null, "the summon message already tells this move");
  assert.deepEqual(event(YGOProMsgPosChange, {
    code: BLUE_EYES, card: { controller: 0, location: C.LOCATION_MZONE, sequence: 2 }, previousPosition: C.POS_FACEUP_ATTACK, currentPosition: C.POS_FACEUP_DEFENSE,
  }), { kind: "position", text: "Blue-Eyes White Dragon (your M3) is now faceup-defense" });
});

test("chain links carry the activating player, the card and the effect text", () => {
  assert.deepEqual(event(YGOProMsgChaining, {
    code: DECODE, controller: 1, location: C.LOCATION_MZONE, sequence: 0, subsequence: 0,
    chainCardLocation: { controller: 1, location: C.LOCATION_MZONE, sequence: 0 }, desc: DECODE * 16, chainCount: 1,
  }), { kind: "activate", text: "Chain Link 1: opponent activates Decode Talker (opponent's M1): Stop that activation and destroy it" });
  assert.deepEqual(event(YGOProMsgChainSolving, { chainCount: 2 }), { kind: "resolve", text: "Chain Link 2 resolves" });
  assert.deepEqual(event(YGOProMsgChainNegated, { chainCount: 1 }), { kind: "negate", text: "Chain Link 1's activation was negated" });
  assert.deepEqual(event(YGOProMsgChainDisabled, { chainCount: 1 }), { kind: "negate", text: "Chain Link 1's effect was negated" });
  assert.equal(event(YGOProMsgChainEnd, {}), null);
});

test("attacks, battle and life point changes report numbers", () => {
  assert.deepEqual(event(YGOProMsgAttack, { attacker: at(1, C.LOCATION_MZONE, 5), defender: at(0, C.LOCATION_MZONE, 2) }),
    { kind: "attack", text: "Number 39: Utopia (opponent's EMZ left) attacks Blue-Eyes White Dragon (your M3)" });
  assert.deepEqual(event(YGOProMsgAttack, { attacker: at(1, C.LOCATION_MZONE, 5), defender: at(0, 0, 0) }),
    { kind: "attack", text: "Number 39: Utopia (opponent's EMZ left) attacks directly" });
  assert.deepEqual(event(YGOProMsgBattle, {
    attacker: { location: at(1, C.LOCATION_MZONE, 5), atk: 2500, def: 2000 }, attackerBattleState: 0,
    defender: { location: at(0, C.LOCATION_MZONE, 2), atk: 3000, def: 2500 }, defenderBattleState: 0,
  }), { kind: "battle", text: "Battle: Number 39: Utopia 2500/2000 vs Blue-Eyes White Dragon 3000/2500" });
  assert.deepEqual(event(YGOProMsgDamage, { player: 0, value: 500 }), { kind: "damage", text: "You take 500 damage (LP 7500)" });
  assert.deepEqual(event(YGOProMsgRecover, { player: 1, value: 1000 }), { kind: "lp", text: "Opponent gains 1000 LP (LP 9000)" });
  assert.deepEqual(event(YGOProMsgPayLpCost, { player: 1, cost: 2000 }), { kind: "lp", text: "Opponent pays 2000 LP (LP 6000)" });
});

test("hints, reveals, shuffles, randomness, counters and the duel result", () => {
  assert.equal(event(YGOProMsgHint, { type: C.HINT_SELECTMSG, player: 0, desc: 500 }), null, "selection hints title the next prompt");
  assert.deepEqual(event(YGOProMsgHint, { type: C.HINT_OPSELECTED, player: 1, desc: 95 }),
    { kind: "hint", text: "Opponent chose: Use the effect of [card]?" });
  assert.deepEqual(event(YGOProMsgHint, { type: C.HINT_CODE, player: 1, desc: BLUE_EYES }), { kind: "hint", text: "Declared card: Blue-Eyes White Dragon" });
  assert.deepEqual(event(YGOProMsgHint, { type: C.HINT_RACE, player: 1, desc: 0x2000 }), { kind: "hint", text: "Declared type: Dragon" });
  assert.deepEqual(event(YGOProMsgHint, { type: C.HINT_NUMBER, player: 1, desc: 4 }), { kind: "hint", text: "Declared number: 4" });
  assert.deepEqual(event(YGOProMsgConfirmCards, { player: 0, skipPanel: 0, count: 1, cards: [{ code: POT, controller: 1, location: C.LOCATION_HAND, sequence: 0 }] }),
    { kind: "reveal", text: "Revealed: Pot of Greed (opponent's hand)" });
  assert.deepEqual(event(YGOProMsgShuffleHand, { player: 1, count: 0, cards: [] }), { kind: "shuffle", text: "Opponent's hand was shuffled" });
  assert.deepEqual(event(YGOProMsgShuffleDeck, { player: 0 }), { kind: "shuffle", text: "Your Deck was shuffled" });
  assert.deepEqual(event(YGOProMsgTossCoin, { player: 0, count: 2, results: [1, 0] }), { kind: "random", text: "Coin toss: heads, tails" });
  assert.deepEqual(event(YGOProMsgTossDice, { player: 1, count: 1, results: [5] }), { kind: "random", text: "Die roll: 5" });
  assert.deepEqual(event(YGOProMsgAddCounter, { counterType: 1, controller: 0, location: C.LOCATION_MZONE, sequence: 2, count: 2 }),
    { kind: "counter", text: "2 Spell Counter added to Blue-Eyes White Dragon (your M3)" });
  assert.deepEqual(event(YGOProMsgWin, { player: 0, type: 1 }), { kind: "win", text: "You win the duel: LP reached 0" });
  assert.deepEqual(event(YGOProMsgWin, { player: 1, type: 0 }), { kind: "win", text: "Opponent wins the duel: Surrendered" });
  assert.deepEqual(event(YGOProMsgWin, { player: 2, type: 1 }), { kind: "win", text: "The duel is a draw: LP reached 0" });
  assert.equal(event(YGOProMsgUpdateData, { player: 0, location: C.LOCATION_HAND, cards: [] }), null);
});
