import assert from "node:assert/strict";
import test from "node:test";

import {
  OcgcoreCommonConstants as C,
  YGOProMsgAnnounceAttrib,
  YGOProMsgAnnounceCard,
  YGOProMsgAnnounceNumber,
  YGOProMsgAnnounceRace,
  YGOProMsgMove,
  YGOProMsgRockPaperScissors,
  YGOProMsgSelectBattleCmd,
  YGOProMsgSelectCard,
  YGOProMsgSelectChain,
  YGOProMsgSelectCounter,
  YGOProMsgSelectDisField,
  YGOProMsgSelectEffectYn,
  YGOProMsgSelectIdleCmd,
  YGOProMsgSelectOption,
  YGOProMsgSelectPlace,
  YGOProMsgSelectPosition,
  YGOProMsgSelectSum,
  YGOProMsgSelectTribute,
  YGOProMsgSelectUnselectCard,
  YGOProMsgSelectYesNo,
  YGOProMsgSortCard,
  YGOProMsgStart,
} from "ygopro-msg-encode";

import { applyBoard, createBoard } from "../../src/game/board.js";
import { AnswerError, buildPrompt, lobbyPrompt, resolveAnswer, supportsMessage } from "../../src/game/prompts/index.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { gameMessage } from "../helpers/wire.js";

const catalog = await fixtureCatalog();
const BLUE_EYES = 89631139;
const DARK_MAGICIAN = 46986414;
const UTOPIA = 84013237;
const DECODE = 1861629;
const ODD_EYES = 16178681;
const ASH = 14558127;
const MAXX = 23434538;
const STRATOS = 40044918;
const COSTON = 44436472;
const MIRROR_FORCE = 44095762;
const HAND = C.LOCATION_HAND;
const MZONE = C.LOCATION_MZONE;

function duelBoard() {
  const start = gameMessage(YGOProMsgStart, {
    playerType: 0, duelRule: 5, startLp0: 8000, startLp1: 8000,
    player0: { deckCount: 35, extraCount: 15 }, player1: { deckCount: 35, extraCount: 15 },
  });
  let board = createBoard({ duel: 1, start });
  const place = (code, controller, sequence) => {
    board = applyBoard(board, gameMessage(YGOProMsgMove, {
      code, previous: { controller, location: C.LOCATION_DECK, sequence: 0, position: 0 },
      current: { controller, location: MZONE, sequence, position: C.POS_FACEUP_ATTACK }, reason: 0,
    }));
  };
  place(DECODE, 0, 0);
  place(BLUE_EYES, 0, 2);
  place(UTOPIA, 1, 5);
  return board;
}

const board = duelBoard();
const where = (controller, location, sequence) => ({ controller, location, sequence });

function prompt(MessageClass, fields, hint = null) {
  return buildPrompt(gameMessage(MessageClass, fields), { board, catalog, hint });
}

function bytes(built, answer) {
  const action = resolveAnswer(built.prompt, answer);
  assert.equal(action.type, "response");
  return [...action.bytes];
}

const labels = (built) => built.prompt.options.map((option) => option.label);

test("main-phase commands list every action in message order and encode like the stock client", () => {
  const built = prompt(YGOProMsgSelectIdleCmd, {
    player: 0,
    summonableCount: 1, summonableCards: [{ code: STRATOS, ...where(0, HAND, 0) }],
    spSummonableCount: 0, spSummonableCards: [],
    reposableCount: 1, reposableCards: [{ code: BLUE_EYES, ...where(0, MZONE, 2) }],
    msetableCount: 1, msetableCards: [{ code: STRATOS, ...where(0, HAND, 0) }],
    ssetableCount: 1, ssetableCards: [{ code: MIRROR_FORCE, ...where(0, HAND, 1) }],
    activatableCount: 2, activatableCards: [
      { code: ODD_EYES, ...where(0, HAND, 2), desc: 1160 },
      { code: DECODE, ...where(0, MZONE, 0), desc: DECODE * 16 },
    ],
    canBp: 1, canEp: 1, canShuffle: 0,
  });
  assert.equal(built.prompt.kind, "command");
  assert.equal(built.auto, null);
  assert.deepEqual(labels(built), [
    "Normal Summon Elemental HERO Stratos (your hand)",
    "Change position of Blue-Eyes White Dragon (your M3)",
    "Set Elemental HERO Stratos (your hand)",
    "Set Mirror Force (your hand)",
    "Activate Odd-Eyes Pendulum Dragon (your hand): Put in Pendulum Zone",
    "Activate Decode Talker (your M1): Stop that activation and destroy it",
    "Go to Battle Phase",
    "End turn",
  ]);
  assert.deepEqual(built.prompt.options[0].card, { code: STRATOS, name: "Elemental HERO Stratos", where: "your hand" });
  assert.deepEqual(bytes(built, { choose: [1] }), [0, 0, 0, 0]);
  assert.deepEqual(bytes(built, { choose: [2] }), [2, 0, 0, 0]);
  assert.deepEqual(bytes(built, { choose: [6] }), [5, 0, 1, 0]);
  assert.deepEqual(bytes(built, { choose: [7] }), [6, 0, 0, 0]);
  assert.deepEqual(bytes(built, { choose: [8] }), [7, 0, 0, 0]);
});

test("battle commands show attackers, direct attacks, Main Phase 2 and the end of turn", () => {
  const built = prompt(YGOProMsgSelectBattleCmd, {
    player: 0,
    activatableCount: 1, activatableCards: [{ code: DECODE, ...where(0, MZONE, 0), desc: DECODE * 16 }],
    attackableCount: 2, attackableCards: [
      { code: BLUE_EYES, ...where(0, MZONE, 2), directAttack: 0 },
      { code: DECODE, ...where(0, MZONE, 0), directAttack: 1 },
    ],
    canM2: 1, canEp: 1,
  });
  assert.equal(built.prompt.kind, "battle");
  assert.deepEqual(labels(built), [
    "Activate Decode Talker (your M1): Stop that activation and destroy it",
    "Attack with Blue-Eyes White Dragon (your M3)",
    "Attack with Decode Talker (your M1) (can attack directly)",
    "Go to Main Phase 2",
    "End turn",
  ]);
  assert.deepEqual(bytes(built, { choose: [1] }), [0, 0, 0, 0]);
  assert.deepEqual(bytes(built, { choose: [3] }), [1, 0, 1, 0]);
  assert.deepEqual(bytes(built, { choose: [4] }), [2, 0, 0, 0]);
  assert.deepEqual(bytes(built, { choose: [5] }), [3, 0, 0, 0]);
});

test("chain windows: empty ones pass automatically, a single forced link is taken, otherwise Pass comes first", () => {
  const chain = (chains) => prompt(YGOProMsgSelectChain, { player: 0, count: chains.length, specialCount: 0, hint0: 0, hint1: 0, chains });
  const link = (code, forced = 0) => ({ edesc: 0, forced, code, ...where(0, HAND, 0), subsequence: 0, desc: 0 });
  const empty = chain([]);
  assert.deepEqual(empty.auto, { choose: [1] });
  assert.deepEqual(bytes(empty, empty.auto), [255, 255, 255, 255]);
  const forced = chain([link(ASH, 1)]);
  assert.deepEqual(labels(forced), ["Activate Ash Blossom & Joyous Spring (your hand)"]);
  assert.deepEqual(forced.auto, { choose: [1] });
  assert.deepEqual(bytes(forced, forced.auto), [0, 0, 0, 0]);
  const open = chain([link(ASH), link(MAXX)]);
  assert.equal(open.auto, null);
  assert.deepEqual(labels(open), ["Pass", "Activate Ash Blossom & Joyous Spring (your hand)", 'Activate Maxx "C" (your hand)']);
  assert.deepEqual(bytes(open, { choose: [1] }), [255, 255, 255, 255]);
  assert.deepEqual(bytes(open, { choose: [3] }), [1, 0, 0, 0]);
});

test("card selections name zeroed opponent cards from the board and answer by position", () => {
  const cards = [{ code: BLUE_EYES, ...where(0, MZONE, 2), subsequence: 0 }, { code: 0, ...where(1, MZONE, 5), subsequence: 0 }];
  const built = prompt(YGOProMsgSelectCard, { player: 0, cancelable: 1, min: 1, max: 1, count: 2, cards }, 501);
  assert.equal(built.prompt.kind, "cards");
  assert.equal(built.prompt.text, "Select a card to discard.");
  assert.deepEqual(labels(built), ["Blue-Eyes White Dragon (your M3)", "Number 39: Utopia (opponent's EMZ left)"], "Q-04");
  assert.equal(built.prompt.min, 1);
  assert.equal(built.prompt.max, 1);
  assert.equal(built.prompt.cancelable, true);
  assert.deepEqual(bytes(built, { choose: [2] }), [1, 1]);
  assert.deepEqual(bytes(built, { cancel: true }), [255, 255, 255, 255]);
  const forced = prompt(YGOProMsgSelectCard, { player: 0, cancelable: 0, min: 2, max: 2, count: 2, cards });
  assert.deepEqual(forced.auto, { choose: [1, 2] });
  assert.deepEqual(bytes(forced, forced.auto), [2, 0, 1]);
});

test("tributes show what each card is worth and are automatic only when every card counts as one", () => {
  const tribute = (cards, min, max) => prompt(YGOProMsgSelectTribute, { player: 0, cancelable: 0, min, max, count: cards.length, cards }, 500);
  const mixed = tribute([
    { code: COSTON, ...where(0, MZONE, 0), releaseParam: 2 },
    { code: BLUE_EYES, ...where(0, MZONE, 2), releaseParam: 1 },
  ], 2, 2);
  assert.equal(mixed.prompt.kind, "tribute");
  assert.deepEqual(mixed.prompt.options.map((option) => option.tributes), [2, 1]);
  assert.equal(mixed.auto, null, "a two-tribute card makes several answers legal");
  assert.deepEqual(bytes(mixed, { choose: [1] }), [1, 0]);
  const ones = tribute([
    { code: COSTON, ...where(0, MZONE, 0), releaseParam: 1 },
    { code: BLUE_EYES, ...where(0, MZONE, 2), releaseParam: 1 },
  ], 2, 2);
  assert.deepEqual(ones.auto, { choose: [1, 2] });
});

test("a zero-minimum card selection can choose nothing without cancelling", () => {
  // Stock client: duelclient.cpp MSG_SELECT_CARD sets select_ready at min=0;
  // event_handler.cpp SetResponseSelectedCards writes a zero count byte.
  const built = prompt(YGOProMsgSelectCard, {
    player: 0, cancelable: 0, min: 0, max: 1, count: 1,
    cards: [{ code: BLUE_EYES, ...where(0, MZONE, 2), subsequence: 0 }],
  });
  assert.equal(built.auto, null);
  assert.deepEqual(bytes(built, { choose: [] }), [0]);
  assert.deepEqual(bytes(built, { choose: [1] }), [1, 0]);
});

test("mandatory sum cards can meet the total with no optional cards chosen", () => {
  // ocgcore/playerop.cpp select_with_sum_limit reads optional indices only
  // after mcount; min=0 permits the mandatory card to satisfy the total alone.
  const built = prompt(YGOProMsgSelectSum, {
    mode: 0, player: 0, sumVal: 7, min: 0, max: 1,
    mustSelectCount: 1, mustSelectCards: [{ code: DARK_MAGICIAN, ...where(0, MZONE, 0), opParam: 7 }],
    count: 1, cards: [{ code: STRATOS, ...where(0, MZONE, 1), opParam: 4 }],
  });
  assert.deepEqual(bytes(built, { choose: [] }), [1, 0]);
});

test("sum selections expose values, mode and mandatory cards, and pad the mandatory slots (D-02)", () => {
  const built = prompt(YGOProMsgSelectSum, {
    mode: 0, player: 0, sumVal: 8, min: 1, max: 2,
    mustSelectCount: 1, mustSelectCards: [{ code: DARK_MAGICIAN, ...where(0, MZONE, 0), opParam: 7 }],
    count: 3, cards: [
      { code: STRATOS, ...where(0, MZONE, 1), opParam: 4 },
      { code: ASH, ...where(0, HAND, 0), opParam: (2 << 16) | 3 },
      { code: MAXX, ...where(0, HAND, 1), opParam: (0x80000000 | 9) >>> 0 },
    ],
  });
  assert.equal(built.prompt.kind, "sum");
  assert.equal(built.prompt.sumTarget, 8);
  assert.equal(built.prompt.sumMode, "exactly");
  assert.deepEqual(built.prompt.mustInclude, [{ label: "Dark Magician (your M1)", values: [7] }]);
  assert.deepEqual(built.prompt.options.map((option) => option.values), [[4], [3, 2], [9]]);
  assert.equal(built.auto, null);
  assert.deepEqual(bytes(built, { choose: [2] }), [2, 0, 1], "stock layout: count, mandatory slots, chosen");
  const atLeast = prompt(YGOProMsgSelectSum, {
    mode: 1, player: 0, sumVal: 8, min: 0, max: 0, mustSelectCount: 0, mustSelectCards: [],
    count: 1, cards: [{ code: STRATOS, ...where(0, MZONE, 1), opParam: 4 }],
  });
  assert.equal(atLeast.prompt.sumMode, "at least");
  assert.deepEqual(bytes(atLeast, { choose: [1] }), [1, 0]);
});

test("select-unselect, sorting and counters", () => {
  const unselect = prompt(YGOProMsgSelectUnselectCard, {
    player: 0, finishable: 1, cancelable: 0, min: 1, max: 2,
    selectableCount: 1, selectableCards: [{ code: BLUE_EYES, ...where(0, MZONE, 2), subsequence: 0 }],
    unselectableCount: 1, unselectableCards: [{ code: DECODE, ...where(0, MZONE, 0), subsequence: 0 }],
  });
  assert.deepEqual(labels(unselect), ["Select Blue-Eyes White Dragon (your M3)", "Unselect Decode Talker (your M1)"]);
  assert.equal(unselect.prompt.finishable, true);
  assert.deepEqual(bytes(unselect, { choose: [2] }), [1, 1]);
  assert.deepEqual(bytes(unselect, { finish: true }), [255, 255, 255, 255]);
  assert.throws(() => resolveAnswer(unselect.prompt, { cancel: true }), AnswerError);

  const sort = prompt(YGOProMsgSortCard, { player: 0, count: 3, cards: [
    { code: BLUE_EYES, ...where(0, C.LOCATION_DECK, 0) }, { code: ASH, ...where(0, C.LOCATION_DECK, 1) }, { code: MAXX, ...where(0, C.LOCATION_DECK, 2) },
  ] });
  assert.equal(sort.prompt.kind, "sort");
  assert.deepEqual(bytes(sort, { choose: [3, 1, 2] }), [1, 2, 0], "byte i is the new position of card i");
  assert.deepEqual(bytes(sort, { cancel: true }), [255]);
  assert.throws(() => resolveAnswer(sort.prompt, { choose: [1, 2] }), /every option/);

  const counters = prompt(YGOProMsgSelectCounter, { player: 0, counterType: 1, counterCount: 3, count: 2, cards: [
    { code: BLUE_EYES, ...where(0, MZONE, 2), counterCount: 2 }, { code: DECODE, ...where(0, MZONE, 0), counterCount: 4 },
  ] });
  assert.equal(counters.prompt.kind, "counter");
  assert.equal(counters.prompt.total, 3);
  assert.match(counters.prompt.text, /3 Spell Counter/);
  assert.deepEqual(counters.prompt.options.map((option) => option.counters), [2, 4]);
  assert.deepEqual(bytes(counters, { counts: [{ option: 1, count: 1 }, { option: 2, count: 2 }] }), [1, 0, 2, 0]);
  const single = prompt(YGOProMsgSelectCounter, { player: 0, counterType: 1, counterCount: 2, count: 1, cards: [
    { code: BLUE_EYES, ...where(0, MZONE, 2), counterCount: 5 },
  ] });
  assert.deepEqual(single.auto, { counts: [{ option: 1, count: 2 }] });
});

test("zones, positions, yes/no, effect questions and options", () => {
  const open = (sequences) => (~sequences.reduce((mask, sequence) => mask | (1 << sequence), 0)) >>> 0;
  const place = prompt(YGOProMsgSelectPlace, { player: 0, count: 1, flag: open([0, 2]) });
  assert.equal(place.prompt.kind, "place");
  assert.deepEqual(labels(place), ["your M1", "your M3"]);
  assert.equal(place.auto, null);
  assert.deepEqual(bytes(place, { choose: [2] }), [0, MZONE, 2]);
  const onlyOne = prompt(YGOProMsgSelectPlace, { player: 0, count: 1, flag: open([4]) });
  assert.deepEqual(onlyOne.auto, { choose: [1] });
  const disfield = prompt(YGOProMsgSelectDisField, { player: 0, count: 1, flag: (~(1 << 16 | 1 << 24)) >>> 0 });
  assert.deepEqual(labels(disfield), ["opponent's M1", "opponent's S1"]);

  const position = prompt(YGOProMsgSelectPosition, { player: 0, code: BLUE_EYES, positions: C.POS_FACEUP_ATTACK | C.POS_FACEUP_DEFENSE });
  assert.deepEqual(labels(position), ["faceup-attack", "faceup-defense"]);
  assert.match(position.prompt.text, /Blue-Eyes White Dragon/);
  assert.deepEqual(bytes(position, { choose: [2] }), [4, 0, 0, 0]);
  assert.deepEqual(prompt(YGOProMsgSelectPosition, { player: 0, code: BLUE_EYES, positions: C.POS_FACEDOWN_DEFENSE }).auto, { choose: [1] });

  const yesno = prompt(YGOProMsgSelectYesNo, { player: 0, desc: 95 });
  assert.equal(yesno.prompt.kind, "yesno");
  assert.deepEqual(labels(yesno), ["Yes", "No"]);
  assert.deepEqual(bytes(yesno, { choose: [1] }), [1, 0, 0, 0]);
  assert.deepEqual(bytes(yesno, { choose: [2] }), [0, 0, 0, 0]);
  const effect = prompt(YGOProMsgSelectEffectYn, { player: 0, code: ASH, ...where(0, HAND, 0), position: 0, desc: 0 });
  assert.equal(effect.prompt.kind, "effect");
  assert.equal(effect.prompt.text, "From [your hand], activate [Ash Blossom & Joyous Spring]?");

  const option = prompt(YGOProMsgSelectOption, { player: 0, count: 2, options: [DECODE * 16, 1160] });
  assert.deepEqual(labels(option), ["Stop that activation and destroy it", "Put in Pendulum Zone"]);
  assert.deepEqual(bytes(option, { choose: [2] }), [1, 0, 0, 0]);
  assert.deepEqual(prompt(YGOProMsgSelectOption, { player: 0, count: 1, options: [1160] }).auto, { choose: [1] });
});

test("declarations: races, attributes, numbers, card names and in-duel rock-paper-scissors", () => {
  const race = prompt(YGOProMsgAnnounceRace, { player: 0, count: 1, availableRaces: 0x1 | 0x2000 });
  assert.deepEqual(labels(race), ["Warrior", "Dragon"]);
  assert.deepEqual(bytes(race, { choose: [2] }), [0, 0x20, 0, 0]);
  const attribute = prompt(YGOProMsgAnnounceAttrib, { player: 0, count: 2, availableAttributes: 0x10 | 0x20 });
  assert.deepEqual(attribute.auto, { choose: [1, 2] });
  assert.deepEqual(bytes(attribute, attribute.auto), [0x30, 0, 0, 0]);
  const number = prompt(YGOProMsgAnnounceNumber, { player: 0, count: 3, numbers: [1, 2, 3] });
  assert.deepEqual(labels(number), ["1", "2", "3"]);
  assert.deepEqual(bytes(number, { choose: [3] }), [2, 0, 0, 0]);
  const declare = prompt(YGOProMsgAnnounceCard, { player: 0, count: 1, opcodes: [0x40000001] });
  assert.equal(declare.prompt.kind, "declare");
  assert.deepEqual(bytes(declare, { card: "blue-eyes white dragon" }), [...Buffer.from(Uint32Array.of(BLUE_EYES).buffer)]);
  assert.deepEqual(bytes(declare, { card: DECODE }), [...Buffer.from(Uint32Array.of(DECODE).buffer)]);
  assert.throws(() => resolveAnswer(declare.prompt, { card: "Pot of" }), /Pot of Desires.*Pot of Greed/);
  const rps = prompt(YGOProMsgRockPaperScissors, { player: 0 });
  assert.equal(rps.prompt.kind, "rps");
  assert.deepEqual(labels(rps), ["Rock", "Paper", "Scissors"]);
  assert.deepEqual(bytes(rps, { choose: [2] }), [3]);
});

test("lobby prompts resolve to deck, hand and first-player actions", () => {
  const deck = lobbyPrompt("deck", { text: "Build your deck" });
  assert.deepEqual(resolveAnswer(deck, { submit: true }), { type: "deck" });
  assert.throws(() => resolveAnswer(deck, { choose: [1] }), /submit/);
  const side = lobbyPrompt("side", { text: "Side" });
  assert.deepEqual(resolveAnswer(side, { submit: true }), { type: "deck" });
  const rps = lobbyPrompt("rps");
  assert.deepEqual(resolveAnswer(rps, { choose: [1] }), { type: "hand", value: 1 });
  assert.deepEqual(resolveAnswer(rps, { choose: [3] }), { type: "hand", value: 2 });
  const first = lobbyPrompt("first");
  assert.deepEqual(first.options.map((option) => option.label), ["Go first", "Go second"]);
  assert.deepEqual(resolveAnswer(first, { choose: [2] }), { type: "tp", goFirst: false });
});

test("answers must fit the prompt: right field, option numbers in range, no repeats", () => {
  const built = prompt(YGOProMsgSelectCard, {
    player: 0, cancelable: 0, min: 1, max: 2, count: 2,
    cards: [{ code: BLUE_EYES, ...where(0, MZONE, 2), subsequence: 0 }, { code: DECODE, ...where(0, MZONE, 0), subsequence: 0 }],
  });
  assert.throws(() => resolveAnswer(built.prompt, { submit: true }), /choose/);
  assert.throws(() => resolveAnswer(built.prompt, { choose: [3] }), /1\.\.2/);
  assert.throws(() => resolveAnswer(built.prompt, { choose: [1, 1] }), /more than once/);
  assert.throws(() => resolveAnswer(built.prompt, { cancel: true }), /cannot be cancelled/);
  const yesno = prompt(YGOProMsgSelectYesNo, { player: 0, desc: 95 });
  assert.throws(() => resolveAnswer(yesno.prompt, { choose: [1, 2] }), /exactly one/);
  assert.throws(() => resolveAnswer(yesno.prompt, { choose: [] }), /exactly one/);
});

test("every response-bearing message in the codec has a prompt builder", async () => {
  const codec = await import("ygopro-msg-encode");
  const responseClasses = Object.values(codec).filter((value) => typeof value === "function"
    && value.prototype instanceof codec.YGOProMsgResponseBase && value.identifier > 0);
  assert.ok(responseClasses.length >= 20, `found ${responseClasses.length} response-bearing classes`);
  for (const MessageClass of responseClasses) assert.ok(supportsMessage(MessageClass), `${MessageClass.name} has no builder`);
});
