import assert from "node:assert/strict";
import test from "node:test";

import {
  ErrorMessageType,
  YGOProCtosJoinGame,
  YGOProCtosPlayerInfo,
  YGOProStocErrorMsg,
} from "ygopro-msg-encode";

import { describeMessage } from "../../src/bin/probe.js";
import { PacketFramer } from "../../src/protocol/framing.js";
import {
  encodeJoinGame,
  encodePlayerInfo,
  parseServerPacket,
  rejectedVersion,
} from "../../src/protocol/packets.js";

test("player and join packets round-trip through the codec", () => {
  const player = new YGOProCtosPlayerInfo();
  player.fromFullPayload(encodePlayerInfo("ygobench"));
  assert.equal(player.name, "ygobench");

  const join = new YGOProCtosJoinGame();
  join.fromFullPayload(encodeJoinGame(0x1362, "yb00112233"));
  assert.equal(join.version, 0x1362);
  assert.equal(join.gameid, 0);
  assert.equal(join.pass, "yb00112233");
});

test("text fields stay inside the 20-unit YGOPro slot", () => {
  assert.throws(() => encodePlayerInfo(""), /name/);
  assert.throws(() => encodeJoinGame(1, "x".repeat(20)), /room/);
  assert.throws(() => encodeJoinGame(0x10000, "room"), /uint16/);
});

test("framer rejects an empty declared length", () => {
  const framer = new PacketFramer();
  assert.throws(() => framer.push(Buffer.from([0x00, 0x00])), /length/);
});

test("framer splits complete packets and holds a partial tail", () => {
  const first = encodePlayerInfo("ygobench");
  const second = encodeJoinGame(0x1362, "yb00112233");
  const framer = new PacketFramer();
  assert.equal(framer.push(first.subarray(0, 5)).length, 0);
  const packets = framer.push(Buffer.concat([first.subarray(5), second]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].length, first.length);
  assert.equal(packets[1].length, second.length);
});

test("version mismatch exposes the server version", () => {
  const error = new YGOProStocErrorMsg();
  error.msg = ErrorMessageType.VERERROR;
  error.code = 0x1351;
  const { message: parsed } = parseServerPacket(Buffer.from(error.toFullPayload()));
  assert.equal(rejectedVersion(parsed), 0x1351);
  assert.deepEqual(describeMessage(parsed), {
    type: "error",
    msg: "VERERROR",
    code: 0x1351,
  });
});
