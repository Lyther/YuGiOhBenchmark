import assert from "node:assert/strict";
import test from "node:test";

import { YGOProCtosLeaveGame, YGOProStocChat } from "ygopro-msg-encode";

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
