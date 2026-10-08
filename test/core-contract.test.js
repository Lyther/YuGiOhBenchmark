import assert from "node:assert/strict";
import test from "node:test";

import { YGOProStocChat } from "ygopro-msg-encode";

import { describeMessage } from "../src/bin/probe.js";
import { readConfig } from "../src/config.js";
import { parseServerPacket } from "../src/protocol/packets.js";

// contracts.md Configuration: YGO_VERSION is "uint16, hex or decimal";
// an invalid value stops the process with the variable named.
test("YGO_VERSION rejects trailing garbage after a valid hex prefix", () => {
  assert.equal(readConfig({ YGO_VERSION: "0x1362" }).version, 0x1362);
  assert.equal(readConfig({ YGO_VERSION: "4962" }).version, 4962);
  assert.throws(() => readConfig({ YGO_VERSION: "0x1362garbage" }), /YGO_VERSION/);
});

// architecture.md C-03 and contracts.md "never drops or shortens anything".
test("server chat passes through describeMessage unchanged", () => {
  const sent = `first\n${"x".repeat(210)}`;
  const chat = new YGOProStocChat();
  chat.player_type = 0;
  chat.msg = sent;
  const { message: parsed } = parseServerPacket(Buffer.from(chat.toFullPayload()));
  assert.ok(parsed instanceof YGOProStocChat);
  assert.equal(parsed.msg, sent);

  const described = describeMessage(parsed);
  assert.equal(described.type, "chat");
  assert.equal(described.message, sent);
  assert.equal(described.message.length, 216);
});
