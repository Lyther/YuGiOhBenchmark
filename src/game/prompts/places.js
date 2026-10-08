import { YGOProMsgSelectDisField, YGOProMsgSelectPlace } from "ygopro-msg-encode";

import { zoneLabel } from "../labels.js";
import { ZONE_NAMES, who } from "../board.js";
import { answerField, chooseMany, hintText, numbered, response } from "./options.js";

function placeLabel(context, { player, location, sequence }) {
  const side = context.board ? who(context.board, player) : player === context.me ? "me" : "opponent";
  return zoneLabel({ side, zone: ZONE_NAMES[location], index: sequence });
}

// Count 0 asks for one zone and allows a cancel (ocgcore select_place; the
// stock client sets select_min 1 and select_cancelable for it).
function places(message, context) {
  const available = message.getSelectablePlaces();
  const options = numbered(available.map((place) => placeLabel(context, place)));
  const cancelable = message.count === 0;
  const count = Math.max(1, message.count);
  const plural = count === 1 ? "a zone" : `${count} zones`;
  const prompt = {
    kind: "place", text: hintText(context, `Choose ${plural}.`), options,
    min: count, max: count, cancelable, source: message, refs: available,
  };
  const auto = !cancelable && options.length === count ? { choose: options.map((option) => option.n) } : null;
  return { prompt, auto };
}

function encodePlaces(prompt, answer) {
  const field = answerField(prompt, answer, prompt.cancelable ? ["choose", "cancel"] : ["choose"]);
  if (field === "cancel") return response([prompt.source.player, 0, 0]);
  return response(prompt.source.prepareResponse(chooseMany(prompt, answer.choose).map((index) => prompt.refs[index])));
}

export const builders = new Map([
  [YGOProMsgSelectPlace, places],
  [YGOProMsgSelectDisField, places],
]);

export const encoders = { place: encodePlaces };
