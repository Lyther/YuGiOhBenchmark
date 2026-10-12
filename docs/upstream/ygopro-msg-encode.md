# ygopro-msg-encode 1.3.0: three response defects and a shuffle decoder defect

Status: prepared, not filed. Filing upstream needs the project owner's go-ahead (roadmap P3.2).

Each case has a failing test in [`spec/upstream-msg-encode.test.js`](../../spec/upstream-msg-encode.test.js), run with `node --test spec/upstream-msg-encode.test.js`. Sources: ygopro-msg-encode at `9a53630`, ygopro-core at `e5ce3178`, ygopro at `bfa360f6`.

## 1. `YGOProMsgSelectSum.prepareResponse` drops the mandatory slots

With one must-select card and a choice of `IndexResponse(1)`, the library writes `[2, 1]`.

- ocgcore reads the chosen indices only after the must-select slots ([`select_with_sum_limit`](https://github.com/Fluorohydride/ygopro-core/blob/e5ce3178a7d78d3d31de0ef40993cb83b34772ce/playerop.cpp#L689-L703)).
- The stock client lists the must-select cards first ([duelclient](https://github.com/Fluorohydride/ygopro/blob/bfa360f631010f9eb9d74d1054e2732388de7860/gframe/duelclient.cpp#L2074-L2090), [event_handler](https://github.com/Fluorohydride/ygopro/blob/bfa360f631010f9eb9d74d1054e2732388de7860/gframe/event_handler.cpp#L2432-L2441)).

Expected bytes: `[2, 0, 1]`, that is the total count, one byte per mandatory card, then the chosen indices. Without the padding the core reads the wrong cards, or answers `MSG_RETRY`.

## 2. `YGOProMsgSelectCounter.prepareResponse` matches every card to itself

A semantic option `{ card: { code: 46986414 }, count: 1 }` for the second of two cards writes `[1, 0, 0, 0]`: the counters go to the first card. The matcher's inner arrow shadows its parameter (`card.code == null || card.code === card.code`), so every card matches. Expected: `[0, 0, 1, 0]`. `IndexResponse` options are not affected.

## 3. `YGOProMsgSortCard.prepareResponse` writes the inverse order

For the new order "third card, first card, second card" (`IndexResponse(2), IndexResponse(0), IndexResponse(1)`) the library writes `[2, 0, 1]`, the cards in their new order. ocgcore reads byte *i* as the new position of card *i* ([`PROCESSOR_SORT_DECK`](https://github.com/Fluorohydride/ygopro-core/blob/e5ce3178a7d78d3d31de0ef40993cb83b34772ce/processor.cpp#L677-L682): `tc[returns.bvalue[i]] = core.select_cards[i]`), as the stock client sends it ([event_handler](https://github.com/Fluorohydride/ygopro/blob/bfa360f631010f9eb9d74d1054e2732388de7860/gframe/event_handler.cpp#L751-L780): `respbuf[i] = sort_list[i] - 1`). Expected: `[1, 2, 0]`. A two-card swap is its own inverse, so it looks correct; any cyclic order of three or more cards is wrong.

## 4. `YGOProMsgShuffleSetCard` interleaves two location arrays

The engine writes `location`, `count`, all `count` old locations, then all `count` new locations. Each location occupies four bytes. A zero new location hides that card's destination; a nonzero location preserves the movement of visible Xyz materials ([engine writer](https://github.com/Fluorohydride/ygopro-core/blob/e5ce3178a7d78d3d31de0ef40993cb83b34772ce/libduel.cpp#L1612-L1635)). The codec instead declares an array of interleaved `{oldLocation, newLocation}` pairs ([codec declaration](https://github.com/purerosefallen/ygopro-msg-encode/blob/9a53630de5a31f29229866c19697684b9baa4267/src/protos/msg/proto/shuffle-set-card.ts#L20-L38)).

For two cards, the second old location becomes the first new location, and the first new location becomes the second old location. The regression uses independent wire bytes, so the codec's encoder cannot hide its decoder error. The seat repairs this one message at the packet boundary and preserves the original bytes for capture.
