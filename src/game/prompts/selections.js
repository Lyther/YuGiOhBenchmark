import {
  IndexResponse,
  YGOProMsgSelectCard,
  YGOProMsgSelectCounter,
  YGOProMsgSelectSum,
  YGOProMsgSelectTribute,
  YGOProMsgSelectUnselectCard,
  YGOProMsgSortCard,
} from "ygopro-msg-encode";

import { AnswerError, answerField, cardInfo, cardOption, chooseMany, chooseOne, hintText, response } from "./options.js";

const KEEP_ORDER = 0xff;

function cards(message, context) {
  const options = message.cards.map((card, index) => cardOption(index + 1, context, card));
  const prompt = {
    kind: "cards", text: hintText(context, "Select cards."), options,
    min: message.min, max: message.max, cancelable: Boolean(message.cancelable), source: message,
  };
  const forced = !message.cancelable && message.min === message.max && message.max === options.length;
  return { prompt, auto: forced ? { choose: options.map((option) => option.n) } : null };
}

// Tribute min is a tribute total, max a card count (ocgcore select_tribute).
function tribute(message, context) {
  const options = message.cards.map((card, index) => ({ ...cardOption(index + 1, context, card), tributes: card.releaseParam }));
  const prompt = {
    kind: "tribute", text: hintText(context, "Select monsters to Tribute."), options,
    min: message.min, max: message.max, cancelable: Boolean(message.cancelable), source: message,
  };
  const ones = options.every((option) => option.tributes === 1);
  const forced = ones && !message.cancelable && message.min === message.max && message.max === options.length;
  return { prompt, auto: forced ? { choose: options.map((option) => option.n) } : null };
}

function encodeCards(prompt, answer) {
  const field = answerField(prompt, answer, prompt.cancelable ? ["choose", "cancel"] : ["choose"]);
  if (field === "cancel") return response(prompt.source.prepareResponse(null));
  return response(prompt.source.prepareResponse(chooseMany(prompt, answer.choose, true).map((index) => IndexResponse(index))));
}

function unselect(message, context) {
  const options = [
    ...message.selectableCards.map((card) => ({ card, prefix: "Select " })),
    ...message.unselectableCards.map((card) => ({ card, prefix: "Unselect " })),
  ].map(({ card, prefix }, index) => cardOption(index + 1, context, card, { prefix }));
  const prompt = {
    kind: "unselect", text: hintText(context, "Select cards."), options, min: message.min, max: message.max,
    cancelable: Boolean(message.cancelable), finishable: Boolean(message.finishable), source: message,
  };
  return { prompt, auto: null };
}

function encodeUnselect(prompt, answer) {
  const allowed = ["choose", ...(prompt.cancelable ? ["cancel"] : []), ...(prompt.finishable ? ["finish"] : [])];
  const field = answerField(prompt, answer, allowed);
  if (field !== "choose") return response(prompt.source.prepareResponse(null));
  return response(prompt.source.prepareResponse(IndexResponse(chooseOne(prompt, answer.choose))));
}

// ocgcore get_sum_params: low and high 16 bits are alternative values, unless
// bit 15 of the high half marks one large value.
function sumValues(param) {
  const value = param >>> 0;
  const high = (value >>> 16) & 0xffff;
  if (high & 0x8000) return [value & 0x7fffffff];
  return high ? [value & 0xffff, high] : [value & 0xffff];
}

function sum(message, context) {
  const options = message.cards.map((card, index) => ({ ...cardOption(index + 1, context, card), values: sumValues(card.opParam) }));
  const mustInclude = message.mustSelectCards.map((card) => {
    const info = cardInfo(context, card);
    return { label: `${info.name} (${info.where})`, values: sumValues(card.opParam) };
  });
  const prompt = {
    kind: "sum", text: hintText(context, "Select cards for the sum."), options, sumTarget: message.sumVal,
    sumMode: message.mode === 0 ? "exactly" : "at least", min: message.min, max: message.max, mustInclude, source: message,
  };
  return { prompt, auto: null };
}

// The library writes chosen indices right after the count byte; ocgcore and
// the stock client put the mandatory cards first (architecture D-02).
function encodeSum(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  const chosen = chooseMany(prompt, answer.choose, true);
  const must = prompt.mustInclude.length;
  return response([must + chosen.length, ...Array.from({ length: must }, (_, index) => index), ...chosen]);
}

function sort(message, context) {
  const options = message.cards.map((card, index) => cardOption(index + 1, context, card));
  const prompt = { kind: "sort", text: hintText(context, "Choose the order of these cards."), options, source: message };
  return { prompt, auto: options.length === 1 ? { choose: [1] } : null };
}

// ocgcore reads byte i as the new position of card i; the library writes the
// inverse (cards in their new order), so the seat encodes this itself.
function encodeSort(prompt, answer) {
  const field = answerField(prompt, answer, ["choose", "cancel"]);
  if (field === "cancel") return response([KEEP_ORDER]);
  const order = chooseMany(prompt, answer.choose);
  if (order.length !== prompt.options.length) throw new AnswerError("list every option once, in the new order");
  const positions = new Array(order.length);
  order.forEach((cardIndex, position) => { positions[cardIndex] = position; });
  return response(positions);
}

function counter(message, context) {
  const options = message.cards.map((card, index) => ({ ...cardOption(index + 1, context, card), counters: card.counterCount }));
  const name = context.catalog.counterName(message.counterType) ?? `counter 0x${message.counterType.toString(16)}`;
  const prompt = {
    kind: "counter", text: `Remove ${message.counterCount} ${name} from among these cards.`,
    options, total: message.counterCount, source: message,
  };
  return { prompt, auto: options.length === 1 ? { counts: [{ option: 1, count: message.counterCount }] } : null };
}

function encodeCounter(prompt, answer) {
  answerField(prompt, answer, ["counts"]);
  if (!Array.isArray(answer.counts) || answer.counts.length === 0) throw new AnswerError("counts lists {option, count} entries");
  const counts = new Array(prompt.options.length).fill(0);
  const used = chooseMany(prompt, answer.counts.map(({ option }) => option));
  answer.counts.forEach(({ count }, index) => {
    if (!Number.isInteger(count) || count < 0 || count > 0xffff) throw new AnswerError(`count ${count} must be a whole number`);
    counts[used[index]] = count;
  });
  const bytes = new Uint8Array(counts.length * 2);
  counts.forEach((count, index) => new DataView(bytes.buffer).setUint16(index * 2, count, true));
  return response(bytes);
}

export const builders = new Map([
  [YGOProMsgSelectCard, cards],
  [YGOProMsgSelectTribute, tribute],
  [YGOProMsgSelectUnselectCard, unselect],
  [YGOProMsgSelectSum, sum],
  [YGOProMsgSortCard, sort],
  [YGOProMsgSelectCounter, counter],
]);

export const encoders = {
  cards: encodeCards, tribute: encodeCards, unselect: encodeUnselect, sum: encodeSum, sort: encodeSort, counter: encodeCounter,
};
