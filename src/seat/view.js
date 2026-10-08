import { OcgcoreCommonConstants as C } from "ygopro-msg-encode";

import { effectText } from "../game/events.js";
import { cardName, phaseLabel, positionLabel, zoneLabel } from "../game/labels.js";

const SINGLE_CHOICE = new Set(["command", "battle", "chain", "yesno", "effect", "option", "position", "number", "rps", "first"]);
const PROMPT_FIELDS = ["min", "max", "sumTarget", "sumMode", "total"];

function eventView({ seq, turn, kind, text, from }) {
  return from ? { seq, turn, kind, text, from } : { seq, turn, kind, text };
}

function choiceHelp(prompt) {
  if (prompt.kind === "tribute") return `answer {"choose": [n, ...]}: at most ${prompt.max} cards worth at least ${prompt.min} tributes`;
  if (prompt.kind === "sum") {
    const empty = prompt.mustInclude.length ? ", or [] when the mandatory cards alone meet it" : "";
    return `answer {"choose": [n, ...]} with the non-mandatory cards only${empty}`;
  }
  const range = prompt.min === prompt.max ? `${prompt.min}` : `${prompt.min} to ${prompt.max}`;
  return `answer {"choose": [n, ...]} with ${range} numbers`;
}

export function answerHelp(prompt) {
  if (prompt.kind === "deck" || prompt.kind === "side") return 'answer {"submit": true}';
  if (prompt.kind === "declare") return 'answer {"card": "exact card name or code"}';
  if (prompt.kind === "counter") return `answer {"counts": [{"option": n, "count": k}, ...]} adding up to ${prompt.total}`;
  if (prompt.kind === "sort") return 'answer {"choose": [every n, in the new order]}, or {"cancel": true} to keep the order';
  if (SINGLE_CHOICE.has(prompt.kind)) return 'answer {"choose": [n]}';
  if (prompt.kind === "unselect") {
    const extra = [prompt.finishable && '{"finish": true}', prompt.cancelable && '{"cancel": true}'].filter(Boolean);
    return `answer {"choose": [n]}${extra.length ? `, or ${extra.join(" or ")}` : ""}`;
  }
  return `${choiceHelp(prompt)}${prompt.cancelable ? ', or {"cancel": true}' : ""}`;
}

function optionView(option) {
  const view = { n: option.n, label: option.label };
  for (const key of ["tributes", "values", "counters"]) {
    if (option[key] !== undefined) view[key] = option[key];
  }
  return view;
}

function promptView(prompt) {
  const view = { seq: prompt.seq, kind: prompt.kind, text: prompt.text, options: prompt.options.map(optionView) };
  for (const key of PROMPT_FIELDS) {
    if (prompt[key] !== undefined) view[key] = prompt[key];
  }
  if (prompt.mustInclude?.length) view.mustInclude = prompt.mustInclude;
  if (prompt.cancelable !== undefined) view.cancelable = prompt.cancelable;
  if (prompt.finishable !== undefined) view.finishable = prompt.finishable;
  if (prompt.rejected) view.rejected = prompt.rejected;
  view.answerHelp = answerHelp(prompt);
  return view;
}

function cardRef(card, zone, catalog) {
  const ref = { name: cardName(card.code, catalog) };
  if (card.code) ref.code = card.code;
  if (zone === "monster" || zone === "spell") ref.position = positionLabel(card.position, zone);
  if (zone === "extra" || zone === "banished") ref.position = card.position & C.POS_FACEUP ? "faceup" : "facedown";
  if (card.attack !== undefined) ref.atk = card.attack;
  if (card.defense !== undefined) ref.def = card.defense;
  for (const key of ["level", "rank", "link"]) {
    if (card[key]) ref[key] = card[key];
  }
  if (card.counters?.length) {
    ref.counters = card.counters.map(({ type, count }) => ({ name: catalog.counterName(type) ?? `counter 0x${type.toString(16)}`, count }));
  }
  if (card.overlays?.length) ref.materials = card.overlays.map((code) => cardName(code, catalog));
  if (card.equippedTo) ref.equippedTo = zoneLabel(card.equippedTo);
  if (card.targets?.length) ref.targets = card.targets.map(zoneLabel);
  if (card.scales) ref.scales = { ...card.scales };
  if (card.negated) ref.negated = true;
  return ref;
}

function sideView(side, owner, catalog) {
  const refs = (cards, zone) => cards.map((card) => (card ? cardRef(card, zone, catalog) : null));
  const view = {
    hand: refs(side.hand, "hand"),
    monsters: refs(side.monsters, "monster"),
    spells: refs(side.spells, "spell"),
    deck: side.deck,
    extra: refs(side.extra, "extra"),
    grave: refs(side.grave, "grave"),
    banished: refs(side.banished, "banished"),
  };
  if (owner === "opponent") {
    view.hand = { count: side.hand.length, revealed: refs(side.hand.filter((card) => card.code), "hand") };
    const faceUp = side.extra.filter((card) => card.code && card.position & C.POS_FACEUP);
    view.extra = { count: side.extra.length, faceUp: refs(faceUp, "extra") };
  }
  return view;
}

function chainView(board, catalog) {
  return board.chain.map((link, index) => {
    const view = {
      n: index + 1,
      card: { name: cardName(link.code, catalog), code: link.code || undefined, where: zoneLabel(link.card) },
      effect: effectText(catalog, link.desc, link.code),
      by: link.controller === "me" ? "you" : "opponent",
    };
    if (!view.card.code) delete view.card.code;
    if (link.negated) view.negated = true;
    return view;
  });
}

function boardView(board, catalog) {
  return {
    duel: board.duel,
    turn: board.turn,
    phase: phaseLabel(board.phase),
    turnPlayer: board.turnPlayer === "me" ? "you" : board.turnPlayer,
    lp: { you: board.lp.me, opponent: board.lp.opponent },
    you: sideView(board.sides.me, "me", catalog),
    opponent: sideView(board.sides.opponent, "opponent", catalog),
    chain: chainView(board, catalog),
  };
}

function waitingOf(state) {
  if (state.prompt || ["deck", "ended", "disconnected"].includes(state.phase)) return null;
  return state.waiting === "server" || state.waiting === "rejoin" ? state.waiting : "opponent";
}

function nextSentence(state) {
  if (state.phase === "disconnected") return `The seat is disconnected (${state.disconnect?.reason}); this match cannot continue.`;
  if (state.phase === "ended") return "The match is over; stop calling tools.";
  const prompt = state.prompt;
  if (prompt?.kind === "deck") return 'Submit your deck: answer {"submit": true}.';
  if (prompt?.kind === "side") return 'Side Deck: submit with answer {"submit": true} when ready.';
  if (prompt) return `Answer prompt ${prompt.seq}: ${answerHelp(prompt)}.`;
  if (state.waiting === "server") return "The server is finishing the match; call wait.";
  if (state.waiting === "rejoin") return "The seat lost its connection and is rejoining the match; call wait.";
  return "The opponent or the server is acting; call wait.";
}

// The only place seat state becomes a boundary shape (contracts.md SeatView).
// Returns the DTO and the cursor to mark as delivered.
export function seatView(state, { catalog, full = false }) {
  const board = state.board;
  const sendBoard = Boolean(board) && (full || board.version > state.delivered.boardVersion);
  const pending = state.events.filter((event) => event.seq > state.delivered.event);
  const dto = {
    phase: state.phase,
    room: state.room,
    you: { name: state.name, host: state.host },
    opponent: state.opponent,
    match: { duel: state.match.duel, score: { ...state.match.score } },
    board: sendBoard ? boardView(board, catalog) : null,
    boardVersion: board ? board.version : null,
    events: pending.map(eventView),
    prompt: state.prompt ? promptView(state.prompt) : null,
    waiting: waitingOf(state),
    disconnected: state.disconnect?.reason ?? null,
    next: nextSentence(state),
  };
  const cursor = {
    event: pending.at(-1)?.seq ?? state.delivered.event,
    boardVersion: sendBoard ? board.version : state.delivered.boardVersion,
  };
  return { dto, cursor };
}

function deckEntries(codes, catalog) {
  const counts = new Map();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({ code, name: cardName(code, catalog), count }));
}

// The DeckView DTO (contracts.md): copies grouped by code in first-seen order.
export function deckView(deck, catalog) {
  return {
    main: deckEntries(deck.main, catalog),
    extra: deckEntries(deck.extra, catalog),
    side: deckEntries(deck.side, catalog),
    counts: { main: deck.main.length, extra: deck.extra.length, side: deck.side.length },
  };
}
