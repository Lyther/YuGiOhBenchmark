import assert from "node:assert/strict";
import test from "node:test";

import {
  OcgcoreCommonConstants as C,
  YGOProMsgMove,
  YGOProMsgSelectCard,
  YGOProMsgSelectSum,
  YGOProMsgSelectTribute,
  YGOProMsgStart,
  YGOProMsgUpdateCard,
} from "ygopro-msg-encode";

import { applyBoard, createBoard } from "../../src/game/board.js";
import { buildPrompt, lobbyPrompt } from "../../src/game/prompts/index.js";
import { renderSeat } from "../../src/mcp/render.js";
import { answerHelp, seatView } from "../../src/seat/view.js";
import { fixtureCatalog } from "../helpers/fixture-catalog.js";
import { gameMessage } from "../helpers/wire.js";

const catalog = await fixtureCatalog();
const BLUE_EYES = 89631139;
const UTOPIA = 84013237;

function duelBoard() {
  const start = gameMessage(YGOProMsgStart, {
    playerType: 1, duelRule: 5, startLp0: 8000, startLp1: 6000,
    player0: { deckCount: 30, extraCount: 15 }, player1: { deckCount: 31, extraCount: 1 },
  });
  let board = createBoard({ duel: 2, start });
  const move = (code, from, to) => {
    board = applyBoard(board, gameMessage(YGOProMsgMove, { code, previous: from, current: to, reason: 0 }));
  };
  move(BLUE_EYES, { controller: 1, location: C.LOCATION_DECK, sequence: 0, position: 0 }, { controller: 1, location: C.LOCATION_MZONE, sequence: 1, position: C.POS_FACEUP_ATTACK });
  move(0, { controller: 0, location: C.LOCATION_DECK, sequence: 0, position: 0 }, { controller: 0, location: C.LOCATION_SZONE, sequence: 2, position: C.POS_FACEDOWN });
  move(UTOPIA, { controller: 0, location: C.LOCATION_EXTRA, sequence: 0, position: 0 }, { controller: 0, location: C.LOCATION_MZONE, sequence: 5, position: C.POS_FACEUP_ATTACK });
  move(0, { controller: 0, location: C.LOCATION_DECK, sequence: 0, position: 0 }, { controller: 0, location: C.LOCATION_HAND, sequence: 0, position: C.POS_FACEDOWN });
  return board;
}

function state(overrides = {}) {
  return {
    phase: "duel", room: "M,TM0,NF#abc", name: "opus-seat", host: true, opponent: "gpt-seat",
    prompt: null, events: [], board: duelBoard(), delivered: { event: 0, boardVersion: -1 },
    match: { duel: 2, score: { me: 1, opponent: 0, draws: 0 } }, disconnect: null, waiting: null,
    ...overrides,
  };
}

const events = (count) => Array.from({ length: count }, (_, index) => ({ seq: index + 1, duel: 2, turn: 3, kind: "move", text: `event ${index + 1}` }));

test("the deck phase view names the room, the seat and the deck prompt, and has no board", () => {
  const prompt = { ...lobbyPrompt("deck", { text: "Submit your deck." }), seq: 1 };
  const { dto } = seatView(state({ phase: "deck", board: null, opponent: null, prompt }), { catalog });
  assert.equal(dto.phase, "deck");
  assert.equal(dto.room, "M,TM0,NF#abc");
  assert.deepEqual(dto.you, { name: "opus-seat", host: true });
  assert.equal(dto.opponent, null);
  assert.equal(dto.board, null);
  assert.equal(dto.disconnected, null);
  assert.deepEqual(dto.prompt, { seq: 1, kind: "deck", text: "Submit your deck.", options: [], answerHelp: 'answer {"submit": true}' });
  assert.match(dto.next, /submit/);
});

test("every event is delivered exactly once, in order, over any sequence of calls", () => {
  const seat = state({ events: events(5) });
  const first = seatView(seat, { catalog });
  assert.deepEqual(first.dto.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  seat.delivered = { ...first.cursor };
  seat.events.push(...events(8).slice(5));
  const second = seatView(seat, { catalog });
  assert.deepEqual(second.dto.events.map((event) => event.seq), [6, 7, 8]);
  seat.delivered = { ...second.cursor };
  assert.deepEqual(seatView(seat, { catalog }).dto.events, []);
  assert.deepEqual(Object.keys(second.dto.events[0]).sort(), ["kind", "seq", "text", "turn"]);
});

test("the board is sent when it changed or when asked for, from this player's side", () => {
  const seat = state();
  const first = seatView(seat, { catalog });
  const board = first.dto.board;
  assert.equal(board.duel, 2);
  assert.deepEqual(board.lp, { you: 6000, opponent: 8000 });
  assert.equal(board.you.monsters[1].name, "Blue-Eyes White Dragon");
  assert.equal(board.you.monsters[1].position, "faceup-attack");
  assert.equal(board.you.monsters[1].atk, undefined, "stats appear once the server reports them");
  assert.equal(board.opponent.spells[2].name, "face-down card");
  assert.equal(board.opponent.spells[2].code, undefined);
  assert.equal(board.opponent.monsters[5].name, "Number 39: Utopia");
  assert.deepEqual(board.opponent.hand, { count: 1, revealed: [] });
  assert.equal(board.you.deck, 30);
  assert.deepEqual(board.opponent.extra, { count: 14, faceUp: [] });
  seat.delivered = { ...first.cursor };
  assert.equal(seatView(seat, { catalog }).dto.board, null, "unchanged board is elided");
  assert.notEqual(seatView(seat, { catalog, full: true }).dto.board, null);
});

test("the model sees current Pendulum scales, targets, and face-up Extra Deck cards", () => {
  let board = duelBoard();
  board = applyBoard(board, gameMessage(YGOProMsgMove, {
    code: 16178681, previous: { controller: 1, location: C.LOCATION_HAND, sequence: 0, position: 0 },
    current: { controller: 1, location: C.LOCATION_SZONE, sequence: 0, position: C.POS_FACEUP_ATTACK }, reason: 0,
  }));
  board = applyBoard(board, gameMessage(YGOProMsgUpdateCard, {
    controller: 1, location: C.LOCATION_SZONE, sequence: 0, card: {
      flags: C.QUERY_LSCALE | C.QUERY_RSCALE | C.QUERY_TARGET_CARD,
      lscale: 1, rscale: 8,
      targetCards: [{ controller: 0, location: C.LOCATION_MZONE, sequence: 5, position: C.POS_FACEUP_ATTACK }],
    },
  }));
  board = applyBoard(board, gameMessage(YGOProMsgMove, {
    code: 16178681, previous: { controller: 1, location: C.LOCATION_HAND, sequence: 0, position: 0 },
    current: { controller: 1, location: C.LOCATION_EXTRA, sequence: 1, position: C.POS_FACEUP_DEFENSE }, reason: 0,
  }));
  const { dto } = seatView(state({ board }), { catalog });
  assert.deepEqual(dto.board.you.spells[0].scales, { left: 1, right: 8 });
  assert.deepEqual(dto.board.you.spells[0].targets, ["opponent's EMZ left"]);
  assert.equal(dto.board.you.extra[0].position, "facedown");
  assert.equal(dto.board.you.extra[1].position, "faceup");
  const text = renderSeat(dto);
  assert.match(text, /scales: 1\/8/);
  assert.match(text, /targets: opponent's EMZ left/);
  assert.match(text, /Extra:.*Odd-Eyes Pendulum Dragon faceup/);
});

test("the model sees a card's current Attribute, Type and card types, not only its printed ones", () => {
  const report = (board, { type, attribute, race }) => applyBoard(board, gameMessage(YGOProMsgUpdateCard, {
    controller: 1, location: C.LOCATION_MZONE, sequence: 1, card: { flags: C.QUERY_TYPE | C.QUERY_ATTRIBUTE | C.QUERY_RACE, type, attribute, race },
  }));
  const printed = report(duelBoard(), { type: C.TYPE_MONSTER | C.TYPE_NORMAL, attribute: C.ATTRIBUTE_LIGHT, race: C.RACE_DRAGON });
  // An effect turned the same Blue-Eyes into a DARK Zombie Effect Monster.
  const changed = report(printed, { type: C.TYPE_MONSTER | C.TYPE_EFFECT, attribute: C.ATTRIBUTE_DARK, race: C.RACE_ZOMBIE });
  const blueEyes = (board) => seatView(state({ board }), { catalog }).dto.board.you.monsters[1];
  assert.deepEqual([blueEyes(printed).attribute, blueEyes(printed).race, blueEyes(printed).types], ["Light", "Dragon", ["monster", "normal"]]);
  assert.deepEqual([blueEyes(changed).attribute, blueEyes(changed).race, blueEyes(changed).types], ["Dark", "Zombie", ["monster", "effect"]]);
  assert.match(renderSeat(seatView(state({ board: changed }), { catalog }).dto), /\[Blue-Eyes White Dragon faceup-attack, Dark \[Zombie\/Effect\]\]/);
});

test("prompt views keep the numbers the server judges by and say how to answer", () => {
  const board = duelBoard();
  const tribute = buildPrompt(gameMessage(YGOProMsgSelectTribute, {
    player: 1, cancelable: 0, min: 2, max: 2, count: 2, cards: [
      { code: BLUE_EYES, controller: 1, location: C.LOCATION_MZONE, sequence: 1, releaseParam: 2 },
      { code: UTOPIA, controller: 0, location: C.LOCATION_MZONE, sequence: 5, releaseParam: 1 },
    ],
  }), { board, catalog, hint: 500 }).prompt;
  const { dto } = seatView(state({ prompt: { ...tribute, seq: 9 } }), { catalog });
  assert.deepEqual(dto.prompt.options, [
    { n: 1, label: "Blue-Eyes White Dragon (your M2)", tributes: 2 },
    { n: 2, label: "Number 39: Utopia (opponent's EMZ left)", tributes: 1 },
  ]);
  assert.equal(dto.prompt.min, 2);
  assert.equal(dto.prompt.max, 2);
  assert.equal(dto.prompt.cancelable, false);
  assert.match(dto.prompt.answerHelp, /choose/);
  assert.equal(dto.prompt.source, undefined);
  const cancelable = buildPrompt(gameMessage(YGOProMsgSelectCard, {
    player: 1, cancelable: 1, min: 1, max: 1, count: 1, cards: [{ code: BLUE_EYES, controller: 1, location: C.LOCATION_MZONE, sequence: 1, subsequence: 0 }],
  }), { board, catalog, hint: null }).prompt;
  const cancelView = seatView(state({ prompt: { ...cancelable, seq: 10 } }), { catalog }).dto.prompt;
  assert.match(cancelView.answerHelp, /cancel/);
});

test("a sum with mandatory cards says an empty choice is allowed", () => {
  const where = (sequence) => ({ controller: 0, location: C.LOCATION_MZONE, sequence });
  const message = (mustSelectCards) => gameMessage(YGOProMsgSelectSum, {
    mode: 0, player: 0, sumVal: 7, min: 0, max: 1, mustSelectCount: mustSelectCards.length, mustSelectCards,
    count: 1, cards: [{ code: UTOPIA, ...where(1), opParam: 4 }],
  });
  const help = (cards) => answerHelp(buildPrompt(message(cards), { board: duelBoard(), catalog, hint: null }).prompt);
  assert.match(help([{ code: BLUE_EYES, ...where(0), opParam: 7 }]), /\[\] when the mandatory cards alone meet it/);
  assert.doesNotMatch(help([]), /\[\]/);
});

test("no internal field crosses the boundary", () => {
  const { dto } = seatView(state({ events: events(2) }), { catalog, full: true });
  const text = JSON.stringify(dto);
  for (const internal of ['"source"', '"refs"', '"catalog"', '"lastPrompt"', '"delivered"', '"version"']) {
    assert.equal(text.includes(internal), false, `${internal} leaked`);
  }
  assert.equal("me" in dto.board, false, "no absolute player id in the board");
  assert.deepEqual(Object.keys(dto.board).sort(), ["chain", "duel", "lp", "opponent", "phase", "turn", "turnPlayer", "you"]);
});

test("next tells the model what to call in each state", () => {
  assert.match(seatView(state(), { catalog }).dto.next, /wait/);
  assert.match(seatView(state({ phase: "ended", board: null }), { catalog }).dto.next, /over/);
  assert.match(seatView(state({ phase: "disconnected", disconnect: { reason: "server-closed" } }), { catalog }).dto.next, /disconnected/);
  assert.equal(seatView(state({ phase: "disconnected", disconnect: { reason: "server-closed" } }), { catalog }).dto.disconnected, "server-closed");
  assert.equal(seatView(state({ waiting: "server" }), { catalog }).dto.waiting, "server");
  assert.equal(seatView(state(), { catalog }).dto.waiting, "opponent");
  const rejoining = seatView(state({ waiting: "rejoin" }), { catalog }).dto;
  assert.equal(rejoining.waiting, "rejoin");
  assert.match(rejoining.next, /rejoining the match; call wait/);
});

test("deck views group copies by code in first-seen order with section counts", async () => {
  const { deckView } = await import("../../src/seat/view.js");
  const view = deckView({ main: [89631139, 46986414, 89631139], extra: [84013237], side: [] }, catalog);
  assert.deepEqual(view, {
    main: [{ code: 89631139, name: "Blue-Eyes White Dragon", count: 2 }, { code: 46986414, name: "Dark Magician", count: 1 }],
    extra: [{ code: 84013237, name: "Number 39: Utopia", count: 1 }],
    side: [],
    counts: { main: 3, extra: 1, side: 0 },
  });
});
