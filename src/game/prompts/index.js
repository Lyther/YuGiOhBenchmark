import { YGOProMsgResponseBase } from "ygopro-msg-encode";

import * as choices from "./choices.js";
import * as commands from "./commands.js";
import { AnswerError, answerField, chooseOne, numbered } from "./options.js";
import * as places from "./places.js";
import * as selections from "./selections.js";

export { AnswerError } from "./options.js";

const BUILDERS = new Map([...commands.builders, ...selections.builders, ...choices.builders, ...places.builders]);

function submit(prompt, answer) {
  answerField(prompt, answer, ["submit"]);
  return { type: "deck" };
}

function first(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  return { type: "tp", goFirst: chooseOne(prompt, answer.choose) === 0 };
}

const ENCODERS = {
  ...commands.encoders, ...selections.encoders, ...choices.encoders, ...places.encoders,
  deck: submit, side: submit, first,
};

export function supportsMessage(MessageClass) {
  return BUILDERS.has(MessageClass);
}

export function isPromptMessage(message) {
  return message instanceof YGOProMsgResponseBase;
}

// A prompt for a response-bearing game message. `auto` is the answer the seat
// sends itself when the server's own rule leaves exactly one (AD-07).
export function buildPrompt(message, context) {
  const build = BUILDERS.get(message?.constructor);
  if (!build) return isPromptMessage(message) ? { unsupported: message.constructor.name } : null;
  return build(message, context);
}

export function lobbyPrompt(kind, { text } = {}) {
  if (kind === "deck") return { kind, text: text ?? "Submit your deck.", options: [] };
  if (kind === "side") return { kind, text: text ?? "Side Deck: edit, then submit.", options: [] };
  if (kind === "rps") return { kind, text: text ?? "Rock, paper or scissors?", options: numbered(choices.RPS_CHOICES.map(([label]) => label)) };
  if (kind === "first") return { kind, text: text ?? "Go first or second?", options: numbered(["Go first", "Go second"]) };
  throw new Error(`unknown lobby prompt ${kind}`);
}

// Turns a model answer into the action to send: response bytes for a duel
// prompt, or a deck, hand or first-player action for the lobby.
export function resolveAnswer(prompt, answer) {
  const encode = ENCODERS[prompt.kind];
  if (!encode) throw new AnswerError(`no answer is defined for ${prompt.kind} prompts`);
  return encode(prompt, answer);
}
