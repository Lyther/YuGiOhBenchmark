import {
  ErrorMessageType,
  YGOProCtosJoinGame,
  YGOProCtosLeaveGame,
  YGOProCtosPlayerInfo,
  YGOProStoc,
  YGOProStocChat,
  YGOProStocErrorMsg,
  YGOProStocHsPlayerChange,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocTypeChange,
} from "ygopro-msg-encode";

// Current KoishiPro PRO_VERSION. A mismatch comes back as STOC_ERROR_MSG
// and the server's own version; the seat then reconnects once with that value.
export const CLIENT_VERSION = 0x1362;

// YGOPro fixed strings are 20 UTF-16 code units, including a trailing NUL.
const MAX_TEXT_UNITS = 19;

const MAX_PACKET_BYTES = 1024 * 1024;

export function encodePlayerInfo(name) {
  const packet = new YGOProCtosPlayerInfo();
  packet.name = requireText(name, "name");
  return Buffer.from(packet.toFullPayload());
}

export function encodeJoinGame(version, room) {
  if (!Number.isInteger(version) || version < 0 || version > 0xffff) {
    throw new Error("version must fit in uint16");
  }
  const packet = new YGOProCtosJoinGame();
  packet.version = version;
  packet.gameid = 0;
  packet.pass = requireText(room, "room");
  return Buffer.from(packet.toFullPayload());
}

export function encodeLeaveGame() {
  return Buffer.from(new YGOProCtosLeaveGame().toFullPayload());
}

export class PacketFramer {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const packets = [];
    while (this.pending.length >= 2) {
      const declared = this.pending.readUInt16LE(0);
      if (declared <= 0 || declared > MAX_PACKET_BYTES) {
        throw new Error(`rejected packet length ${declared}`);
      }
      const total = 2 + declared;
      if (this.pending.length < total) {
        break;
      }
      packets.push(Buffer.from(this.pending.subarray(0, total)));
      this.pending = this.pending.subarray(total);
    }
    return packets;
  }
}

export function parseServerPacket(packet) {
  const view = packet instanceof Uint8Array ? packet : Uint8Array.from(packet);
  const parsed = YGOProStoc.getInstanceFromPayload(view);
  if (parsed === undefined) {
    return {
      kind: "unknown",
      id: view[2] ?? 0,
      byteLength: view.length,
    };
  }
  return parsed;
}

export function rejectedVersion(message) {
  if (
    message instanceof YGOProStocErrorMsg &&
    message.msg === ErrorMessageType.VERERROR
  ) {
    return message.code;
  }
  return null;
}

export function joinFailure(message) {
  if (!(message instanceof YGOProStocErrorMsg)) {
    return null;
  }
  if (message.msg === ErrorMessageType.VERERROR) {
    return null;
  }
  const label = ErrorMessageType[message.msg] ?? `msg${message.msg}`;
  return `${label}:${message.code}`;
}

export function describeMessage(message) {
  if (message instanceof YGOProStocJoinGame) {
    const info = message.info;
    return {
      type: "join",
      lflist: info.lflist,
      rule: info.rule,
      mode: info.mode,
      duelRule: info.duel_rule,
      noCheckDeck: info.no_check_deck,
      noShuffleDeck: info.no_shuffle_deck,
      startLp: info.start_lp,
      startHand: info.start_hand,
      drawCount: info.draw_count,
      timeLimit: info.time_limit,
    };
  }
  if (message instanceof YGOProStocTypeChange) {
    return {
      type: "type",
      position: message.playerPosition,
      host: message.isHost,
    };
  }
  if (message instanceof YGOProStocHsPlayerEnter) {
    return { type: "enter", name: message.name, position: message.pos };
  }
  if (message instanceof YGOProStocHsPlayerChange) {
    return {
      type: "player",
      position: message.playerPosition,
      state: message.playerState,
    };
  }
  if (message instanceof YGOProStocErrorMsg) {
    return {
      type: "error",
      msg: ErrorMessageType[message.msg] ?? message.msg,
      code: message.code,
    };
  }
  if (message instanceof YGOProStocChat) {
    return {
      type: "chat",
      playerType: message.player_type,
      message: message.msg.replaceAll("\n", " ").slice(0, 200),
    };
  }
  if (message && message.kind === "unknown") {
    return { type: "unknown", id: message.id, byteLength: message.byteLength };
  }
  return { type: message?.constructor?.name ?? "unparsed" };
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TEXT_UNITS) {
    throw new Error(`${label} must be 1..${MAX_TEXT_UNITS} characters`);
  }
  return value;
}
