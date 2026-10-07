import { YGOProMsgSelectDisField, YGOProMsgSelectPlace } from "ygopro-msg-encode";

import { zoneLabel } from "../labels.js";
import { ZONE_NAMES, who } from "../board.js";
import { answerField, chooseMany, hintText, numbered, response } from "./options.js";

function placeLabel(context, { player, location, sequence }) {
  const side = context.board ? who(context.board, player) : player === context.me ? "me" : "opponent";
  return zoneLabel({ side, zone: ZONE_NAMES[location], index: sequence });
}

function places(message, context) {
  const available = message.getSelectablePlaces();
  const options = numbered(available.map((place) => placeLabel(context, place)));
  const plural = message.count === 1 ? "a zone" : `${message.count} zones`;
  const prompt = {
    kind: "place", text: hintText(context, `Choose ${plural}.`), options,
    min: message.count, max: message.count, source: message, refs: available,
  };
  const auto = options.length === message.count ? { choose: options.map((option) => option.n) } : null;
  return { prompt, auto };
}

function encodePlaces(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  return response(prompt.source.prepareResponse(chooseMany(prompt, answer.choose).map((index) => prompt.refs[index])));
}

export const builders = new Map([
  [YGOProMsgSelectPlace, places],
  [YGOProMsgSelectDisField, places],
]);

export const encoders = { place: encodePlaces };
