import assert from "node:assert/strict";
import test from "node:test";

import { YGOProCtosLeaveGame, YGOProMsgShuffleSetCard, YGOProStocChat } from "ygopro-msg-encode";

import { encodeLeaveGame, parseServerPacket } from "../../src/protocol/packets.js";

test("leave uses the native empty CTOS_LEAVE_GAME packet", () => {
  const bytes = encodeLeaveGame();
  assert.deepEqual(bytes, Buffer.from([1, 0, 0x13]));
  new YGOProCtosLeaveGame().fromFullPayload(bytes);
});

test("server parsing retains exactly the original payload and reports unknown ids", () => {
  const chat = new YGOProStocChat();
  chat.msg = "card text stays intact\n";
  const bytes = Buffer.from(chat.toFullPayload());
  const parsed = parseServerPacket(bytes);
  assert.equal(parsed.message.msg, chat.msg);
  assert.deepEqual(parsed.raw, bytes.subarray(3));
  const unknown = parseServerPacket(Buffer.from([2, 0, 0xff, 42]));
  assert.equal(unknown.message.kind, "unknown");
  assert.equal(unknown.message.id, 0xff);
  assert.deepEqual(unknown.raw, Buffer.from([42]));
  assert.throws(() => parseServerPacket(bytes.subarray(0, bytes.length - 1)), /length/);
});

test("SHUFFLE_SET_CARD decodes the old-location array before the new-location array", () => {
  // Independent wire layout from ocgcore/libduel.cpp duel_shuffle_setcard:
  // all old locations, then all new locations (zero means an undisclosed move).
  const packet = Buffer.from([20, 0, 1, 36, 4, 2,
    1, 4, 0, 8, 1, 4, 3, 8,
    0, 0, 0, 0, 1, 4, 0, 8]);
  const { message, raw } = parseServerPacket(packet);
  assert.ok(message.msg instanceof YGOProMsgShuffleSetCard);
  assert.deepEqual(message.msg.cards.map(({ oldLocation, newLocation }) => [
    oldLocation.controller, oldLocation.location, oldLocation.sequence,
    newLocation.controller, newLocation.location, newLocation.sequence,
  ]), [[1, 4, 0, 0, 0, 0], [1, 4, 3, 1, 4, 0]]);
  assert.deepEqual(raw, packet.subarray(3), "recorded bytes remain exactly as received");
});
