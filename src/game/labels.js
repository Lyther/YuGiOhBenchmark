import { OcgcoreCommonConstants as C } from "ygopro-msg-encode";

const OWNER = Object.freeze({ me: "your", opponent: "opponent's" });
const EMZ = ["EMZ left", "EMZ right"];
const FIELD_ZONE = 5;
const MAIN_ZONES = 5;
const LIST_NAMES = Object.freeze({ hand: "hand", grave: "GY", banished: "banished", extra: "Extra Deck", deck: "Deck" });

export function zoneLabel({ side, zone, index }) {
  const owner = OWNER[side] ?? side;
  if (zone === "monster") return `${owner} ${index < MAIN_ZONES ? `M${index + 1}` : EMZ[index - MAIN_ZONES] ?? `M${index + 1}`}`;
  if (zone === "spell") return `${owner} ${index === FIELD_ZONE ? "field zone" : `S${index + 1}`}`;
  return `${owner} ${LIST_NAMES[zone] ?? zone}`;
}

export function positionLabel(position, zone) {
  if (zone === "spell") return position & C.POS_FACEUP ? "faceup" : "facedown";
  if (position & C.POS_FACEUP_ATTACK) return "faceup-attack";
  if (position & C.POS_FACEDOWN_ATTACK) return "facedown-attack";
  if (position & C.POS_FACEUP_DEFENSE) return "faceup-defense";
  if (position & C.POS_FACEDOWN_DEFENSE) return "facedown-defense";
  return position & C.POS_FACEUP ? "faceup" : "facedown";
}

const PHASES = [
  [C.PHASE_DRAW, "Draw Phase"], [C.PHASE_STANDBY, "Standby Phase"], [C.PHASE_MAIN1, "Main Phase 1"],
  [C.PHASE_BATTLE_START, "Battle Phase"], [C.PHASE_BATTLE_STEP, "Battle Phase"], [C.PHASE_DAMAGE, "Damage Step"],
  [C.PHASE_DAMAGE_CAL, "Damage Calculation"], [C.PHASE_BATTLE, "Battle Phase"], [C.PHASE_MAIN2, "Main Phase 2"],
  [C.PHASE_END, "End Phase"],
];

export function phaseLabel(phase) {
  return PHASES.find(([bit]) => bit === phase)?.[1] ?? (phase ? `phase ${phase}` : "before the first phase");
}

export function cardName(code, catalog) {
  if (!code) return "face-down card";
  return catalog.card(code)?.name ?? `#${code} (no local text)`;
}
