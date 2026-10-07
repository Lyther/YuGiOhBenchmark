import {
  BattleCmdType,
  IdleCmdType,
  IndexResponse,
  YGOProMsgSelectBattleCmd,
  YGOProMsgSelectIdleCmd,
} from "ygopro-msg-encode";

import { effectText } from "../events.js";
import { phaseLabel } from "../labels.js";
import { answerField, cardOption, chooseOne, response } from "./options.js";

function activation(context, card) {
  const effect = effectText(context.catalog, card.desc, card.code);
  return { prefix: "Activate ", suffix: effect ? `: ${effect}` : "" };
}

function idle(message, context) {
  const options = [];
  const refs = [];
  const add = (type, cards, decorate) => cards.forEach((card, index) => {
    options.push(cardOption(options.length + 1, context, card, decorate(card)));
    refs.push({ type, index });
  });
  add(IdleCmdType.SUMMON, message.summonableCards, () => ({ prefix: "Normal Summon " }));
  add(IdleCmdType.SPSUMMON, message.spSummonableCards, () => ({ prefix: "Special Summon " }));
  add(IdleCmdType.REPOS, message.reposableCards, () => ({ prefix: "Change position of " }));
  add(IdleCmdType.MSET, message.msetableCards, () => ({ prefix: "Set " }));
  add(IdleCmdType.SSET, message.ssetableCards, () => ({ prefix: "Set " }));
  add(IdleCmdType.ACTIVATE, message.activatableCards, (card) => activation(context, card));
  const plain = (label, type) => {
    options.push({ n: options.length + 1, label });
    refs.push({ type });
  };
  if (message.canBp) plain("Go to Battle Phase", IdleCmdType.TO_BP);
  if (message.canEp) plain("End turn", IdleCmdType.TO_EP);
  if (message.canShuffle) plain("Shuffle your hand", IdleCmdType.SHUFFLE);
  const phase = context.board ? phaseLabel(context.board.phase) : "Main Phase";
  return { prompt: { kind: "command", text: `${phase}: choose an action.`, options, source: message, refs }, auto: null };
}

function battle(message, context) {
  const options = [];
  const refs = [];
  message.activatableCards.forEach((card, index) => {
    options.push(cardOption(options.length + 1, context, card, activation(context, card)));
    refs.push({ type: BattleCmdType.ACTIVATE, index });
  });
  message.attackableCards.forEach((card, index) => {
    const suffix = card.directAttack ? " (can attack directly)" : "";
    options.push(cardOption(options.length + 1, context, card, { prefix: "Attack with ", suffix }));
    refs.push({ type: BattleCmdType.ATTACK, index });
  });
  const plain = (label, type) => {
    options.push({ n: options.length + 1, label });
    refs.push({ type });
  };
  if (message.canM2) plain("Go to Main Phase 2", BattleCmdType.TO_M2);
  if (message.canEp) plain("End turn", BattleCmdType.TO_EP);
  return { prompt: { kind: "battle", text: "Battle Phase: choose an action.", options, source: message, refs }, auto: null };
}

function encodeCommand(prompt, answer) {
  answerField(prompt, answer, ["choose"]);
  const ref = prompt.refs[chooseOne(prompt, answer.choose)];
  const bytes = ref.index === undefined
    ? prompt.source.prepareResponse(ref.type)
    : prompt.source.prepareResponse(ref.type, IndexResponse(ref.index));
  return response(bytes);
}

export const builders = new Map([
  [YGOProMsgSelectIdleCmd, idle],
  [YGOProMsgSelectBattleCmd, battle],
]);

export const encoders = { command: encodeCommand, battle: encodeCommand };
