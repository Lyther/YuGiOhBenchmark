import { z } from "zod";

import { TYPE_VOCABULARY } from "../cards/catalog.js";
import { applyEdits, DeckEditError, exportDeck } from "../deck/deck.js";
import { AnswerError } from "../game/prompts/index.js";
import { SeatError } from "../seat/controller.js";
import { deckView, seatView } from "../seat/view.js";
import { renderCard, renderDeck, renderSearch, renderSeat } from "./render.js";

// Claude Code keeps results up to this size inline instead of saving them to
// a file (architecture D-01); other clients ignore the key.
export const MAX_RESULT_CHARS = 500_000;
const META = Object.freeze({ "anthropic/maxResultSizeChars": MAX_RESULT_CHARS });
const ANSWER_FIELDS = ["choose", "counts", "card", "submit", "cancel", "finish"];

const format = z.enum(["text", "json"]).optional().describe("text (default) or json: the same view as JSON");
const integer = z.number().int();

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

function failure(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function viewResult(seat, { full = false, format: shape = "text" } = {}) {
  const { dto, cursor } = seatView(seat.snapshot(), { catalog: seat.catalog, full });
  seat.markDelivered(cursor);
  return text(shape === "json" ? JSON.stringify(dto) : renderSeat(dto));
}

function nextHint(seat) {
  return seatView(seat.snapshot(), { catalog: seat.catalog }).dto.next;
}

// Seat-state and answer problems become isError results with the next step;
// anything else is logged and reported as an internal error.
function guarded(seat, log, handler) {
  return async (args) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      if (error instanceof SeatError || error instanceof AnswerError || error instanceof DeckEditError) {
        return failure(`${error.message}. Next: ${nextHint(seat)}`);
      }
      log.error({ err: error }, "tool failed");
      return failure(`internal error: ${error.message}`);
    }
  };
}

function cardLookup(catalog, { code, name, format: shape }) {
  if ((code === undefined) === (name === undefined)) throw new SeatError("give exactly one of code or name");
  let card = code !== undefined ? catalog.info(code) : null;
  if (name !== undefined) {
    const found = catalog.findByName(name);
    if (!found.card) {
      const hint = found.suggestions.length ? `; did you mean: ${found.suggestions.join(", ")}` : "";
      throw new SeatError(`no card named "${name}"${hint}`);
    }
    card = catalog.info(found.card.code);
  }
  if (!card) throw new SeatError(`no card with code ${code} in the local card data`);
  return text(shape === "json" ? JSON.stringify(card) : renderCard(card));
}

const cardRef = z.union([integer.positive(), z.string().min(1)]).describe("card code or card name");
const deckSection = z.enum(["main", "extra", "side"]);
const deckEdit = z.object({
  card: cardRef,
  count: integer.min(1).max(60).optional().describe("copies, default 1"),
  section: deckSection.optional().describe("default: extra for Fusion/Synchro/Xyz/Link, otherwise main"),
});
const deckMove = z.object({ card: cardRef, count: integer.min(1).max(60).optional(), from: deckSection, to: deckSection });

function showDeck(seat, catalog, shape = "text") {
  const deck = seat.snapshot().deck;
  if (shape === "text") return text(renderDeck(deckView(deck, catalog)));
  if (shape === "json") return text(JSON.stringify(deckView(deck, catalog)));
  return text(exportDeck(deck, shape));
}

const searchSchema = z.object({
  text: z.string().min(1).optional().describe("words in the card text, case-insensitive"),
  name: z.string().min(1).optional().describe("part of the card name, case-insensitive"),
  kind: z.enum(["monster", "spell", "trap"]).optional(),
  types: z.array(z.enum(TYPE_VOCABULARY)).optional().describe("all of these type words must match"),
  attribute: z.string().min(1).optional().describe("for example Light or Dark"),
  race: z.string().min(1).optional().describe("monster type, for example Dragon or Spellcaster"),
  setname: z.string().min(1).optional().describe("archetype name, for example HERO"),
  level: integer.optional().describe("level, rank or link rating"),
  levelMin: integer.optional(),
  levelMax: integer.optional(),
  atkMin: integer.optional(),
  atkMax: integer.optional(),
  defMin: integer.optional(),
  defMax: integer.optional(),
  limit: integer.min(1).max(50).optional().describe("page size, default 20"),
  offset: integer.min(0).optional().describe("cards to skip, default 0"),
  format,
});

const answerSchema = z.object({
  choose: z.array(integer).optional().describe("option numbers from the prompt"),
  counts: z.array(z.object({ option: integer, count: integer.min(0) })).optional().describe("counters to remove per option"),
  card: z.union([integer.positive(), z.string().min(1)]).optional().describe("card code or exact name to declare"),
  submit: z.literal(true).optional().describe("send the deck"),
  cancel: z.literal(true).optional(),
  finish: z.literal(true).optional(),
  format,
});

const deckEditSchema = z.object({
  import: z.string().min(1).optional(),
  clear: z.boolean().optional(),
  remove: z.array(deckEdit).optional(),
  add: z.array(deckEdit).optional(),
  move: z.array(deckMove).optional(),
  format: z.enum(["text", "json"]).optional(),
});

function playTools(seat) {
  return [
    ["wait", {
      description: "Wait for your next decision. Returns the seat view: phase, board, new events (chat included) and the open prompt. "
        + "Returns at once when a prompt is open; otherwise blocks until something happens or the wait budget ends, then call it again.",
      inputSchema: z.object({ full: z.boolean().optional().describe("include the board even if unchanged"), format }),
    }, async (args) => {
      await seat.wait();
      return viewResult(seat, args);
    }],
    ["answer", {
      description: "Answer the open prompt with exactly one field, as its answerHelp says: choose (option numbers), counts (counters per option), "
        + "card (a card name or code to declare), submit (deck or side deck), cancel, or finish. Then waits like wait and returns the next view.",
      inputSchema: answerSchema,
    }, async (args) => {
      await seat.answer(Object.fromEntries(ANSWER_FIELDS.filter((field) => args[field] !== undefined).map((field) => [field, args[field]])));
      return viewResult(seat, args);
    }],
  ];
}

function deckTools(seat, catalog) {
  return [
    ["deck_show", {
      description: "Show the working deck: the one the next deck or side submit sends. format ydk, ydke or code exports it in that deck format.",
      inputSchema: z.object({ format: z.enum(["text", "json", "ydk", "ydke", "code"]).optional() }),
      annotations: { readOnlyHint: true },
    }, async ({ format: shape }) => showDeck(seat, catalog, shape)],
    ["deck_edit", {
      description: "Edit the working deck. Steps run in this order: import (YDK text, a ydke:// URL or a KoishiPro deck code replaces the deck), "
        + "clear, remove, add, move. Cards are codes or names (exact, or a unique prefix). All steps apply or none. "
        + "Edits are allowed in any phase; the server checks the deck when it is submitted.",
      inputSchema: deckEditSchema,
    }, async ({ format: shape, ...edits }) => {
      seat.setDeck(applyEdits(seat.snapshot().deck, edits, catalog));
      return showDeck(seat, catalog, shape);
    }],
  ];
}

function cardTools(catalog) {
  return [
    ["card", {
      description: "Look up one card by code or by name (exact, or a unique prefix): text, stats, archetypes, and where the text came from.",
      inputSchema: z.object({ code: integer.positive().optional(), name: z.string().min(1).optional(), format }),
      annotations: { readOnlyHint: true },
    }, async (args) => cardLookup(catalog, args)],
    ["card_search", {
      description: "Search the local card pool by text, name, kind, type words, attribute, monster type, archetype, level and ATK/DEF. "
        + "Results are ordered by name and paged; the total is always reported.",
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true },
    }, async ({ format: shape, ...filters }) => {
      const result = catalog.search(filters);
      return text(shape === "json" ? JSON.stringify(result) : renderSearch(result));
    }],
  ];
}

function roomTools(seat) {
  return [
    ["chat", {
      description: "Send one chat line to the room (1-255 characters). Lines starting with / are server commands. Replies arrive as chat events.",
      inputSchema: z.object({ text: z.string().min(1).max(255) }),
    }, async ({ text: line }) => {
      const { sent } = seat.chat(line);
      const pending = seat.snapshot().events.length - seat.snapshot().delivered.event;
      return text(`Sent: ${sent}\nUndelivered events: ${pending}; call wait to read them.`);
    }],
    ["surrender", {
      description: "Surrender the current duel. Then waits like wait and returns the next view.",
      inputSchema: z.object({ format }),
    }, async (args) => {
      await seat.surrender();
      return viewResult(seat, args);
    }],
  ];
}

// The tool list, in contract order. A tool is listed only once it works.
export function seatTools({ seat, catalog, log }) {
  const definitions = [...playTools(seat), ...deckTools(seat, catalog), ...cardTools(catalog), ...roomTools(seat)];
  return definitions.map(([name, config, handler]) => ({ name, config: { ...config, _meta: META }, handler: guarded(seat, log, handler) }));
}
