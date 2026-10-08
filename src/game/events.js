import {
  OcgcoreCommonConstants as C,
  YGOProMsgAddCounter,
  YGOProMsgAttack,
  YGOProMsgAttackDisabled,
  YGOProMsgBattle,
  YGOProMsgBecomeTarget,
  YGOProMsgCancelTarget,
  YGOProMsgCardTarget,
  YGOProMsgChainDisabled,
  YGOProMsgChainNegated,
  YGOProMsgChainSolving,
  YGOProMsgChaining,
  YGOProMsgConfirmCards,
  YGOProMsgConfirmDeckTop,
  YGOProMsgConfirmExtraTop,
  YGOProMsgDamage,
  YGOProMsgDeckTop,
  YGOProMsgDraw,
  YGOProMsgEquip,
  YGOProMsgFieldDisabled,
  YGOProMsgFlipSummoning,
  YGOProMsgHint,
  YGOProMsgLpUpdate,
  YGOProMsgMatchKill,
  YGOProMsgMissedEffect,
  YGOProMsgMove,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgPayLpCost,
  YGOProMsgPosChange,
  YGOProMsgRandomSelected,
  YGOProMsgRecover,
  YGOProMsgReloadField,
  YGOProMsgRemoveCounter,
  YGOProMsgReverseDeck,
  YGOProMsgShuffleDeck,
  YGOProMsgShuffleExtra,
  YGOProMsgShuffleHand,
  YGOProMsgShuffleSetCard,
  YGOProMsgSpSummoning,
  YGOProMsgSummoning,
  YGOProMsgSwapGraveDeck,
  YGOProMsgTossCoin,
  YGOProMsgTossDice,
  YGOProMsgUnequip,
  YGOProMsgWin,
} from "ygopro-msg-encode";

import { cardAt, cardCode, who, zoneRef } from "./board.js";
import { cardName, phaseLabel, positionLabel, zoneLabel } from "./labels.js";

const ON_FIELD = C.LOCATION_MZONE | C.LOCATION_SZONE;

const subject = (board, player) => (who(board, player) === "me" ? "You" : "Opponent");
const owner = (board, player) => (who(board, player) === "me" ? "Your" : "Opponent's");
const verb = (board, player, base, third = `${base}s`) => (who(board, player) === "me" ? base : third);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function place(board, location) {
  if (!location.location) return "out of play";
  if (location.location & C.LOCATION_OVERLAY) {
    return `${zoneLabel(zoneRef(board, { ...location, location: C.LOCATION_MZONE }))} material`;
  }
  return zoneLabel(zoneRef(board, location));
}

function named(board, catalog, location, code) {
  const known = cardCode(code) || cardAt(board, location.controller, location.location, location.sequence)?.code || 0;
  return `${cardName(known, catalog)} (${place(board, location)})`;
}

export function effectText(catalog, desc, code) {
  const text = catalog.desc(desc);
  if (!text) return null;
  return text.replaceAll("%ls", code ? cardName(code, catalog) : "card");
}

function reasonText(reason) {
  const parts = [];
  if (reason & C.REASON_DESTROY) {
    parts.push(reason & C.REASON_BATTLE ? "destroyed by battle" : reason & C.REASON_EFFECT ? "destroyed by an effect" : "destroyed");
  }
  if (reason & C.REASON_RELEASE) parts.push("tributed");
  if (reason & C.REASON_DISCARD) parts.push("discarded");
  if (reason & C.REASON_MATERIAL) {
    const kinds = [[C.REASON_FUSION, "Fusion"], [C.REASON_SYNCHRO, "Synchro"], [C.REASON_XYZ, "Xyz"], [C.REASON_LINK, "Link"], [C.REASON_RITUAL, "Ritual"]];
    const kind = kinds.find(([bit]) => reason & bit)?.[1];
    parts.push(kind ? `used as ${kind} material` : "used as material");
  }
  if (reason & C.REASON_COST) parts.push("as a cost");
  if (reason & C.REASON_RETURN) parts.push("returned");
  return parts.join(" ");
}

function moveEvent(message, { board, catalog }) {
  const from = message.previous;
  const to = message.current;
  if ((message.reason & C.REASON_SUMMON) && to.location === C.LOCATION_MZONE) return null;
  const code = cardCode(message.code) || cardAt(board, from.controller, from.location, from.sequence)?.code || 0;
  let text = `${cardName(code, catalog)}: ${place(board, from)} → ${place(board, to)}`;
  if (to.location & ON_FIELD && !(to.location & C.LOCATION_OVERLAY)) {
    text += ` (${positionLabel(to.position, to.location === C.LOCATION_MZONE ? "monster" : "spell")})`;
  }
  const reason = reasonText(message.reason);
  return { kind: "move", text: reason ? `${text} (${reason})` : text };
}

function drawEvent({ player, cards }, { board, catalog }) {
  const codes = cards.map(cardCode);
  if (who(board, player) === "opponent" && codes.every((code) => !code)) {
    return { kind: "draw", text: `Opponent drew ${plural(codes.length, "card")}` };
  }
  return { kind: "draw", text: `${subject(board, player)} drew ${codes.map((code) => cardName(code, catalog)).join(", ")}` };
}

function summonEvent(kind) {
  return (message, { board, catalog }) => {
    const zone = zoneLabel(zoneRef(board, message));
    const action = verb(board, message.controller, kind);
    const text = `${subject(board, message.controller)} ${action} ${cardName(cardCode(message.code), catalog)} to ${zone} (${positionLabel(message.position, "monster")})`;
    return { kind: "summon", text };
  };
}

function chainingEvent(message, { board, catalog }) {
  const player = message.chainCardLocation.controller;
  const activator = who(board, player) === "me" ? "you activate" : "opponent activates";
  const card = `${cardName(cardCode(message.code), catalog)} (${place(board, message)})`;
  const effect = effectText(catalog, message.desc, cardCode(message.code));
  const text = `Chain Link ${message.chainCount}: ${activator} ${card}${effect ? `: ${effect}` : ""}`;
  return { kind: "activate", text };
}

function lpEvent(kind, base, field, sign) {
  return (message, { board }) => {
    const key = who(board, message.player);
    const after = Math.max(0, board.lp[key] + sign * message[field]);
    const action = verb(board, message.player, base, `${base === "pay" ? "pays" : `${base}s`}`);
    const amount = kind === "damage" ? `${message[field]} damage` : `${message[field]} LP`;
    return { kind, text: `${subject(board, message.player)} ${action} ${amount} (LP ${after})` };
  };
}

function hintEvent({ type, player, desc }, { board, catalog }) {
  if (type === C.HINT_OPSELECTED) return { kind: "hint", text: `${subject(board, player)} chose: ${effectText(catalog, desc) ?? `option ${desc}`}` };
  if (type === C.HINT_CODE) return { kind: "hint", text: `Declared card: ${cardName(desc, catalog)}` };
  if (type === C.HINT_RACE) return { kind: "hint", text: `Declared type: ${catalog.raceName(desc) ?? desc}` };
  if (type === C.HINT_ATTRIB) return { kind: "hint", text: `Declared attribute: ${catalog.attributeName(desc) ?? desc}` };
  if (type === C.HINT_NUMBER) return { kind: "hint", text: `Declared number: ${desc}` };
  if (type === C.HINT_EFFECT) return { kind: "hint", text: `Effect used: ${cardName(desc, catalog)}` };
  if (type === C.HINT_CARD) return { kind: "hint", text: `Card shown: ${cardName(desc, catalog)}` };
  if (type === C.HINT_MESSAGE || type === C.HINT_EVENT) {
    const text = effectText(catalog, desc);
    return text ? { kind: "hint", text } : null;
  }
  return null;
}

function revealEvent(label) {
  return ({ cards }, { board, catalog }) => {
    const list = cards.map((card) => named(board, catalog, card, card.code)).join(", ");
    return { kind: "reveal", text: `${label}: ${list}` };
  };
}

function winEvent({ player, type }, { board, catalog }) {
  const reason = catalog.victoryReason(type) ?? `#${type}`;
  if (player !== 0 && player !== 1) return { kind: "win", text: `The duel is a draw: ${reason}` };
  return { kind: "win", text: `${subject(board, player)} ${verb(board, player, "win")} the duel: ${reason}` };
}

function counterEvent(direction) {
  return (message, { board, catalog }) => {
    const counter = catalog.counterName(message.counterType) ?? `counter ${message.counterType}`;
    const card = named(board, catalog, message, 0);
    return { kind: "counter", text: `${message.count} ${counter} ${direction} ${card}` };
  };
}

function targetEvent(phrase) {
  return ({ card1, card2 }, { board, catalog }) => ({
    kind: "target", text: `${named(board, catalog, card1, 0)} ${phrase} ${named(board, catalog, card2, 0)}`,
  });
}

function becomeTargetEvent({ targets }, { board, catalog }) {
  const list = targets.map((packed) => named(board, catalog, {
    controller: packed & 0xff, location: (packed >>> 8) & 0xff, sequence: (packed >>> 16) & 0xff,
  }, 0));
  return { kind: "target", text: `Targeted: ${list.join(", ")}` };
}

const simple = (kind, text) => () => ({ kind, text });

const DESCRIBERS = new Map([
  [YGOProMsgNewTurn, ({ player }, { board }) => ({ kind: "turn", text: `Turn ${board.turn + 1} (${who(board, player) === "me" ? "you" : "opponent"})` })],
  [YGOProMsgNewPhase, ({ phase }) => ({ kind: "phase", text: phaseLabel(phase) })],
  [YGOProMsgDraw, drawEvent],
  [YGOProMsgMove, moveEvent],
  [YGOProMsgSummoning, summonEvent("Normal Summon")],
  [YGOProMsgSpSummoning, summonEvent("Special Summon")],
  [YGOProMsgFlipSummoning, summonEvent("Flip Summon")],
  [YGOProMsgPosChange, (message, { board, catalog }) => ({
    kind: "position",
    text: `${named(board, catalog, message.card, message.code)} is now ${positionLabel(message.currentPosition, message.card.location === C.LOCATION_SZONE ? "spell" : "monster")}`,
  })],
  [YGOProMsgChaining, chainingEvent],
  [YGOProMsgChainSolving, ({ chainCount }) => ({ kind: "resolve", text: `Chain Link ${chainCount} resolves` })],
  [YGOProMsgChainNegated, ({ chainCount }) => ({ kind: "negate", text: `Chain Link ${chainCount}'s activation was negated` })],
  [YGOProMsgChainDisabled, ({ chainCount }) => ({ kind: "negate", text: `Chain Link ${chainCount}'s effect was negated` })],
  [YGOProMsgAttack, ({ attacker, defender }, { board, catalog }) => ({
    kind: "attack",
    text: `${named(board, catalog, attacker, 0)} attacks ${defender.location ? named(board, catalog, defender, 0) : "directly"}`,
  })],
  [YGOProMsgAttackDisabled, simple("attack", "The attack was negated")],
  [YGOProMsgBattle, ({ attacker, defender }, { board, catalog }) => {
    const side = (stats) => `${cardName(cardAt(board, stats.location.controller, stats.location.location, stats.location.sequence)?.code ?? 0, catalog)} ${stats.atk}/${stats.def}`;
    return { kind: "battle", text: `Battle: ${side(attacker)}${defender.location.location ? ` vs ${side(defender)}` : " (direct attack)"}` };
  }],
  [YGOProMsgDamage, lpEvent("damage", "take", "value", -1)],
  [YGOProMsgRecover, lpEvent("lp", "gain", "value", 1)],
  [YGOProMsgPayLpCost, lpEvent("lp", "pay", "cost", -1)],
  [YGOProMsgLpUpdate, ({ player, lp }, { board }) => ({ kind: "lp", text: `${owner(board, player)} LP become ${lp}` })],
  [YGOProMsgWin, winEvent],
  [YGOProMsgHint, hintEvent],
  [YGOProMsgConfirmCards, revealEvent("Revealed")],
  [YGOProMsgConfirmDeckTop, revealEvent("Revealed from the top of the Deck")],
  [YGOProMsgConfirmExtraTop, revealEvent("Revealed from the top of the Extra Deck")],
  [YGOProMsgDeckTop, ({ player, code }, { board, catalog }) => ({
    kind: "reveal", text: `Top card of ${owner(board, player).toLowerCase()} Deck: ${cardName(cardCode(code), catalog)}`,
  })],
  [YGOProMsgShuffleHand, ({ player }, { board }) => ({ kind: "shuffle", text: `${owner(board, player)} hand was shuffled` })],
  [YGOProMsgShuffleDeck, ({ player }, { board }) => ({ kind: "shuffle", text: `${owner(board, player)} Deck was shuffled` })],
  [YGOProMsgShuffleExtra, ({ player }, { board }) => ({ kind: "shuffle", text: `${owner(board, player)} Extra Deck was shuffled` })],
  [YGOProMsgShuffleSetCard, simple("shuffle", "Set cards were shuffled")],
  [YGOProMsgSwapGraveDeck, ({ player }, { board }) => ({ kind: "shuffle", text: `${owner(board, player)} GY and Deck were swapped` })],
  [YGOProMsgReverseDeck, simple("shuffle", "The Decks were turned over")],
  [YGOProMsgTossCoin, ({ results }) => ({ kind: "random", text: `Coin toss: ${results.map((value) => (value ? "heads" : "tails")).join(", ")}` })],
  [YGOProMsgTossDice, ({ results }) => ({ kind: "random", text: `${results.length > 1 ? "Dice roll" : "Die roll"}: ${results.join(", ")}` })],
  [YGOProMsgRandomSelected, ({ count }) => ({ kind: "random", text: `Randomly selected ${plural(count, "card")}` })],
  [YGOProMsgAddCounter, counterEvent("added to")],
  [YGOProMsgRemoveCounter, counterEvent("removed from")],
  [YGOProMsgEquip, ({ equip, target }, { board, catalog }) => ({
    kind: "move", text: `${named(board, catalog, equip, 0)} is equipped to ${named(board, catalog, target, 0)}`,
  })],
  [YGOProMsgUnequip, ({ card }, { board, catalog }) => ({ kind: "move", text: `${named(board, catalog, card, 0)} is no longer equipped` })],
  [YGOProMsgCardTarget, targetEvent("now targets")],
  [YGOProMsgCancelTarget, targetEvent("no longer targets")],
  [YGOProMsgBecomeTarget, becomeTargetEvent],
  [YGOProMsgMissedEffect, (message, { board, catalog }) => ({ kind: "hint", text: `${named(board, catalog, message, message.code)}: the effect missed its timing` })],
  [YGOProMsgFieldDisabled, ({ disabledField }) => ({ kind: "hint", text: `Disabled zones now: 0x${(disabledField >>> 0).toString(16)}` })],
  [YGOProMsgMatchKill, ({ code }, { catalog }) => ({ kind: "win", text: `${cardName(cardCode(code), catalog)} ends the match after this duel` })],
  [YGOProMsgReloadField, simple("server", "The server reloaded the field")],
]);

// One readable sentence for a non-prompt game message, from this player's
// side, using the board as it was before the message; null when nothing to say.
export function describeEvent(message, context) {
  const describe = DESCRIBERS.get(message?.constructor);
  return describe ? describe(message, context) : null;
}
