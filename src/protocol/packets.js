import {
  ErrorMessageType,
  YGOProCtosJoinGame,
  YGOProCtosLeaveGame,
  YGOProCtosPlayerInfo,
  YGOProStoc,
  YGOProStocErrorMsg,
} from "ygopro-msg-encode";

export const CLIENT_VERSION = 0x1362;

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
