import assert from "node:assert/strict";
import test from "node:test";

import {
  YGOProCtos,
  YGOProCtosChat,
  YGOProCtosHandResult,
  YGOProCtosHsReady,
  YGOProCtosHsStart,
  YGOProCtosResponse,
  YGOProCtosSurrender,
  YGOProCtosTimeConfirm,
  YGOProCtosTpResult,
  YGOProCtosUpdateDeck,
} from "ygopro-msg-encode";

import {
  encodeChat,
  encodeHandResult,
  encodeReady,
  encodeResponse,
  encodeStart,
  encodeSurrender,
  encodeTimeConfirm,
  encodeTpResult,
  encodeUpdateDeck,
} from "../../src/protocol/packets.js";

function parse(bytes) {
  assert.equal(bytes.readUInt16LE(0), bytes.length - 2, "length prefix covers id and body");
  return YGOProCtos.getInstanceFromPayload(bytes);
}

test("deck submit carries main+extra count, side count and every code in order", () => {
  const deck = { main: [89631139, 89631139, 55144522], extra: [44508094], side: [14558127, 14558127] };
  const bytes = encodeUpdateDeck(deck);
  const packet = parse(bytes);
  assert.ok(packet instanceof YGOProCtosUpdateDeck);
  const body = bytes.subarray(3);
  assert.equal(body.readUInt32LE(0), 4, "main and extra travel together");
  assert.equal(body.readUInt32LE(4), 2);
  const codes = [];
  for (let offset = 8; offset < body.length; offset += 4) codes.push(body.readUInt32LE(offset));
  assert.deepEqual(codes, [...deck.main, ...deck.extra, ...deck.side]);
  assert.throws(() => encodeUpdateDeck({ main: [0], extra: [], side: [] }), /code/);
  assert.throws(() => encodeUpdateDeck({ main: [2 ** 28], extra: [], side: [] }), /code/);
});

test("lobby and duel control packets parse back as their own types", () => {
  assert.ok(parse(encodeReady()) instanceof YGOProCtosHsReady);
  assert.ok(parse(encodeStart()) instanceof YGOProCtosHsStart);
  assert.ok(parse(encodeTimeConfirm()) instanceof YGOProCtosTimeConfirm);
  assert.ok(parse(encodeSurrender()) instanceof YGOProCtosSurrender);
});

test("rock-paper-scissors and first-player choices keep their wire values", () => {
  for (const choice of [1, 2, 3]) {
    const packet = parse(encodeHandResult(choice));
    assert.ok(packet instanceof YGOProCtosHandResult);
    assert.equal(packet.res, choice);
  }
  assert.throws(() => encodeHandResult(0), /hand/);
  assert.throws(() => encodeHandResult(4), /hand/);
  assert.equal(parse(encodeTpResult(true)).res, 1);
  assert.equal(parse(encodeTpResult(false)).res, 0);
  assert.ok(parse(encodeTpResult(true)) instanceof YGOProCtosTpResult);
});

test("a response packet carries the answer bytes unchanged", () => {
  const answer = Uint8Array.from([2, 0, 1]);
  const bytes = encodeResponse(answer);
  const packet = parse(bytes);
  assert.ok(packet instanceof YGOProCtosResponse);
  assert.deepEqual([...bytes.subarray(3)], [2, 0, 1]);
  assert.throws(() => encodeResponse(new Uint8Array(0)), /response/);
});

test("chat text is sent unchanged and over-long text is refused instead of cut", () => {
  const text = "gg\nwell played — 良い試合";
  const packet = parse(encodeChat(text));
  assert.ok(packet instanceof YGOProCtosChat);
  assert.equal(packet.msg, text);
  assert.equal(parse(encodeChat("x".repeat(255))).msg.length, 255);
  assert.throws(() => encodeChat(""), /chat/);
  assert.throws(() => encodeChat("x".repeat(256)), /chat/);
});
