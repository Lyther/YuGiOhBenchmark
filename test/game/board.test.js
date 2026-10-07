import assert from "node:assert/strict";
import test from "node:test";

import {
  OcgcoreCommonConstants as C,
  YGOProMsgAddCounter,
  YGOProMsgCardTarget,
  YGOProMsgChainEnd,
  YGOProMsgChainNegated,
  YGOProMsgChainSolved,
  YGOProMsgChaining,
  YGOProMsgConfirmCards,
  YGOProMsgDamage,
  YGOProMsgDraw,
  YGOProMsgEquip,
  YGOProMsgHint,
  YGOProMsgLpUpdate,
  YGOProMsgMove,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgPayLpCost,
  YGOProMsgPosChange,
  YGOProMsgRecover,
  YGOProMsgRemoveCounter,
  YGOProMsgShuffleHand,
  YGOProMsgStart,
  YGOProMsgSwap,
  YGOProMsgSwapGraveDeck,
  YGOProMsgUnequip,
  YGOProMsgUpdateCard,
  YGOProMsgUpdateData,
} from "ygopro-msg-encode";

import { applyBoard, cardAt, createBoard } from "../../src/game/board.js";
import { parseServerPacket } from "../../src/protocol/packets.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { gameMessage } from "../helpers/wire.js";

const BLUE_EYES = 89631139;
const POT = 55144522;
const UTOPIA = 84013237;
const HAND = C.LOCATION_HAND;
const MZONE = C.LOCATION_MZONE;
const SZONE = C.LOCATION_SZONE;
const GRAVE = C.LOCATION_GRAVE;
const DECK = C.LOCATION_DECK;
const FACEUP_ATTACK = C.POS_FACEUP_ATTACK;
const FACEDOWN_DEFENSE = C.POS_FACEDOWN_DEFENSE;
const EMPTY = { flags: 0, empty: true };
const HIDDEN = { flags: 0, empty: true, queryLength: 16 };

function start(me) {
  const message = gameMessage(YGOProMsgStart, {
    playerType: me, duelRule: 5, startLp0: 8000, startLp1: 7000,
    player0: { deckCount: 35, extraCount: 15 }, player1: { deckCount: 34, extraCount: 3 },
  });
  return createBoard({ duel: 2, start: message });
}

function apply(board, MessageClass, fields) {
  return applyBoard(board, gameMessage(MessageClass, fields));
}

function at(controller, location, sequence, position = 0) {
  return { controller, location, sequence, position };
}

test("a duel board maps absolute players to me and opponent from MSG_START", () => {
  const board = start(1);
  assert.equal(board.me, 1);
  assert.equal(board.duel, 2);
  assert.deepEqual(board.lp, { me: 7000, opponent: 8000 });
  assert.equal(board.sides.me.deck, 34);
  assert.equal(board.sides.opponent.deck, 35);
  assert.equal(board.sides.me.extra.length, 3);
  assert.equal(board.sides.opponent.extra.length, 15);
  assert.deepEqual(board.sides.opponent.monsters, Array(7).fill(null));
  assert.deepEqual(board.sides.me.spells, Array(8).fill(null));
  assert.equal(board.version, 0);
});

test("draws move cards from the deck count into the hand, hidden ones as code 0", () => {
  let board = start(0);
  board = apply(board, YGOProMsgDraw, { player: 0, count: 2, cards: [BLUE_EYES, POT] });
  board = apply(board, YGOProMsgDraw, { player: 1, count: 2, cards: [0, (POT | 0x80000000) >>> 0] });
  assert.equal(board.sides.me.deck, 33);
  assert.deepEqual(board.sides.me.hand.map((card) => card.code), [BLUE_EYES, POT]);
  assert.equal(board.sides.opponent.deck, 32);
  assert.deepEqual(board.sides.opponent.hand.map((card) => card.code), [0, POT], "a public draw is revealed");
});

test("moves follow sequences in and out of zones and overlays, and leaving the field clears stats", () => {
  let board = start(0);
  board = apply(board, YGOProMsgDraw, { player: 0, count: 3, cards: [POT, BLUE_EYES, UTOPIA] });
  board = apply(board, YGOProMsgMove, { code: BLUE_EYES, previous: at(0, HAND, 1, FACEDOWN_DEFENSE), current: at(0, MZONE, 2, FACEUP_ATTACK), reason: 0 });
  assert.deepEqual(board.sides.me.hand.map((card) => card.code), [POT, UTOPIA]);
  assert.equal(board.sides.me.monsters[2].code, BLUE_EYES);
  assert.equal(board.sides.me.monsters[2].position, FACEUP_ATTACK);
  board = apply(board, YGOProMsgUpdateCard, { controller: 0, location: MZONE, sequence: 2, card: {
    flags: C.QUERY_CODE | C.QUERY_POSITION | C.QUERY_ATTACK, code: BLUE_EYES, controller: 0, location: MZONE, sequence: 2, position: FACEUP_ATTACK, attack: 3500,
  } });
  assert.equal(board.sides.me.monsters[2].attack, 3500);
  board = apply(board, YGOProMsgMove, { code: UTOPIA, previous: at(0, HAND, 1), current: at(0, MZONE, 4, FACEUP_ATTACK), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: POT, previous: at(0, HAND, 0), current: at(0, MZONE | C.LOCATION_OVERLAY, 4, 0), reason: 0 });
  assert.deepEqual(board.sides.me.monsters[4].overlays, [POT]);
  assert.deepEqual(board.sides.me.hand, []);
  board = apply(board, YGOProMsgMove, { code: POT, previous: at(0, MZONE | C.LOCATION_OVERLAY, 4, 0), current: at(0, GRAVE, 0, FACEUP_ATTACK), reason: 0 });
  assert.deepEqual(board.sides.me.monsters[4].overlays, []);
  board = apply(board, YGOProMsgMove, { code: BLUE_EYES, previous: at(0, MZONE, 2, FACEUP_ATTACK), current: at(0, GRAVE, 1, FACEUP_ATTACK), reason: 0 });
  assert.equal(board.sides.me.monsters[2], null);
  assert.deepEqual(board.sides.me.grave.map((card) => card.code), [POT, BLUE_EYES]);
  assert.equal(board.sides.me.grave[1].attack, undefined, "stats do not follow a card off the field");
  board = apply(board, YGOProMsgMove, { code: 0, previous: at(0, GRAVE, 0), current: at(0, DECK, 0), reason: 0 });
  assert.equal(board.sides.me.deck, 33);
  assert.equal(board.sides.me.grave.length, 1);
});

test("zone snapshots decide occupancy, keep hidden cards and merge partial queries", () => {
  let board = start(0);
  board = apply(board, YGOProMsgMove, { code: 0, previous: at(1, HAND, 0), current: at(1, MZONE, 1, FACEDOWN_DEFENSE), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: UTOPIA, previous: at(1, C.LOCATION_EXTRA, 0), current: at(1, MZONE, 5, FACEUP_ATTACK), reason: 0 });
  const full = { flags: C.QUERY_CODE | C.QUERY_POSITION | C.QUERY_ATTACK | C.QUERY_DEFENSE | C.QUERY_RANK,
    code: UTOPIA, controller: 1, location: MZONE, sequence: 5, position: FACEUP_ATTACK, attack: 2500, defense: 2000, rank: 4 };
  board = apply(board, YGOProMsgUpdateData, { player: 1, location: MZONE, cards: [EMPTY, HIDDEN, EMPTY, EMPTY, EMPTY, full, EMPTY] });
  assert.equal(board.sides.opponent.monsters[1].position, FACEDOWN_DEFENSE, "a hidden entry keeps what moves told us");
  assert.equal(board.sides.opponent.monsters[1].code, 0);
  assert.equal(board.sides.opponent.monsters[5].rank, 4);
  const partial = { flags: C.QUERY_CODE | C.QUERY_POSITION | C.QUERY_ATTACK,
    code: UTOPIA, controller: 1, location: MZONE, sequence: 5, position: FACEUP_ATTACK, attack: 3000 };
  board = apply(board, YGOProMsgUpdateData, { player: 1, location: MZONE, cards: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, partial, EMPTY] });
  assert.equal(board.sides.opponent.monsters[1], null, "an empty entry clears the slot");
  assert.equal(board.sides.opponent.monsters[5].attack, 3000);
  assert.equal(board.sides.opponent.monsters[5].defense, 2000, "unchanged fields survive a cached query");
  board = apply(board, YGOProMsgUpdateData, { player: 1, location: HAND, cards: [HIDDEN, HIDDEN, HIDDEN] });
  assert.deepEqual(board.sides.opponent.hand.map((card) => card.code), [0, 0, 0], "hand length follows the snapshot");
});

test("position changes reveal flipped cards, and swaps exchange two cards", () => {
  let board = start(0);
  board = apply(board, YGOProMsgMove, { code: 0, previous: at(1, HAND, 0), current: at(1, MZONE, 0, FACEDOWN_DEFENSE), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: BLUE_EYES, previous: at(0, HAND, 0), current: at(0, MZONE, 3, FACEUP_ATTACK), reason: 0 });
  board = apply(board, YGOProMsgPosChange, { code: UTOPIA, card: { controller: 1, location: MZONE, sequence: 0 }, previousPosition: FACEDOWN_DEFENSE, currentPosition: C.POS_FACEUP_DEFENSE });
  assert.equal(board.sides.opponent.monsters[0].code, UTOPIA);
  assert.equal(board.sides.opponent.monsters[0].position, C.POS_FACEUP_DEFENSE);
  board = apply(board, YGOProMsgSwap, {
    code1: UTOPIA, card1: at(1, MZONE, 0, C.POS_FACEUP_DEFENSE), code2: BLUE_EYES, card2: at(0, MZONE, 3, FACEUP_ATTACK),
  });
  assert.equal(board.sides.me.monsters[3].code, UTOPIA);
  assert.equal(board.sides.opponent.monsters[0].code, BLUE_EYES);
});

test("the chain stack grows, marks negation, shrinks as links resolve and clears at the end", () => {
  let board = start(0);
  board = apply(board, YGOProMsgMove, { code: 0, previous: at(1, HAND, 0), current: at(1, SZONE, 2, C.POS_FACEDOWN), reason: 0 });
  board = apply(board, YGOProMsgChaining, { code: POT, controller: 0, location: HAND, sequence: 0, subsequence: 0, chainCardLocation: { controller: 0, location: HAND, sequence: 0 }, desc: 0, chainCount: 1 });
  board = apply(board, YGOProMsgChaining, { code: 44095762, controller: 1, location: SZONE, sequence: 2, subsequence: 0, chainCardLocation: { controller: 1, location: SZONE, sequence: 2 }, desc: 44095762 * 16, chainCount: 2 });
  assert.deepEqual(board.chain.map((link) => [link.code, link.controller, link.card.zone, link.card.index]), [
    [POT, "me", "hand", 0], [44095762, "opponent", "spell", 2],
  ]);
  assert.equal(board.sides.opponent.spells[2].code, 44095762, "activating a set card reveals it");
  board = apply(board, YGOProMsgChainNegated, { chainCount: 1 });
  assert.equal(board.chain[0].negated, true);
  board = apply(board, YGOProMsgChainSolved, { chainCount: 2 });
  assert.equal(board.chain.length, 1);
  board = apply(board, YGOProMsgChainEnd, {});
  assert.deepEqual(board.chain, []);
});

test("turns, phases and life points follow the server", () => {
  let board = start(1);
  board = apply(board, YGOProMsgNewTurn, { player: 1 });
  board = apply(board, YGOProMsgNewPhase, { phase: C.PHASE_MAIN1 });
  assert.equal(board.turn, 1);
  assert.equal(board.turnPlayer, "me");
  assert.equal(board.phase, C.PHASE_MAIN1);
  board = apply(board, YGOProMsgDamage, { player: 0, value: 3000 });
  board = apply(board, YGOProMsgPayLpCost, { player: 1, cost: 1000 });
  board = apply(board, YGOProMsgRecover, { player: 1, value: 500 });
  assert.deepEqual(board.lp, { me: 6500, opponent: 5000 });
  board = apply(board, YGOProMsgLpUpdate, { player: 0, lp: 123 });
  assert.equal(board.lp.opponent, 123);
});

test("counters, equips and targets attach to the cards on the field", () => {
  let board = start(0);
  board = apply(board, YGOProMsgMove, { code: BLUE_EYES, previous: at(0, HAND, 0), current: at(0, MZONE, 0, FACEUP_ATTACK), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: POT, previous: at(0, HAND, 0), current: at(0, SZONE, 1, C.POS_FACEUP), reason: 0 });
  board = apply(board, YGOProMsgAddCounter, { counterType: 1, controller: 0, location: MZONE, sequence: 0, count: 3 });
  board = apply(board, YGOProMsgRemoveCounter, { counterType: 1, controller: 0, location: MZONE, sequence: 0, count: 1 });
  assert.deepEqual(board.sides.me.monsters[0].counters, [{ type: 1, count: 2 }]);
  board = apply(board, YGOProMsgEquip, { equip: at(0, SZONE, 1), target: at(0, MZONE, 0) });
  assert.deepEqual(board.sides.me.spells[1].equippedTo, { side: "me", zone: "monster", index: 0 });
  board = apply(board, YGOProMsgUnequip, { card: at(0, SZONE, 1) });
  assert.equal(board.sides.me.spells[1].equippedTo, undefined);
  board = apply(board, YGOProMsgCardTarget, { card1: at(0, SZONE, 1), card2: at(0, MZONE, 0) });
  assert.deepEqual(board.sides.me.spells[1].targets, [{ side: "me", zone: "monster", index: 0 }]);
});

test("confirmations reveal opponent hand cards and shuffles hide them again", () => {
  let board = start(0);
  board = apply(board, YGOProMsgDraw, { player: 1, count: 2, cards: [0, 0] });
  board = apply(board, YGOProMsgConfirmCards, { player: 0, skipPanel: 0, count: 1, cards: [{ code: POT, controller: 1, location: HAND, sequence: 1 }] });
  assert.equal(board.sides.opponent.hand[1].code, POT);
  board = apply(board, YGOProMsgShuffleHand, { player: 1, count: 2, cards: [0, 0] });
  assert.deepEqual(board.sides.opponent.hand.map((card) => card.code), [0, 0]);
});

test("a set-card shuffle keeps every occupied slot and follows disclosed material moves", () => {
  let board = start(0);
  board = apply(board, YGOProMsgMove, { code: BLUE_EYES, previous: at(1, HAND, 0), current: at(1, MZONE, 0, FACEDOWN_DEFENSE), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: UTOPIA, previous: at(1, C.LOCATION_EXTRA, 0), current: at(1, MZONE, 3, FACEDOWN_DEFENSE), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: POT, previous: at(1, HAND, 0), current: at(1, MZONE | C.LOCATION_OVERLAY, 3, 0), reason: 0 });
  const packet = Buffer.from([20, 0, 1, 36, 4, 2,
    1, 4, 0, 8, 1, 4, 3, 8,
    0, 0, 0, 0, 1, 4, 0, 8]);
  board = applyBoard(board, parseServerPacket(packet).message.msg);
  assert.deepEqual(board.sides.opponent.monsters.map((card) => card?.code ?? null), [0, null, null, 0, null, null, null]);
  assert.deepEqual(board.sides.opponent.monsters[0].overlays, [POT]);
  assert.equal(board.sides.opponent.monsters[3].overlays, undefined);
  assert.deepEqual(board.sides.me.monsters, Array(7).fill(null));
});

test("swapping Deck and GY returns Extra Deck monsters before face-up Pendulums", async () => {
  const catalog = await fixtureCatalog();
  let board = start(1);
  board = apply(board, YGOProMsgMove, { code: UTOPIA, previous: at(1, C.LOCATION_EXTRA, 0), current: at(1, GRAVE, 0, FACEUP_ATTACK), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: POT, previous: at(1, HAND, 0), current: at(1, GRAVE, 1, FACEUP_ATTACK), reason: 0 });
  board = apply(board, YGOProMsgMove, { code: 16178681, previous: at(1, HAND, 0), current: at(1, C.LOCATION_EXTRA, 2, C.POS_FACEUP_DEFENSE), reason: 0 });
  const oldDeckCount = board.sides.me.deck;
  board = applyBoard(board, gameMessage(YGOProMsgSwapGraveDeck, { player: 1 }), { catalog });
  assert.equal(board.sides.me.deck, 1, "only Pot of Greed belongs in the Main Deck");
  assert.equal(board.sides.me.grave.length, oldDeckCount);
  assert.equal(board.sides.me.extra.length, 4);
  assert.equal(board.sides.me.extra.at(-2).code, UTOPIA);
  assert.equal(board.sides.me.extra.at(-2).position, C.POS_FACEDOWN_DEFENSE);
  assert.equal(board.sides.me.extra.at(-1).code, 16178681);
});

test("the reducer is pure: input boards are untouched and unrelated messages change nothing", () => {
  const board = start(0);
  const frozen = structuredClone(board);
  const next = apply(board, YGOProMsgDraw, { player: 0, count: 1, cards: [POT] });
  assert.deepEqual(board, frozen);
  assert.equal(next.version, 1);
  assert.equal(apply(next, YGOProMsgHint, { type: C.HINT_SELECTMSG, player: 0, desc: 500 }), next);
  assert.equal(cardAt(next, 0, HAND, 0).code, POT);
  assert.equal(cardAt(next, 1, MZONE, 0), null);
});
