import assert from "node:assert/strict";
import test from "node:test";

import {
  IndexResponse,
  YGOProMsgSelectCounter,
  YGOProMsgSelectSum,
  YGOProMsgSortCard,
  YGOProStoc,
} from "ygopro-msg-encode";

// Failing tests for the upstream report in docs/upstream/ygopro-msg-encode.md.
// Run alone with `node --test spec/upstream-msg-encode.test.js`; they stay RED
// until ygopro-msg-encode 1.3.0 is fixed. The seat works around the response
// encodings in prompts/selections.js and the shuffle decoder in packets.js.
const card = (code, sequence) => ({ code, controller: 0, location: 0x04, sequence });

test("SELECT_SUM: chosen indices follow the mandatory slots, like the stock client", () => {
  const message = Object.assign(new YGOProMsgSelectSum(), {
    mode: 0, player: 0, sumVal: 8, min: 1, max: 1,
    mustSelectCount: 1, mustSelectCards: [{ ...card(46986414, 0), opParam: 7 }],
    count: 2, cards: [{ ...card(40044918, 1), opParam: 4 }, { ...card(14558127, 2), opParam: 1 }],
  });
  // ocgcore select_with_sum_limit reads the chosen cards from index mcount on.
  assert.deepEqual([...message.prepareResponse([IndexResponse(1)])], [2, 0, 1]);
});

test("SELECT_COUNTER: a card chosen by code gets the counters, not the first card", () => {
  const message = Object.assign(new YGOProMsgSelectCounter(), {
    player: 0, counterType: 1, counterCount: 1, count: 2,
    cards: [{ ...card(89631139, 0), counterCount: 1 }, { ...card(46986414, 1), counterCount: 1 }],
  });
  assert.deepEqual([...message.prepareResponse([{ card: { code: 46986414 }, count: 1 }])], [0, 0, 1, 0]);
});

test("SORT_CARD: byte i is the new position of card i, as ocgcore reads it", () => {
  const message = Object.assign(new YGOProMsgSortCard(), {
    player: 0, count: 3, cards: [card(89631139, 0), card(14558127, 1), card(23434538, 2)],
  });
  // New order: third card first, then the first, then the second.
  assert.deepEqual([...message.prepareResponse([IndexResponse(2), IndexResponse(0), IndexResponse(1)])], [1, 2, 0]);
});

test("SHUFFLE_SET_CARD: old locations and new locations are separate arrays", () => {
  const packet = Uint8Array.from([20, 0, 1, 36, 4, 2,
    1, 4, 0, 8, 1, 4, 3, 8,
    0, 0, 0, 0, 1, 4, 0, 8]);
  const { msg } = YGOProStoc.getInstanceFromPayload(packet);
  assert.deepEqual(msg.cards.map(({ oldLocation, newLocation }) => [
    oldLocation.controller, oldLocation.location, oldLocation.sequence,
    newLocation.controller, newLocation.location, newLocation.sequence,
  ]), [[1, 4, 0, 0, 0, 0], [1, 4, 3, 1, 4, 0]]);
});
