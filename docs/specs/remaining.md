# Remaining Spec: Seat Entry Point and Open Roadmap

Status: GREEN (2026-10-07; RED evidence retained below)

Scope: everything left after the core (roadmap P1.1–P1.3 transport and probe, see [core.md](core.md)). One executable test pins the MCP seat entry point that P1.9 must deliver. The rest of the roadmap is a behavior table that names the step and the proof that will cover each row. That table is not executable and is not a test suite.

Test: [`spec/seat-entry.test.js`](../../spec/seat-entry.test.js), run with `node --test spec/seat-entry.test.js`. It stays outside `npm test` (`node --test "test/**/*.test.js"`) because it needs downloaded card data. The original RED baseline joined the live 2339 server; the implemented seat is tested before deck submission.

## Entry-Point Contract

- **Outcome.** `node src/bin/seat.js` is a stdio MCP server. It accepts the 2025-06-18 `initialize`, lists the contract's tools in order, and answers `wait` with the deck prompt before any socket is opened.
- **Entry selection.** The test spawns `src/bin/seat.js` when it exists, otherwise `src/bin/probe.js`, and names the selected path in the test title and every diagnostic. The probe is a test-only baseline, so the RED fails on behavior rather than on a missing file. It is not a runtime compatibility path: the seat never falls back to the probe.
- **Prerequisite for GREEN.** P1.4 must have run `npm run cards` so that `data/cards/en-US/{cards.cdb,strings.conf}` exist. Without them the test stops with `BLOCKED, not RED` before spawning the seat (line 42).
- **Live contact.** The original probe baseline touched 2339. The seat is required to join only at its first deck submit (AD-04), which this test never sends. This test checks the initial view and tool errors; it does not observe the seat's sockets or prove a game or match.

| Case | Input/state | Observable outcome | Error/effect | Invariant |
|---|---|---|---|---|
| E0 | entry is `seat.js` | en-US card files present | missing → `BLOCKED, not RED`; nothing spawned | the seat refuses to start without en-US data |
| E1 | real `StdioClientTransport` spawns the entry with `YGO_HOST=koishi.momobako.com`, `YGO_PORT=2339`, a fresh `M,TM0,NF#sp<8 hex>` room (19 units), name `spec-<4 hex>`, `YGO_WAIT_MS=1000`, a temp run dir; the client offers only `2025-06-18` | `initialize` succeeds; the tools capability is advertised | — | the D-01 handshake is accepted |
| E2 | `tools/list` | exactly `wait, answer, deck_show, deck_edit, card, card_search, chat, surrender`, in that order; each declares `_meta["anthropic/maxResultSizeChars"] = 500000` | — | no placeholder tools; the Phase 1 list lacked the two deck tools until P2.1 |
| E3 | `wait {format: "json"}` | one text block holding a SeatView: `phase "deck"`, `room` and `you.name` equal the env values, `opponent null`, `disconnected null`, `prompt.kind "deck"`, integer `prompt.seq ≥ 1`, non-empty `next` | — | lazy join: no lobby before submit |
| E4 | `answer {choose: [1]}` at the deck prompt | `isError: true` with a reason | nothing sent | an answer field must fit the prompt kind |
| E5 | `chat {text: "hello"}` before any submit, then `wait` again | chat → `isError: true` with a reason; `wait` → still `deck`, same `prompt.seq`, `opponent null` | nothing sent; no join | rejected calls change no seat state |
| E6 | all child stdout | every line is JSON-RPC | — | only the MCP transport writes stdout |

- **Oracles.** [contracts.md](../contracts.md) MCP Tools (order, `_meta`, `wait`, `answer`, `chat`, seat-state `isError` cases) and DTOs (SeatView); [architecture.md](../architecture.md) D-01, AD-04, Runtime View Start, and the stdout rule in Implementation Guardrails; [roadmap.md](../roadmap.md) P1.9 scope. None was copied from implementation output.
- **Failure classes when `initialize` fails.** Each has its own assertion line, and all print the entry path, server, room, client error, child exit, transport errors, child stdout and stderr.
  - `SETUP FAILURE, not the intended RED` (line 76): the client error or child stderr names DNS, connect, join, version, missing-module or card-data trouble.
  - `NOT THE INTENDED RED` (line 78): any other failure without the baseline signature.
  - `RED` (line 79): the child exited 0 after writing stdout with no JSON-RPC line, and the SDK closed without an `initialize` result.
- **Observation.** Child stdout and the exit code come from Node's public `child_process` diagnostics channel. The SDK's `ReadBuffer` silently drops non-JSON stdout lines, so the client error alone (`CONNECTION_CLOSED`) cannot tell a non-MCP program from a crash.

## Remaining Behavior

Each row is owned by its roadmap step. The proof column names that step's test or live run; this spec does not execute it.

| Step | Input/state | Observable outcome | Error/effect | Invariant | Proof |
|---|---|---|---|---|---|
| P1.1 rest | `package.json` | `seat`, `smoke`, `cards` scripts; exact pins for `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5, `ygopro-deck-encode` 1.0.16, `ygopro-cdb-encode` 1.1.1 | `npm audit --omit=dev` reports 0 | exact pins | audit output in the commit |
| P1.2 rest | gameplay CTOS builders: update deck, `HS_READY`, `HS_START`, hand result, TP result, time confirm, response, chat, surrender | each packet parses back through `ygopro-msg-encode` with the same fields | bad input throws before any send | no sockets in `packets.js`; chat text unchanged | `test/protocol/packets.test.js` |
| P1.4 | `npm run cards` | contract layout filled; counts printed; a known code gives English text; a super-pre code gives community English, else MyCard Chinese, and names its source | a failed download keeps the old files; missing en-US stops the seat naming `npm run cards` | merge order zh-CN < super-pre < super-pre-en < en-US | `catalog.test.js`, `sources.test.js`, one live refresh |
| P1.5 | YDK, `ydke://`, deck code | exact round trips; Fusion/Synchro/Xyz/Link go to extra; `UPDATE_DECK` payload | — | no legality checks | `deck.test.js`, `decks/sample.ydk` |
| P1.6 | server `DECKERROR`, `SIDEERROR`, `MSG_RETRY`, `TIME_LIMIT`, `DUEL_END` | rejected deck, side or re-issued prompt; `TIME_CONFIRM` on receipt; `ended` only after one replay per duel, a server close or 15 s | `aborted` line on disconnect; write failures become events | phase moves only along contracts Domain Model | `controller.test.js`, `record.test.js` |
| P1.7 | captured duel messages | zones equal the latest `UPDATE_DATA` plus deltas; me/opponent from each `MSG_START` | unknown type → `unreadable` event plus log | no rule inference | `board.test.js`, `events.test.js` |
| P1.8 | the 20 response-bearing messages plus RPS, first, deck, side | numbered options; `encode` matches stock-client bytes; `SELECT_SUM` padded for must-select cards (D-02) | a tribute with a two-tribute card is never auto-answered | auto-answers follow AD-07 only; Q-04 zeroed code labeled by name | `prompts.test.js` |
| P1.9 rest | event backlog; every prompt kind | every event delivered once, in order; every kind renders; `answer` with nothing pending → `isError` | — | no internal field in any DTO | `view.test.js`, `render.test.js`, `tools.test.js` |
| P1.10 | `npm run smoke -- --room 'M,TM0,NF#<id>'`; Claude Code `-p` and Codex `exec` | smoke exits 0 with both run folders complete; each runtime lists tools and gets the deck prompt | handshake failure → SDK v1 swap (AD-03) | super-pre acceptance recorded | live runs, committed sessions |
| P1.11 | two agents, operator decks | `match` line, one replay per duel, `.ydk` per duel; a replay opens in KoishiPro | — | contiguous event numbers over long waits (Q-05) | live match, transcripts |
| P1.12 | committed sessions | every packet parses; phases and zones match the live runs | — | keepalives and auto-passes where the bytes require them | offline replay tests |
| P2.1 | `deck_show`, `deck_edit` | edits apply in the order import, clear, remove, add, move; the tool list has all eight tools | unknown or ambiguous name → `isError` with up to 5 suggestions | edits allowed in any phase; only the submitted deck matters | `deck.test.js`, `tools.test.js` |
| P2.2 | agents build and side their own decks | a complete Bo3; at least one side submission changed a deck | — | the server is the only deck check | live match |
| P2.3 | P2.2 runs | prompts, auto-answers, polls, result sizes, tokens and cost per match recorded | — | decisions recorded as AD updates | architecture Risks |
| P3.1 | a fresh clone and the README | reaches a passing `npm run smoke` | — | full match instructions agree with the implemented commands; stale links were fixed in the core cleanup | fresh-clone run |
| P3.2 | `SELECT_SUM` padding, `SELECT_COUNTER` matcher | report text plus a failing test for each | filing upstream waits for the user | — | prepared reports |

## RED Evidence

- **Command.** `node --test spec/seat-entry.test.js`
- **Result.** tests 1, pass 0, fail 1, exit 1, about 3.7 s.
- **Intended failure.** `assert.fail` at line 79: `RED: src/bin/probe.js does not answer MCP initialize (protocolVersion 2025-06-18); it wrote non-JSON-RPC stdout and exited 0.`
  - Client error: `CONNECTION_CLOSED: Connection closed`. Child exit 0, no transport errors, empty stderr.
  - Child stdout: 672 bytes of lobby JSON for room `M,TM0,NF#sp34f4904d` at version `0x1362`, with `mode 1`, `timeLimit 0`, `lflist 0`, `rule 5`, host position 0, and the server line `[Server]: YGOPro Koishi Server - 2339`. Exit 0 followed the probe's normal cleanup path, which sends `LEAVE_GAME`; there was no separate server-side observation of departure.
- **Independent rerun.** The same command again failed at the intended MCP assertion in about 3.1 s, after a successful lobby response for `M,TM0,NF#spf2be6380`; child exit 0, 672 stdout bytes, empty stderr.
- **Setup classification check.** A separate `YGO_HOST=nonexistent.invalid YGO_ROOM='M,TM0,NF#spdnscheck' node src/bin/probe.js` run exited 1 with empty stdout and `getaddrinfo ENOTFOUND` on stderr. Inspection confirms that this evidence matches `SETUP_FAILURE` and fails the baseline signature. The test's setup-failure branch was not exercised by substituting a failed child process.
- **Anti-cheat.** Checked by reading; no stub was run and no production file was touched.
  - Constant non-MCP output (today's probe, run live) fails `initialize`.
  - An MCP server with no tools, other tools, a different order or missing `_meta` fails E2.
  - The six tools returning one constant result for every call fail either way. A constant `isError` fails the first `wait` (E3). A constant success fails E4 and E5, because `answer` and `chat` must be errors while `wait` is not.
  - A fixed SeatView, even with distinct per-tool constants, fails E3, because the room and name are random per run.
  - A seat that logs to stdout fails E6.

## GREEN Evidence

- **Command.** `node --test spec/seat-entry.test.js` against the real `src/bin/seat.js`, with card data from `npm run cards`: tests 1, pass 1.
- **E2 change.** E2 first pinned the six Phase 1 tools. When P2.1 implemented `deck_show` and `deck_edit`, the expected list became the contract's eight tools (contracts.md MCP Tools); no other assertion changed.
- **Beyond this spec.** `npm test` supplies offline diagnostics for the listed behavior. The live smoke runs and runtime handshakes in [status](../status.md) cover the connection, lobby, siding and recording paths up to P1.10. They do not exercise normal duel play.

## Current Proof Boundary

- **Entry point:** E0–E6 pass against `src/bin/seat.js`, the real stdio MCP client/server and the downloaded catalog. This checks the handshake, eight tools, initial deck view, rejected calls and stdout framing. It neither submits a deck nor proves a match.
- **Live server:** the earlier RED probe joined and left 2339. Separately, the smoke evidence in [status](../status.md) covers two actual seats through lobby, chat, surrender, siding, match end and native replay writes.
- **Offline diagnostics:** controller tests replace the connection, board/prompt tests construct messages, and catalog tests use controlled card rows. These do not prove the server emits those sequences or accepts every encoded answer. The review found a shuffle codec defect that encoder/decoder round trips alone had missed; its regression uses the engine's byte layout directly.
- **Not run:** a full two-agent match, board comparisons over normal live duels, model-built decks and changed siding in a match, or opening a replay in KoishiPro.
- **Next:** P1.11 with given decks, then P1.12 using its captures and P2.2 with model-built decks. No additional architecture gate is introduced.

## Verdict

The MCP entry-point spec is GREEN; the original RED evidence is retained above. Gameplay acceptance remains with the unrun agent-match steps.
