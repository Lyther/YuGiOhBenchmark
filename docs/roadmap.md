# Roadmap

Status: ACCEPTED (2026-10-07)

Source architecture: [architecture.md](architecture.md)

Contracts: [contracts.md](contracts.md)

Last updated: 2026-10-07

## Roadmap Principles

- Preserve the concept and the architecture. A step that needs a validator, filter, output cap, pin or orchestrator is out of scope (architecture Implementation Guardrails).
- Get two real models playing early. Before that, check only what model play needs: the wire, the MCP handshake and one model-free smoke run. Then fix what real matches find.
- Register each tool once it works. There are no placeholder tools or "not available yet" paths.
- Every step names its files, its proof, and what stays unproven. "Passed" means the command was run.
- Live proofs use the real server and real seat processes. Offline tests use captured server bytes and real `ygopro-msg-encode` objects, never mocks.

## Phase 0: Decision Closure

Objective: settle the decisions that would otherwise force rework.

Exit gate: met on 2026-10-07.

- [x] `P0.1` Adopt the peer2 line and confirm AD-01 (drop the WindBot relay).
  - Done 2026-10-07: after peer#3's review and the corrections it led to, the user accepted the concept, this architecture and the Node seat as the source of truth, and the line was merged into `master`.

- [x] `P0.2` Contracts for the seat.
  - Done: [contracts.md](contracts.md) gives every tool an input schema, a result DTO, error cases and an example.

## Phase 1: First Agent Match

Objective: two real agents, each in its own runtime, play a Bo3 on 2339 through the seat with operator-supplied deck files, while the server bytes are captured for offline tests.

Exit gate:

- Proven: P1.11 finishes with replays and results written and sessions captured; Claude Code and Codex both connect to the seat.
- Unproven: model-built decks and deck edits at side (Phase 2); cost (Phase 2).
- Human input: launching the agents in P1.11.

- [ ] `P1.1` Scaffold, config and logging.
  - Files: `package.json`, `.gitignore`, `.env.example`, `src/config.js`, `src/log.js`, `test/config.test.js`.
  - Scope:
    - Add exact-pinned `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5, `pino` 10.4.0, `ygopro-deck-encode` 1.0.16 and `ygopro-cdb-encode` 1.1.1, plus dev-only `@modelcontextprotocol/client` 2.3.1. This set was audited on 2026-10-07 with 0 vulnerabilities.
    - Scripts `seat`, `smoke`, `cards`, `probe`, `test` (`node --test test`).
    - Ignore `runs/`.
    - `config.js` covers every variable in contracts.md, with limits.
  - Acceptance evidence: `npm test` passes; `npm audit --omit=dev` reports 0; `config.test.js` covers defaults, limits and bad values.
  - Dependencies: P0.

- [ ] `P1.2` Wire split and probe.
  - Files: `src/protocol/framing.js`, `src/protocol/packets.js`, `src/bin/probe.js`, `test/protocol/framing.test.js`, `test/protocol/packets.test.js`; remove `src/protocol/index.js` and `src/seat/join-room.js`.
  - Scope:
    - Move the framer.
    - Add CTOS builders for every packet in architecture Component View.
    - Make STOC parse return `{message, raw}`.
    - Move `describeMessage` and the version retry into the probe.
  - Acceptance evidence: `npm test`. `YGO_ROOM='M,TM0,NF#<id>' npm run probe` prints `mode 1`, `timeLimit 0`, `lflist 0`.
  - Dependencies: P1.1.

- [ ] `P1.3` Connection.
  - Files: `src/net/connection.js`, `test/net/connection.test.js`.
  - Scope: connect timeout, ordered send, framing, parse, close reasons; no game state.
  - Acceptance evidence: tests against a local `net.Server` cover split packets, an oversized packet, server close, and the connect timeout.
  - Dependencies: P1.2.

- [ ] `P1.4` Card data.
  - Files: `src/cards/catalog.js`, `src/cards/strings-conf.js`, `src/cards/sources.js`, `src/bin/cards.js`, `test/cards/catalog.test.js`, `test/cards/sources.test.js`, `test/fixtures/cards.json`.
  - Scope:
    - Download the contract's source list as individual files to temporary names, then rename; no archives.
    - The catalog merges zh-CN, super-pre, super-pre-en and en-US in that order (contracts.md Card Data Inputs), and provides `desc` mapping, name lookup and filter search.
    - The seat refuses to start without the en-US set, so this comes before any seat entry point.
  - Acceptance evidence: `npm test`. `npm run cards` populates `data/cards/` and prints counts. A known code resolves to English text. A super-pre code resolves to the English community text when it exists, otherwise to MyCard's Chinese text, and its card info names the source. A failed download leaves the old files.
  - Dependencies: P1.1.

- [ ] `P1.5` Deck model.
  - Files: `src/deck/deck.js`, `test/deck/deck.test.js`, `decks/sample.ydk`.
  - Scope: YDK, `ydke://` and deck-code import and export; extra-deck placement by catalog type; the `UPDATE_DECK` payload; no legality checks. Add, remove and move edits come with the deck tools in P2.1.
  - Acceptance evidence: round-trip tests; `decks/sample.ydk` loads and encodes.
  - Dependencies: P1.4.

- [ ] `P1.6` Controller and recorder.
  - Files: `src/seat/controller.js`, `src/seat/record.js`, `test/seat/controller.test.js`, `test/seat/record.test.js`.
  - Scope:
    - Phases `deck → lobby → rps → first → duel → side → ended | disconnected`, with the deck from `YGO_DECK`.
    - Lazy join with one version retry; `UPDATE_DECK` and `HS_READY`; host `HS_START`.
    - Keepalive confirm; `MSG_RETRY` → rejected prompt; `DECKERROR`/`SIDEERROR` → rejected deck or side prompt. Until P2.1, `submit` at side resends the deck unchanged.
    - Results and replays. At `DUEL_END`, `ended` waits for one replay per duel played, a server close or 15 s. `session.bin` when `YGO_CAPTURE=1`.
    - Chat both ways; surrender.
  - Acceptance evidence:
    - Record tests pass.
    - Controller tests built from real `ygopro-msg-encode` objects show `DECKERROR`, `SIDEERROR` and `MSG_RETRY` coming back as rejected prompts (Q-03), keepalives answered on receipt, and `ended` held until the replays arrive, including after a one-duel match.
  - Dependencies: P1.3, P1.5.

- [ ] `P1.7` Board, events and labels.
  - Files: `src/game/board.js`, `src/game/events.js`, `src/game/labels.js`, `test/game/board.test.js`, `test/game/events.test.js`.
  - Scope: the reducer for every zone-changing message listed in architecture Component View; per-duel me/opponent mapping from `MSG_START`; readable event records for every non-prompt message; selection-hint tracking; `unreadable` for unknown types; zone and card labels.
  - Acceptance evidence: every event kind and board delta is tested from real encoded messages.
  - Dependencies: P1.4.

- [ ] `P1.8` Prompt builders.
  - Files: `src/game/prompts/index.js`, `src/game/prompts/commands.js`, `src/game/prompts/selections.js`, `src/game/prompts/choices.js`, `src/game/prompts/places.js`, `test/game/prompts.test.js`.
  - Scope:
    - All 19 response-bearing messages plus RPS, first/second, deck and side, with numbered options, labels, hint text and constraints. This includes tribute values, sum values and mode, and counter counts (contracts Answers).
    - AD-07 auto-answers; `SELECT_SUM` padding (D-02).
  - Acceptance evidence:
    - For every type, a real encoded message builds the expected prompt, and `encode` produces stock-client bytes, including `SELECT_SUM` with must-select cards.
    - A tribute that includes a card worth two tributes is not answered automatically. One where every card counts as one and `min` = `max` = count is.
    - Q-04: a zeroed opponent face-up candidate is labeled by name.
  - Dependencies: P1.7.

- [ ] `P1.9` MCP surface.
  - Files: `src/mcp/server.js`, `src/mcp/tools.js`, `src/mcp/render.js`, `src/seat/view.js`, `src/bin/seat.js`, `test/mcp/tools.test.js`, `test/mcp/render.test.js`, `test/seat/view.test.js`.
  - Scope: register `wait`, `answer`, `card`, `card_search`, `chat` and `surrender`; text and JSON rendering; `anthropic/maxResultSizeChars` on every tool; one log line per call with the result size.
  - Acceptance evidence:
    - `tools.test.js` spawns `bin/seat.js` through `@modelcontextprotocol/client` and checks the tool list snapshot, a `wait` result in the `deck` phase, an `answer` with nothing pending returning `isError`, and that every stdout line is JSON-RPC.
    - `view.test.js`: every event is delivered exactly once, in order, across any sequence of `wait` calls.
    - `render.test.js`: every prompt kind renders.
  - Dependencies: P1.6, P1.8.

- [ ] `P1.10` Plumbing checks (decides AD-03).
  - Files: `src/bin/smoke.js`, `test/fixtures/sessions/*`, architecture Operations (exact flags).
  - Scope:
    - `npm run smoke -- --room 'M,TM0,NF#<id>'` with `YGO_CAPTURE=1`; commit the captured sessions as fixtures.
    - One smoke run with a deck that holds a super-pre card, to record whether 2339 accepts it (concept Open Questions).
    - Claude Code `-p` with `--mcp-config`, and Codex `exec` with an `mcp_servers.ygo` entry, each pointing at `bin/seat.js`. In each, the tool list is visible, `wait` returns the deck prompt, and a `wait` with the default `YGO_WAIT_MS` (240 s) returns normally. Scratch configs live in `/tmp`, not the repo.
  - Acceptance evidence: the smoke exits 0; the super-pre result is recorded in architecture Risks; runtime transcript excerpts or exit codes are recorded in architecture Operations; AD-03 moves to ACCEPTED.
  - If the handshake fails: switch `mcp/server.js` and `mcp/tools.js` to SDK v1 1.32.0 and repeat.
  - Dependencies: P1.9.

- [ ] `P1.11` First agent match.
  - Files: `prompts/play-match.md`, `README.md` (Run a match).
  - Scope:
    - One short task prompt: play a Bo3 in room X with the `ygo` tools, chat is allowed, keep calling `wait` until the match is over. No strategy coaching.
    - The Claude Code and Codex recipes from architecture Operations, with timeouts and output limits set explicitly.
    - Two agents, a fresh room, `YGO_DECK` and `YGO_CAPTURE=1` for each, and the operator observing in KoishiPro. Fix any `unreadable` event, retry loop or timeout found, then rerun.
  - Acceptance evidence: both run folders hold a `match` line, one replay per duel played and a `.ydk` per duel; one replay opens in KoishiPro; the transcripts show `wait` returning within budget during long opponent turns, with contiguous event numbers (Q-05); the captured sessions are committed.
  - Dependencies: P1.10.

- [ ] `P1.12` Offline replay of captured matches.
  - Files: `test/seat/controller.test.js`, `test/protocol/packets.test.js`, `test/game/board.test.js`.
  - Scope: feed the fixtures through parse, the controller and the board, with a recording connection stub that keeps outgoing packets for assertions. That stub is a test double of our own interface, not a mock of the server.
  - Acceptance evidence: every captured STOC packet parses; phases match the live runs; each zone matches the next `UPDATE_DATA` for it, including duels where the first player changes; keepalives and auto-passes appear where the bytes require them.
  - Dependencies: P1.11.

## Phase 2: Model-Built Decks and Tuning

Objective: the agents build and side their own decks, and the operator knows what a match costs.

Exit gate:

- Proven: Q-01 in full (agents build their decks, side, chat and finish a Bo3); cost per match.
- Unproven: anything statistical about models (rankings are deferred).
- Human input: launching the agents and reading provider billing.

- [ ] `P2.1` Deck tools and siding.
  - Files: `src/deck/deck.js`, `src/mcp/tools.js` (`deck_show`, `deck_edit`), `src/seat/controller.js`, `test/deck/deck.test.js`, `test/mcp/tools.test.js`.
  - Scope: add, remove and move edits. The deck and side prompts use the same tools, and the tool list gains both.
  - Acceptance evidence: an offline `tools.test.js` flow imports `decks/sample.ydk`, edits it and shows it; the tool list snapshot has all eight tools.
  - Dependencies: P1.

- [ ] `P2.2` Agent matches with model-built decks.
  - Scope: the task prompt asks each agent to build its own deck and allows siding. The recipes are the same as in P1.11.
  - Acceptance evidence: a complete Bo3 in which both agents submitted decks they built and at least one side submission changed a deck; the replays open.
  - Dependencies: P2.1.

- [ ] `P2.3` Measure and tune.
  - Scope: prompts per duel, auto-answers per duel, wait polls, result sizes, and tokens and cost per match from provider billing. Decide the `specount == 0` question and the `YGO_WAIT_MS` default from these numbers.
  - Acceptance evidence: numbers recorded in architecture Risks, and the decisions as AD updates.
  - Dependencies: P2.2.

## Phase 3: Handoff

Objective: someone new can install, refresh cards, run the smoke and run an agent match from the README alone.

Exit gate: a fresh clone follows README to a passing smoke run; stale status text is gone.

- [ ] `P3.1` README and status.
  - Files: `README.md`, `.env.example`, `docs/status.md`, `docs/checkouts.md`. The last two are uncommitted in the main working tree, so this is done with their owner.
  - Acceptance evidence: a fresh clone reaches a passing `npm run smoke` by following README. `docs/status.md` no longer names the WindBot relay as the plan, and neither file links to the removed `concept-zero-research.md`.
  - Dependencies: P2.

- [ ] `P3.2` Upstream defect reports.
  - Scope: prepare reports for the `ygopro-msg-encode` `SELECT_SUM` padding and the `SELECT_COUNTER` matcher, each with a failing test.
  - Acceptance evidence: report text and tests ready. Filing upstream is an outward action and needs the user's go-ahead.
  - Dependencies: P1.8.

## Later / Not Now

- Reconnect after a seat crash. Trigger: a crash costs a real match. Deferred because it needs srvpro's reconnect flow and the same deck bytes, and nothing has crashed yet.
- Narration, public rankings, RL training, cross-game memory. Deferred by the concept; reopen only with a concept change.
- Bo1 rooms. Trigger: a Bo1 experiment. Only the room string changes (drop the `M`); the seat follows the server's match end and assumes no number of duels.
- Batched results with a "more events waiting" note. Trigger: a runtime whose output limit cannot be raised. Every current runtime's limit is configurable (architecture D-01, AD-13).
- A dedicated 15-minute hold run (Q-02). Trigger: an idle disconnect in an agent match.
- A multi-match runner or scheduler. Trigger: more than a handful of matches per day. Deferred because two terminal commands per match are enough.
- A licensed or official English source for pre-release cards. Trigger: community translations misleading agents, or a need to redistribute card text.
- A type checker (`tsc --checkJs`). Trigger: DTO drift causing defects.

## Cross-Phase Gates

- [ ] Gate: new dependencies are vetted.
  - Evidence: exact pin, license, latest release date and a clean `npm audit --omit=dev`, recorded in the commit message.
- [ ] Gate: acceptance claims use real runs.
  - Evidence: each phase exit lists commands as passed, failed or not run, and live proofs name the room id.
- [ ] Gate: the architecture source tree changes in the same commit as the files it lists.
  - Evidence: the commit diff. There is no separate comparison step.
