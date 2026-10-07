import {
  OcgcoreCommonConstants as C,
  YGOProMsgAddCounter,
  YGOProMsgCancelTarget,
  YGOProMsgCardTarget,
  YGOProMsgChainDisabled,
  YGOProMsgChainEnd,
  YGOProMsgChainNegated,
  YGOProMsgChainSolved,
  YGOProMsgChaining,
  YGOProMsgConfirmCards,
  YGOProMsgDamage,
  YGOProMsgDraw,
  YGOProMsgEquip,
  YGOProMsgFlipSummoning,
  YGOProMsgLpUpdate,
  YGOProMsgMove,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgPayLpCost,
  YGOProMsgPosChange,
  YGOProMsgRecover,
  YGOProMsgRemoveCounter,
  YGOProMsgSet,
  YGOProMsgShuffleExtra,
  YGOProMsgShuffleHand,
  YGOProMsgShuffleSetCard,
  YGOProMsgSpSummoning,
  YGOProMsgSummoning,
  YGOProMsgSwap,
  YGOProMsgSwapGraveDeck,
  YGOProMsgUnequip,
  YGOProMsgUpdateCard,
  YGOProMsgUpdateData,
} from "ygopro-msg-encode";

const MONSTER_SLOTS = 7;
const SPELL_SLOTS = 8;
// A query chunk of exactly its 4-byte length field is an empty slot; a longer
// chunk with no flags is a card the server hid from this player.
const EMPTY_QUERY_LENGTH = 4;
const LISTS = Object.freeze({
  [C.LOCATION_HAND]: "hand", [C.LOCATION_GRAVE]: "grave", [C.LOCATION_REMOVED]: "banished", [C.LOCATION_EXTRA]: "extra",
});
export const ZONE_NAMES = Object.freeze({
  [C.LOCATION_DECK]: "deck", [C.LOCATION_HAND]: "hand", [C.LOCATION_MZONE]: "monster", [C.LOCATION_SZONE]: "spell",
  [C.LOCATION_GRAVE]: "grave", [C.LOCATION_REMOVED]: "banished", [C.LOCATION_EXTRA]: "extra",
});

export function cardCode(raw) {
  return ((raw ?? 0) >>> 0) & 0x7fffffff;
}

function isPublic(raw) {
  return (((raw ?? 0) >>> 0) & 0x80000000) !== 0;
}

function unknownCard() {
  return { code: 0, position: C.POS_FACEDOWN };
}

function emptySide(info) {
  return {
    hand: [],
    monsters: Array(MONSTER_SLOTS).fill(null),
    spells: Array(SPELL_SLOTS).fill(null),
    deck: info.deckCount,
    extra: Array.from({ length: info.extraCount }, unknownCard),
    grave: [],
    banished: [],
  };
}

// `version` continues from the previous duel's board so one delivery cursor
// covers a whole match.
export function createBoard({ duel, start, version = 0 }) {
  const me = start.playerType & 0x0f;
  const players = [start.player0, start.player1];
  const lp = [start.startLp0, start.startLp1];
  return {
    duel, me, turn: 0, phase: 0, turnPlayer: null,
    lp: { me: lp[me], opponent: lp[1 - me] },
    sides: { me: emptySide(players[me]), opponent: emptySide(players[1 - me]) },
    chain: [],
    version,
  };
}

export function who(board, player) {
  return player === board.me ? "me" : "opponent";
}

function side(board, player) {
  return board.sides[who(board, player)];
}

export function zoneRef(board, { controller, location, sequence }) {
  return { side: who(board, controller), zone: ZONE_NAMES[location] ?? "unknown", index: sequence };
}

function slots(state, location) {
  if (location === C.LOCATION_MZONE) return state.monsters;
  if (location === C.LOCATION_SZONE) return state.spells;
  return null;
}

export function cardAt(board, controller, location, sequence) {
  const state = side(board, controller);
  const fixed = slots(state, location);
  if (fixed) return fixed[sequence] ?? null;
  return state[LISTS[location]]?.[sequence] ?? null;
}

function setAt(board, { controller, location, sequence }, card) {
  const state = side(board, controller);
  const fixed = slots(state, location);
  if (fixed) fixed[sequence] = card;
  else if (LISTS[location] && state[LISTS[location]][sequence]) state[LISTS[location]][sequence] = card;
}

function take(board, { controller, location, sequence }) {
  const state = side(board, controller);
  if (location === C.LOCATION_DECK) {
    state.deck = Math.max(0, state.deck - 1);
    return null;
  }
  const fixed = slots(state, location);
  if (fixed) {
    const card = fixed[sequence] ?? null;
    fixed[sequence] = null;
    return card;
  }
  const list = state[LISTS[location]];
  if (!list?.length) return null;
  return list.splice(Math.min(sequence, list.length - 1), 1)[0];
}

function put(board, { controller, location, sequence }, card) {
  const state = side(board, controller);
  if (location === C.LOCATION_DECK) {
    state.deck += 1;
    return;
  }
  const fixed = slots(state, location);
  if (fixed) {
    fixed[sequence] = card;
    return;
  }
  const list = state[LISTS[location]];
  if (list) list.splice(Math.min(sequence, list.length), 0, card);
}

const onField = (location) => location === C.LOCATION_MZONE || location === C.LOCATION_SZONE;

function host(board, { controller, sequence }) {
  return side(board, controller).monsters[sequence] ?? null;
}

function move(board, message) {
  const code = cardCode(message.code);
  const from = message.previous;
  const to = message.current;
  let card = null;
  if (from.location & C.LOCATION_OVERLAY) {
    const xyz = host(board, from);
    if (xyz?.overlays) xyz.overlays.splice(Math.min(from.position, xyz.overlays.length - 1), 1);
  } else if (from.location) {
    card = take(board, from);
  }
  if (!to.location) return;
  if (to.location & C.LOCATION_OVERLAY) {
    const xyz = host(board, to);
    if (xyz) (xyz.overlays ??= []).splice(to.position, 0, code);
    return;
  }
  const keep = card && onField(from.location) && onField(to.location);
  put(board, to, { ...(keep ? card : {}), code, position: to.position });
}

function draw(board, { player, cards }) {
  const state = side(board, player);
  state.deck = Math.max(0, state.deck - cards.length);
  for (const raw of cards) state.hand.push({ code: cardCode(raw), position: isPublic(raw) ? C.POS_FACEUP : C.POS_FACEDOWN });
}

function mergeQuery(board, previous, query) {
  if (!query || (query.queryLength ?? 0) <= EMPTY_QUERY_LENGTH) return null;
  if (!query.flags) return previous ?? unknownCard();
  const card = previous ? { ...previous } : unknownCard();
  if (query.code !== undefined) card.code = cardCode(query.code);
  if (query.position !== undefined) card.position = query.position;
  for (const [from, to] of [["attack", "attack"], ["defense", "defense"], ["level", "level"], ["rank", "rank"], ["link", "link"]]) {
    if (query[from] !== undefined) card[to] = query[from];
  }
  if (query.lscale !== undefined || query.rscale !== undefined) {
    card.scales = { left: query.lscale ?? card.scales?.left ?? 0, right: query.rscale ?? card.scales?.right ?? 0 };
  }
  if (query.counters) card.counters = query.counters.filter(({ count }) => count > 0).map(({ type, count }) => ({ type, count }));
  if (query.overlayCards) card.overlays = query.overlayCards.map(cardCode);
  if (query.equipCard?.location) card.equippedTo = zoneRef(board, query.equipCard);
  if (query.targetCards) card.targets = query.targetCards.map((target) => zoneRef(board, target));
  if (query.status !== undefined) card.negated = (query.status & C.STATUS_DISABLED) !== 0;
  return card;
}

function updateData(board, { player, location, cards }) {
  const state = side(board, player);
  const fixed = slots(state, location);
  if (fixed) {
    for (let index = 0; index < fixed.length; index += 1) fixed[index] = mergeQuery(board, fixed[index], cards[index]);
  } else if (LISTS[location]) {
    const previous = state[LISTS[location]];
    state[LISTS[location]] = cards.map((query, index) => mergeQuery(board, previous[index], query) ?? unknownCard());
  } else if (location === C.LOCATION_DECK) {
    state.deck = cards.length;
  }
}

function updateCard(board, message) {
  const merged = mergeQuery(board, cardAt(board, message.controller, message.location, message.sequence), message.card);
  if (merged) setAt(board, message, merged);
}

function reveal(board, { code, controller, location, sequence, position }) {
  const card = cardAt(board, controller, location, sequence);
  if (!card) return;
  if (cardCode(code)) card.code = cardCode(code);
  if (position !== undefined) card.position = position;
}

function positionChange(board, { code, card: where, currentPosition }) {
  const card = cardAt(board, where.controller, where.location, where.sequence);
  if (!card) return;
  card.position = currentPosition;
  if (cardCode(code)) card.code = cardCode(code);
}

function swap(board, { code1, card1, code2, card2 }) {
  const first = cardAt(board, card1.controller, card1.location, card1.sequence);
  const second = cardAt(board, card2.controller, card2.location, card2.sequence);
  setAt(board, card2, first && { ...first, code: cardCode(code1) || first.code });
  setAt(board, card1, second && { ...second, code: cardCode(code2) || second.code });
}

function chaining(board, message) {
  const card = cardAt(board, message.controller, message.location, message.sequence);
  if (card && !card.code) card.code = cardCode(message.code);
  board.chain.push({
    card: zoneRef(board, message),
    code: cardCode(message.code),
    desc: message.desc,
    controller: who(board, message.chainCardLocation.controller),
  });
}

function markNegated(board, { chainCount }) {
  const link = board.chain[chainCount - 1];
  if (link) link.negated = true;
}

function counter(board, { counterType, controller, location, sequence, count }, sign) {
  const card = cardAt(board, controller, location, sequence);
  if (!card) return;
  const counters = (card.counters ?? []).map((entry) => ({ ...entry }));
  const entry = counters.find(({ type }) => type === counterType);
  if (entry) entry.count += sign * count;
  else if (sign > 0) counters.push({ type: counterType, count });
  card.counters = counters.filter((item) => item.count > 0);
}

function sameRef(a, b) {
  return a.side === b.side && a.zone === b.zone && a.index === b.index;
}

function target(board, { card1, card2 }, adding) {
  const owner = cardAt(board, card1.controller, card1.location, card1.sequence);
  if (!owner) return;
  const ref = zoneRef(board, card2);
  const others = (owner.targets ?? []).filter((existing) => !sameRef(existing, ref));
  owner.targets = adding ? [...others, ref] : others;
}

function shuffleHand(board, { player, cards }) {
  const state = side(board, player);
  state.hand = cards.map((raw, index) => ({ ...(state.hand[index] ?? unknownCard()), code: cardCode(raw), position: C.POS_FACEDOWN }));
}

function shuffleExtra(board, { player, cards }) {
  const state = side(board, player);
  let next = 0;
  state.extra = state.extra.map((card) => (card.position & C.POS_FACEUP ? card : { ...card, code: cardCode(cards[next++]) }));
}

function shuffleSetCards(board, { cards }) {
  const moved = cards.map(({ oldLocation }) => {
    const card = cardAt(board, oldLocation.controller, oldLocation.location, oldLocation.sequence);
    if (card) card.code = 0;
    return card;
  });
  // A zero destination hides the permutation; the occupied slots stay put.
  // Material-bearing cards have disclosed destinations. Follow the stock
  // client's swaps so displaced cards and their materials stay on the field.
  cards.forEach(({ newLocation }, index) => {
    if (!newLocation.location || !moved[index]) return;
    const field = slots(side(board, newLocation.controller), newLocation.location);
    const from = field.indexOf(moved[index]);
    const to = newLocation.sequence;
    [field[from], field[to]] = [field[to], field[from]];
  });
}

// The engine returns Fusion/Synchro/Xyz/Link cards to the Extra Deck, before
// its face-up Pendulums. The following grave snapshot reveals the old Deck.
function swapGraveDeck(board, { player }, { catalog }) {
  const state = side(board, player);
  const returning = state.grave.filter((card) => catalog.isExtraDeck(card.code));
  const deckCount = state.grave.length - returning.length;
  const faceUp = state.extra.findIndex((card) => card.position & C.POS_FACEUP);
  state.extra.splice(faceUp < 0 ? state.extra.length : faceUp, 0,
    ...returning.map(({ code }) => ({ code, position: C.POS_FACEDOWN_DEFENSE })));
  state.grave = Array.from({ length: state.deck }, () => ({ code: 0, position: C.POS_FACEUP }));
  state.deck = deckCount;
}

function lifePoints(board, player, change) {
  const key = who(board, player);
  board.lp[key] = Math.max(0, change(board.lp[key]));
}

const HANDLERS = new Map([
  [YGOProMsgMove, move],
  [YGOProMsgDraw, draw],
  [YGOProMsgUpdateData, updateData],
  [YGOProMsgUpdateCard, updateCard],
  [YGOProMsgPosChange, positionChange],
  [YGOProMsgSet, reveal],
  [YGOProMsgSummoning, reveal],
  [YGOProMsgSpSummoning, reveal],
  [YGOProMsgFlipSummoning, reveal],
  [YGOProMsgSwap, swap],
  [YGOProMsgChaining, chaining],
  [YGOProMsgChainSolved, (board, { chainCount }) => { board.chain = board.chain.filter((_, index) => index !== chainCount - 1); }],
  [YGOProMsgChainNegated, markNegated],
  [YGOProMsgChainDisabled, markNegated],
  [YGOProMsgChainEnd, (board) => { board.chain = []; }],
  [YGOProMsgNewTurn, (board, { player }) => { board.turn += 1; board.turnPlayer = who(board, player); }],
  [YGOProMsgNewPhase, (board, { phase }) => { board.phase = phase; }],
  [YGOProMsgLpUpdate, (board, { player, lp }) => lifePoints(board, player, () => lp)],
  [YGOProMsgDamage, (board, { player, value }) => lifePoints(board, player, (lp) => lp - value)],
  [YGOProMsgPayLpCost, (board, { player, cost }) => lifePoints(board, player, (lp) => lp - cost)],
  [YGOProMsgRecover, (board, { player, value }) => lifePoints(board, player, (lp) => lp + value)],
  [YGOProMsgAddCounter, (board, message) => counter(board, message, 1)],
  [YGOProMsgRemoveCounter, (board, message) => counter(board, message, -1)],
  [YGOProMsgEquip, (board, { equip, target: to }) => {
    const card = cardAt(board, equip.controller, equip.location, equip.sequence);
    if (card) card.equippedTo = zoneRef(board, to);
  }],
  [YGOProMsgUnequip, (board, { card: where }) => {
    const card = cardAt(board, where.controller, where.location, where.sequence);
    if (card) delete card.equippedTo;
  }],
  [YGOProMsgCardTarget, (board, message) => target(board, message, true)],
  [YGOProMsgCancelTarget, (board, message) => target(board, message, false)],
  [YGOProMsgConfirmCards, (board, { cards }) => cards.forEach((card) => reveal(board, { ...card, position: undefined }))],
  [YGOProMsgShuffleHand, shuffleHand],
  [YGOProMsgShuffleExtra, shuffleExtra],
  [YGOProMsgShuffleSetCard, shuffleSetCards],
  [YGOProMsgSwapGraveDeck, swapGraveDeck],
]);

// Pure reducer: returns a new board for a board-changing message, otherwise the input.
export function applyBoard(board, message, context = {}) {
  const handler = HANDLERS.get(message?.constructor);
  if (!handler) return board;
  const next = structuredClone(board);
  handler(next, message, context);
  next.version = board.version + 1;
  return next;
}
