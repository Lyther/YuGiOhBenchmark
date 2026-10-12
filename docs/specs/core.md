# Core Spec: Lobby Probe Reorganization

Status: GREEN core (2026-10-07); original RED evidence retained below

Scope: the transport portions of roadmap P1.1 and P1.2, plus P1.3; other dependencies and packet builders remain pending. That is shared config, framing and the packet codec, one TCP connection owner, and the `bin/probe` entry point. This spec only pins the two contract gaps in the current lobby probe that the reorganization must close. It does not cover the rest of P1.

Test: [`test/core-contract.test.js`](../../test/core-contract.test.js)

## Contract

- **Outcome.**
  - `YGO_VERSION` accepts only a whole uint16 written in hex or decimal.
  - The probe passes server chat through unchanged.
- **Preserved behavior.** The seven baseline checks are retained in `test/config.test.js` and `test/protocol/framing.test.js`. Imports follow the new file layout, parsed messages are unwrapped from `{message, raw}`, and the default-name assertion follows the accepted `ygobench-<4 hex>` contract. Their other expectations are unchanged.

| Case | Input/state | Observable outcome | Error/effect | Invariant |
|---|---|---|---|---|
| V1 | `readConfig({YGO_VERSION: "0x1362"})` | `version === 0x1362` | none | valid hex accepted |
| V2 | `readConfig({YGO_VERSION: "4962"})` | `version === 4962` | none | valid decimal accepted |
| V3 | `readConfig({YGO_VERSION: "0x1362garbage"})` | no config returned | throws, message names `YGO_VERSION` | the whole value must parse; a valid prefix is not enough |
| C1 | real `YGOProStocChat`, `player_type 0`, msg `"first\n" + "x".repeat(210)` (216 units), encoded with `toFullPayload` and read back with `parseServerPacket` | parsed message is a `YGOProStocChat` with the same msg | none | codec round-trip is exact (setup guard) |
| C2 | `describeMessage(parsed)` from C1 | `type === "chat"`, `message` equals the sent text, length 216 | none | no newline rewrite, no truncation |

- **Oracles.** Each one comes from the accepted docs, not from what the code currently outputs:
  - V1–V3: [contracts.md](../contracts.md) Configuration says `YGO_VERSION` is "uint16, hex or decimal", and "an invalid value stops the process at start, with the variable named".
  - C1–C2: [architecture.md](../architecture.md) `C-03` says "server output passes through unchanged". [contracts.md](../contracts.md) MCP results say "the seat never drops or shortens anything".
  - The test text is 216 units. That is under the codec's `STOC_CHAT` `MAX_LENGTH` of 256, so the codec itself does not shorten it.
- **Independence.** The spec was written in a fresh session from the accepted contracts and the roadmap. Expected values were not copied from the probe's output.

## RED Evidence

- **Command.** `node --test test/core-contract.test.js`
- **Result.** tests 2, pass 0, fail 2, exit 1.
- **V3** fails at `test/core-contract.test.js:14` with `AssertionError [ERR_ASSERTION]: Missing expected exception.` V1 and V2 pass on the lines before it. `readVersion` uses `Number.parseInt(raw, 16)`, which stops at the first non-hex character and returns `0x1362`.
- **C2** fails at `test/core-contract.test.js:29` with `strictEqual`:
  - actual: `'first ' + 'x'.repeat(194)` (200 units, newline replaced by a space);
  - expected: `'first\n' + 'x'.repeat(210)`.

  The C1 guard and the `type` check pass first. The cause is `replaceAll("\n", " ").slice(0, 200)` in `describeMessage`.
- **Not a setup failure.** Both failures are assertion failures inside the test bodies, after the imports load and the setup guards pass.
- **Anti-cheat.** This was checked by reading the tests; no stub was run.
  - An implementation that always throws fails V1 and V2.
  - A constant-returning version parser fails V3, which requires an exception. V1 and V2 represent the same value in different input formats.
  - C2 rejects newline rewriting and shortening. The retained version-error test also requires `describeMessage` to return a different result shape; one constant result cannot satisfy both.
- **Existing suite.** `node --test test/seat/config.test.js test/protocol/framing.test.js` gives tests 7, pass 7. This was the pre-implementation baseline; current green evidence follows below.

## Initial RED Proof Boundary

- **Real components exercised.**
  - `readConfig` from `src/seat/join-room.js`.
  - `parseServerPacket` and `describeMessage` from `src/protocol/index.js`.
  - `YGOProStocChat` from `ygopro-msg-encode` 1.3.0.
  - No mocks or substitutes.
- **Not proven.**
  - The live server, the TCP connection owner, and the probe's printed JSON.
  - Config variables other than `YGO_VERSION`.
  - Non-ASCII chat, sender types other than 0, and chat longer than the codec's 256-unit limit.
- **Handoff to `dev-core`.** P1.2 moves `describeMessage` into `src/bin/probe.js` and config into `src/config.js`. When those modules move, update the two imports in the test file. Keep the assertions.

## Verdict

PASS for the initial RED spec. The two assertions subsequently passed through the new production paths; only imports and extraction of `message` from the new parse result changed. No assertion was removed or weakened.

## Core Delivery

- Runnable path: `npm run probe` → shared config → real codec → TCP connection → hosted lobby → JSON report → leave.
- Production ownership: `src/config.js`, `src/log.js`, `src/protocol/{framing,packets}.js`, `src/net/connection.js`, `src/bin/probe.js`.
- Deliberately absent: the MCP server, card catalog, decks, duel controller, board/prompts, replay writer, and model matches. These remain in [remaining.md](remaining.md).
- `npm test`: 19 passed, 0 failed; this includes both initial RED assertions now green.
- `npm audit`: zero advisories with production and dev dependencies.
- Real entry point: joined and left `M,TM0,NF#yb5f8c0195`; returned `mode 1`, `timeLimit 0`, `lflist 0`.
- Real version retry: starting at `0x1351` reconnected once at `0x1362` and joined `M,TM0,NF#ybeaa8ccc8`.
- Real error paths: a 1 ms connect attempt to 2339 timed out; invalid CLI configuration exited 1 with its variable named on stderr and no stdout.
- Local transport checks cover ordered writes, split/coalesced packets, parse errors, partial EOF, refusal, and local close. They use real TCP sockets and the installed codec. They do not prove game behavior.
- Dependency vetting: `pino` 10.4.0, MIT, published 2026-10-02; 13 added packages, MIT/ISC licenses, no declared install scripts, compatible with Node ≥22. `npm audit --omit=dev` returned zero advisories.
- The later spec uses dev-only `@modelcontextprotocol/client` 2.3.1, Apache-2.0, published 2026-10-05, Node ≥20; 13 added packages, no declared install scripts, zero audit advisories. It does not add an MCP server to production.
- No commits or publication were performed.
