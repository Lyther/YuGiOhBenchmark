import { OcgcoreCommonConstants as C } from "ygopro-msg-encode";

import { cardAt, cardCode, zoneRef } from "../board.js";
import { effectText } from "../events.js";
import { cardName, zoneLabel } from "../labels.js";

// An answer that does not fit the pending prompt; nothing is sent.
export class AnswerError extends Error {}

const ANSWER_FIELDS = ["choose", "counts", "card", "submit", "cancel", "finish"];

function resolveCode({ board }, card) {
  const code = cardCode(card.code);
  if (code || !board) return code;
  if (card.location & C.LOCATION_OVERLAY) {
    return cardAt(board, card.controller, C.LOCATION_MZONE, card.sequence)?.overlays?.[card.subsequence ?? 0] ?? 0;
  }
  return cardAt(board, card.controller, card.location, card.sequence)?.code ?? 0;
}

function place({ board }, card) {
  if (!board) return "";
  if (card.location & C.LOCATION_OVERLAY) {
    return `${zoneLabel(zoneRef(board, { ...card, location: C.LOCATION_MZONE }))} material`;
  }
  return zoneLabel(zoneRef(board, card));
}

// The server zeroes opponent-controlled candidates in selections, so the code
// falls back to the card this seat's board holds at that location (Q-04).
export function cardInfo(context, card) {
  const code = resolveCode(context, card);
  return { code, name: cardName(code, context.catalog), where: place(context, card) };
}

export function cardOption(n, context, card, { prefix = "", suffix = "" } = {}) {
  const info = cardInfo(context, card);
  return { n, label: `${prefix}${info.name} (${info.where})${suffix}`, card: info };
}

export function hintText(context, fallback) {
  return (context.hint && effectText(context.catalog, context.hint)) || fallback;
}

export function numbered(labels) {
  return labels.map((label, index) => ({ n: index + 1, label }));
}

export function answerField(prompt, answer, allowed) {
  const present = ANSWER_FIELDS.filter((field) => answer?.[field] !== undefined && answer[field] !== false);
  if (present.length !== 1) throw new AnswerError(`answer with exactly one of ${ANSWER_FIELDS.join(", ")}`);
  const [field] = present;
  if (field === "cancel" && !allowed.includes("cancel")) throw new AnswerError("this prompt cannot be cancelled");
  if (field === "finish" && !allowed.includes("finish")) throw new AnswerError("this prompt cannot be finished early");
  if (!allowed.includes(field)) throw new AnswerError(`this ${prompt.kind} prompt takes ${allowed.join(" or ")}`);
  return field;
}

function optionIndex(prompt, n) {
  if (!Number.isInteger(n) || n < 1 || n > prompt.options.length) {
    throw new AnswerError(`option ${n} is out of range 1..${prompt.options.length}`);
  }
  return n - 1;
}

export function chooseMany(prompt, choose, allowEmpty = false) {
  if (!Array.isArray(choose) || (!allowEmpty && choose.length === 0)) {
    throw new AnswerError(allowEmpty ? "choose is an array of option numbers" : "choose lists at least one option number");
  }
  const seen = new Set();
  return choose.map((n) => {
    const index = optionIndex(prompt, n);
    if (seen.has(index)) throw new AnswerError(`option ${n} is chosen more than once`);
    seen.add(index);
    return index;
  });
}

export function chooseOne(prompt, choose) {
  if (!Array.isArray(choose) || choose.length !== 1) throw new AnswerError("choose exactly one option number");
  return optionIndex(prompt, choose[0]);
}

export function response(bytes) {
  return { type: "response", bytes: Uint8Array.from(bytes) };
}

export function bitsOf(mask) {
  const bits = [];
  for (let index = 0; index < 32; index += 1) {
    const bit = 2 ** index;
    if ((mask >>> 0) & bit) bits.push(bit);
  }
  return bits;
}
