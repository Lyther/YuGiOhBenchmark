import { YGOProStocGameMsg } from "ygopro-msg-encode";

import { parseServerPacket } from "../../src/protocol/packets.js";

// SUBSTITUTE_JUSTIFICATION
// - substitute: constructed message fields in gameMessage/gamePacket/stoc/
//   stocPacket, plus explicit stock-layout vectors in protocol/packets.test.js
//   and game/board.test.js; used by game, controller and view diagnostics.
// - replaces: server-produced input messages, never the production parser.
// - necessity: exact selection values, hidden shuffle destinations and packet
//   order must be controlled. Hosted 2339 has no interface for injecting these
//   states; normal live play cannot guarantee this complete set of cases.
// - proof-limit: codec round trips can share a codec defect. Independent byte
//   vectors test that risk, but neither kind qualifies a live duel.
// - real-proof: npm run smoke covers the lobby/surrender path; normal duel
//   captures and accepted gameplay responses remain P1.11/P1.12.
export function gameMessage(MessageClass, fields) {
  const message = Object.assign(new MessageClass(), fields);
  const packet = new YGOProStocGameMsg();
  packet.msg = message;
  return parseServerPacket(Buffer.from(packet.toFullPayload())).message.msg;
}

export function stocPacket(PacketClass, fields = {}) {
  return Buffer.from(Object.assign(new PacketClass(), fields).toFullPayload());
}

export function stoc(PacketClass, fields = {}) {
  return parseServerPacket(stocPacket(PacketClass, fields)).message;
}

export function gamePacket(MessageClass, fields) {
  const packet = new YGOProStocGameMsg();
  packet.msg = Object.assign(new MessageClass(), fields);
  return Buffer.from(packet.toFullPayload());
}
