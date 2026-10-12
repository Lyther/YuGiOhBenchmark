import assert from "node:assert/strict";
import test from "node:test";

import { mergeStrings, parseStringsConf } from "../../src/cards/strings-conf.js";

const SAMPLE = [
  "#The first line is used for comment",
  "#system",
  "!system 95 Use the effect of [%ls]?",
  "!system 1010 Earth",
  "!victory 0x1 LP reached 0",
  "!counter 0x1002 Wedge Counter",
  "!setname 0x2 Genex",
  "#!setname 0x3 commented out",
  "!setname 0x1002 R-Genex",
  "!system 1700 ",
  "!unknown 0x1 ignored",
  "!system x broken key",
].join("\r\n");

test("strings.conf sections parse with decimal and hex keys", () => {
  const strings = parseStringsConf(SAMPLE);
  assert.equal(strings.system.get(95), "Use the effect of [%ls]?");
  assert.equal(strings.system.get(1010), "Earth");
  assert.equal(strings.victory.get(1), "LP reached 0");
  assert.equal(strings.counter.get(0x1002), "Wedge Counter");
  assert.equal(strings.setname.get(0x2), "Genex");
  assert.equal(strings.setname.get(0x1002), "R-Genex");
  assert.equal(strings.setname.has(0x3), false, "commented lines are skipped");
  assert.equal(strings.system.get(1700), "", "an empty text is kept as empty");
  assert.equal(strings.system.size, 3, "malformed keys and unknown sections are skipped");
});

test("later sets override earlier ones key by key", () => {
  const chinese = parseStringsConf("!system 1010 地\n!setname 0x99 只在中文");
  const english = parseStringsConf("!system 1010 Earth");
  const merged = mergeStrings([chinese, english]);
  assert.equal(merged.system.get(1010), "Earth");
  assert.equal(merged.setname.get(0x99), "只在中文", "gaps are filled from lower priority");
});
