import assert from "node:assert/strict";
import test from "node:test";

import { YGOProCtosJoinGame } from "ygopro-msg-encode";

import { readConfig } from "../src/config.js";
import { encodeJoinGame } from "../src/protocol/packets.js";

test("default match options survive the protocol's room-name limit", () => {
  const config = readConfig({});
  assert.equal(config.host, "koishi.momobako.com");
  assert.equal(config.port, 2339);
  assert.match(config.name, /^ygobench-[0-9a-f]{4}$/);
  assert.equal(config.version, 0x1362);
  assert.match(config.room, /^M,TM0,NF#yb[0-9a-f]{8}$/);

  const packet = new YGOProCtosJoinGame();
  packet.fromFullPayload(encodeJoinGame(config.version, config.room));
  assert.equal(packet.pass, config.room);
});

test("seat configuration requires an explicit room; probe configuration generates one", () => {
  assert.throws(() => readConfig({}, { roomRequired: true }), /YGO_ROOM/);
  assert.equal(readConfig({ YGO_ROOM: "room" }, { roomRequired: true }).room, "room");
  const config = readConfig({});
  assert.equal(config.waitMs, 240000);
  assert.equal(config.capture, false);
  assert.equal(config.logLevel, "info");
  assert.equal(config.deck, null);
  assert.equal(config.runDir, "./runs");
  assert.equal(config.cardsDir, "./data/cards");
});

test("configuration enforces the contract's numeric and fixed-string boundaries", () => {
  for (const [key, values] of Object.entries({
    YGO_PORT: ["0", "65536", "2.5", "oops"],
    YGO_VERSION: ["-1", "65536", "0x10000", "0x", "0x1362junk"],
    YGO_WAIT_MS: ["999", "1500001", "1000ms"],
    YGO_CAPTURE: ["true", "2"],
    YGO_LOG_LEVEL: ["verbose"],
    YGO_NAME: ["x".repeat(20), "a\0b"],
    YGO_ROOM: ["x".repeat(20), "a\0b"],
  })) {
    for (const value of values) {
      assert.throws(() => readConfig({ [key]: value }), new RegExp(key));
    }
  }
  const name = `${"龍".repeat(17)}🃏`;
  const low = readConfig({ YGO_PORT: "1", YGO_VERSION: "0", YGO_WAIT_MS: "1000", YGO_NAME: name });
  assert.equal(low.port, 1);
  assert.equal(low.version, 0);
  assert.equal(low.waitMs, 1000);
  assert.equal(low.name, name);
  const high = readConfig({ YGO_PORT: "65535", YGO_VERSION: "0xFFFF", YGO_WAIT_MS: "1500000", YGO_CAPTURE: "1" });
  assert.equal(high.port, 65535);
  assert.equal(high.version, 65535);
  assert.equal(high.waitMs, 1500000);
  assert.equal(high.capture, true);
});

test("readConfig accepts a hex version and rejects a bad port", () => {
  const config = readConfig({
    YGO_VERSION: "0x10",
    YGO_ROOM: "room",
    YGO_NAME: "n",
  });
  assert.equal(config.version, 0x10);
  assert.equal(config.room, "room");
  assert.throws(() => readConfig({ YGO_PORT: "nope" }), /YGO_PORT/);
});
