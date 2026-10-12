import {
  HandResult,
  IndexResponse,
  YGOProMsgAnnounceAttrib,
  YGOProMsgAnnounceCard,
  YGOProMsgAnnounceNumber,
  YGOProMsgAnnounceRace,
  YGOProMsgRockPaperScissors,
  YGOProMsgSelectChain,
  YGOProMsgSelectEffectYn,
  YGOProMsgSelectOption,
  YGOProMsgSelectPosition,
  YGOProMsgSelectYesNo,
} from "ygopro-msg-encode";

import { cardCode, zoneRef } from "../board.js";
import { effectText } from "../events.js";
import { cardName, positionLabel, zoneLabel } from "../labels.js";
import { AnswerError, answerField, bitsOf, cardOption, chooseMany, chooseOne, hintText, numbered, response } from "./options.js";

const ACTIVATE_FROM = 200;
const TRIGGER_ON = 221;
export const RPS_CHOICES = Object.freeze([
  ["Rock", HandResult.ROCK], ["Paper", HandResult.PAPER], ["Scissors", HandResult.SCISSORS],
]);

function chainText(context) {
  const chain = context.board?.chain ?? [];
  if (!chain.length) return "Activate a card or effect in response?";
  const last = chain[chain.length - 1];
  return `Chain Link ${chain.length} is ${cardName(last.code, context.catalog)}. Chain another card or effect?`;
}

function chain(message, context) {
  const forced = message.chains.some((link) => link.forced);
  const options = forced ? [] : [{ n: 1, label: "Pass" }];
  const refs = forced ? [] : [null];
  message.chains.forEach((link, index) => {
    const effect = effectText(context.catalog, link.desc, link.code);
    options.push(cardOption(options.length + 1, context, link, { prefix: "Activate ", suffix: effect ? `: ${effect}` : "" }));
    refs.push(index);
  });
  const prompt = { kind: "chain", text: chainText(context), options, forced, source: message, refs };
  const auto = message.chains.length === 0 || (forced && message.chains.length === 1) ? { choose: [1] } : null;
  return { prompt, auto };
}

function encodeChain(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  const ref = prompt.refs[chooseOne(prompt, answer.choose)];
  return response(prompt.source.prepareResponse(ref === null ? null : IndexResponse(ref)));
}

const YES_NO = numbered(["Yes", "No"]);

function yesno(message, context) {
  const text = effectText(context.catalog, message.desc) ?? "Yes or no?";
  return { prompt: { kind: "yesno", text, options: YES_NO, source: message }, auto: null };
}

// Mirrors the stock client's MSG_SELECT_EFFECTYN wording (duelclient.cpp).
function effect(message, context) {
  const name = cardName(cardCode(message.code), context.catalog);
  const where = context.board ? zoneLabel(zoneRef(context.board, message)) : "";
  let text;
  if (message.desc === 0 || message.desc === TRIGGER_ON) {
    const template = context.catalog.systemString(message.desc === 0 ? ACTIVATE_FROM : TRIGGER_ON) ?? "Activate [%ls] [%ls]?";
    text = template.replace("%ls", where).replace("%ls", name);
  } else {
    text = effectText(context.catalog, message.desc, cardCode(message.code)) ?? `Use the effect of ${name}?`;
  }
  return { prompt: { kind: "effect", text, options: YES_NO, source: message }, auto: null };
}

function encodeYesNo(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  return response(prompt.source.prepareResponse(chooseOne(prompt, answer.choose) === 0));
}

function option(message, context) {
  const options = numbered(message.options.map((desc) => effectText(context.catalog, desc) ?? `option ${desc}`));
  const prompt = { kind: "option", text: hintText(context, "Choose an option."), options, source: message };
  return { prompt, auto: options.length === 1 ? { choose: [1] } : null };
}

function encodeIndex(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  return response(prompt.source.prepareResponse(IndexResponse(chooseOne(prompt, answer.choose))));
}

function position(message, context) {
  const positions = bitsOf(message.positions);
  const options = numbered(positions.map((bit) => positionLabel(bit, "monster")));
  const name = cardName(cardCode(message.code), context.catalog);
  const prompt = { kind: "position", text: `Choose the position of ${name}.`, options, source: message, refs: positions };
  return { prompt, auto: options.length === 1 ? { choose: [1] } : null };
}

function encodePosition(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  return response(prompt.source.prepareResponse(prompt.refs[chooseOne(prompt, answer.choose)]));
}

function announce(kind, available, nameOf, noun) {
  return (message, context) => {
    const bits = bitsOf(message[available]);
    const options = numbered(bits.map((bit) => context.catalog[nameOf](bit) ?? `0x${bit.toString(16)}`));
    const text = hintText(context, `Declare ${message.count} ${noun}${message.count === 1 ? "" : "s"}.`);
    const prompt = { kind, text, options, min: message.count, max: message.count, source: message, refs: bits };
    const auto = options.length === message.count ? { choose: options.map((item) => item.n) } : null;
    return { prompt, auto };
  };
}

function encodeBits(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  const mask = chooseMany(prompt, answer.choose).reduce((bits, index) => bits | prompt.refs[index], 0) >>> 0;
  return response(prompt.source.prepareResponse(mask));
}

function number(message, context) {
  const options = numbered(message.numbers.map(String));
  const prompt = { kind: "number", text: hintText(context, "Declare a number."), options, source: message };
  return { prompt, auto: options.length === 1 ? { choose: [1] } : null };
}

function declare(message, context) {
  const text = hintText(context, "Declare a card name.");
  return { prompt: { kind: "declare", text, options: [], source: message, catalog: context.catalog }, auto: null };
}

// The seat resolves the name only; ocgcore checks whether it may be declared.
function encodeDeclare(prompt, answer) {
  answerField(prompt, answer, ["card"]);
  const { card } = answer;
  if (Number.isInteger(card) && card > 0) return response(prompt.source.prepareResponse(card));
  if (typeof card !== "string" || !card.trim()) throw new AnswerError("card is a card code or a card name");
  const found = prompt.catalog.findByName(card);
  if (found.card) return response(prompt.source.prepareResponse(found.card.code));
  const hint = found.suggestions.length ? `; did you mean: ${found.suggestions.join(", ")}` : "";
  throw new AnswerError(`unknown card name "${card}"${hint}`);
}

function rps(message) {
  const options = numbered(RPS_CHOICES.map(([label]) => label));
  return { prompt: { kind: "rps", text: "Rock, paper or scissors?", options, source: message }, auto: null };
}

function encodeRps(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  const value = RPS_CHOICES[chooseOne(prompt, answer.choose)][1];
  return prompt.source ? response(prompt.source.prepareResponse(value)) : { type: "hand", value };
}

export const builders = new Map([
  [YGOProMsgSelectChain, chain],
  [YGOProMsgSelectYesNo, yesno],
  [YGOProMsgSelectEffectYn, effect],
  [YGOProMsgSelectOption, option],
  [YGOProMsgSelectPosition, position],
  [YGOProMsgAnnounceRace, announce("race", "availableRaces", "raceName", "type")],
  [YGOProMsgAnnounceAttrib, announce("attribute", "availableAttributes", "attributeName", "attribute")],
  [YGOProMsgAnnounceNumber, number],
  [YGOProMsgAnnounceCard, declare],
  [YGOProMsgRockPaperScissors, rps],
]);

export const encoders = {
  chain: encodeChain, yesno: encodeYesNo, effect: encodeYesNo, option: encodeIndex, position: encodePosition,
  race: encodeBits, attribute: encodeBits, number: encodeIndex, declare: encodeDeclare, rps: encodeRps,
};
