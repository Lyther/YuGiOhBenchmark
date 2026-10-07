import YGOProDeck from "ygopro-deck-encode";
import {
  ErrorMessageType,
  YGOProCtosChat,
  YGOProCtosHandResult,
  YGOProCtosHsReady,
  YGOProCtosHsStart,
  YGOProCtosJoinGame,
  YGOProCtosLeaveGame,
  YGOProCtosPlayerInfo,
  YGOProCtosResponse,
  YGOProCtosSurrender,
  YGOProCtosTimeConfirm,
  YGOProCtosTpResult,
  YGOProCtosUpdateDeck,
  YGOProStoc,
  YGOProStocErrorMsg,
} from "ygopro-msg-encode";

export const CLIENT_VERSION = 0x1362;

// The client's chat buffer holds 256 UTF-16 units including the terminator.
const MAX_CHAT_UNITS = 255;
const MAX_CARD_CODE = 2 ** 28;

function full(packet) {
  return Buffer.from(packet.toFullPayload());
}

export function encodeUpdateDeck({ main, extra, side }) {
  for (const code of [...main, ...extra, ...side]) {
    if (!Number.isInteger(code) || code < 1 || code >= MAX_CARD_CODE) {
      throw new Error(`deck card code ${code} is not a positive integer below 2^28`);
    }
  }
  const packet = new YGOProCtosUpdateDeck();
  packet.deck = new YGOProDeck({ main: [...main], extra: [...extra], side: [...side] });
  return full(packet);
}

export function encodeReady() {
  return full(new YGOProCtosHsReady());
}

export function encodeStart() {
  return full(new YGOProCtosHsStart());
}

export function encodeHandResult(choice) {
  if (![1, 2, 3].includes(choice)) throw new Error(`hand result ${choice} must be 1, 2 or 3`);
  const packet = new YGOProCtosHandResult();
  packet.res = choice;
  return full(packet);
}

export function encodeTpResult(goFirst) {
  const packet = new YGOProCtosTpResult();
  packet.res = goFirst ? 1 : 0;
  return full(packet);
}

export function encodeTimeConfirm() {
  return full(new YGOProCtosTimeConfirm());
}

export function encodeResponse(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("response must be non-empty bytes");
  const packet = new YGOProCtosResponse();
  packet.response = Uint8Array.from(bytes);
  return full(packet);
}

export function encodeChat(text) {
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_CHAT_UNITS) {
    throw new Error(`chat text must be 1..${MAX_CHAT_UNITS} UTF-16 units`);
  }
  const packet = new YGOProCtosChat();
  packet.msg = text;
  return full(packet);
}

export function encodeSurrender() {
  return full(new YGOProCtosSurrender());
}

export function encodePlayerInfo(name) {
  const packet = new YGOProCtosPlayerInfo();
  packet.name = fixedText(name, "name");
  return Buffer.from(packet.toFullPayload());
}

export function encodeJoinGame(version, room) {
  if (!Number.isInteger(version) || version < 0 || version > 0xffff) {
    throw new Error("version must fit in uint16");
  }
  const packet = new YGOProCtosJoinGame();
  packet.version = version;
  packet.gameid = 0;
  packet.pass = fixedText(room, "room");
  return Buffer.from(packet.toFullPayload());
}

export function encodeLeaveGame() {
  return Buffer.from(new YGOProCtosLeaveGame().toFullPayload());
}

export function parseServerPacket(packet) {
  const bytes = Buffer.from(packet);
  if (bytes.length < 3 || bytes.readUInt16LE(0) !== bytes.length - 2) {
    throw new Error("invalid server packet length");
  }
  const message = YGOProStoc.getInstanceFromPayload(bytes) ?? {
    kind: "unknown", id: bytes[2], byteLength: bytes.length,
  };
  return { message, raw: bytes.subarray(3) };
}

export function rejectedVersion(message) {
  return message instanceof YGOProStocErrorMsg && message.msg === ErrorMessageType.VERERROR
    ? message.code : null;
}

export function joinFailure(message) {
  if (!(message instanceof YGOProStocErrorMsg) || message.msg === ErrorMessageType.VERERROR) {
    return null;
  }
  return `${ErrorMessageType[message.msg] ?? `msg${message.msg}`}:${message.code}`;
}

function fixedText(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 19 || value.includes("\0")) {
    throw new Error(`${label} must be 1..19 UTF-16 units without NUL`);
  }
  return value;
}
