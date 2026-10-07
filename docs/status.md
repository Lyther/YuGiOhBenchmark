# Status

Last checked: 2026-10-07. The accepted [concept](context/concept-zero.md), [architecture](architecture.md), [contracts](contracts.md) and [roadmap](roadmap.md) govern development. [alignment.md](alignment.md) is historical.

## Implemented

The MCP seat is implemented: `src/bin/seat.js` serves eight tools over stdio (`wait`, `answer`, `deck_show`, `deck_edit`, `card`, `card_search`, `chat`, `surrender`) and plays as a normal YGOPro client. It covers card data, the deck model, the board mirror, readable events, prompt builders for all 20 response-bearing messages, the seat state machine, the run folder, and the text and JSON views. `npm run cards`, `npm run smoke` and `npm run probe` are the operator commands.

`npm test` passes 117 offline tests. These include authored card fixtures, constructed codec messages, a connection double and captured sessions; their results are diagnostic, not live-duel proof. Separately, `spec/seat-entry.test.js` passes against the real seat. `spec/upstream-msg-encode.test.js` fails on purpose: it holds the four codec defects the seat works around ([report](upstream/ygopro-msg-encode.md), not filed).

The code review added eight regressions, first observed failing and then passing: empty card/sum selections, the shuffle wire layout and occupied slots, Extra Deck returns on a Deck/GY swap, the chat/match-end write race, model-visible scales/positions/targets, and the required English strings file. A ninth test checks that a sum prompt tells the model an empty choice is allowed. These fixes still need normal-duel coverage in P1.11–P1.12.

## Live evidence on 2339 (2026-10-07)

- **Smoke runs.** Two model-free seats passed `npm run smoke` in rooms `M,TM0,NF#smc1c37f09` and `M,TM0,NF#smedf73be1`. Each run covered the join, rock-paper-scissors, the first-player choice, two duels ended by surrender, siding, `DUEL_END` and both replays in each run folder, with chat delivered both ways. The captured packets are now test fixtures.
- **Post-review smoke.** `YGO_CAPTURE=1 npm run smoke` passed in `M,TM0,NF#smea60dcf7`. Both seats heard chat and completed two surrendered duels. Each folder under `runs/smea60dcf7/` holds two decks, two replays, results and a capture. Independent readback parsed all 108 packets from the first seat and all 112 from the second, and confirmed that every saved replay exactly equals its captured server payload.
- **Pre-release cards.** The server accepted a deck holding the super-pre card Angelechy Brilliant Move (101306093).
- **Side Deck timer.** srvpro announces a 3-minute limit for siding ("你现在有3分钟来更换副卡组"). Agents must finish siding within it. The line reaches them as a server chat event, and the task prompt mentions it.
- **Cloud replays.** The server announces a cloud replay id per duel (for example `R#19402`) and sends the held replays right after `DUEL_END`.
- **Runtimes.** Claude Code 2.1.280 (`claude -p --mcp-config`) and Codex CLI 0.159.2 (`codex exec` with the README overrides) both connected to the seat. Each held one `answer` call through the full 240 s wait budget, got the lobby view back, and the seat left cleanly when the runtime ended.
- **Earlier probe runs** joined Bo3, zero-clock, no-banlist rooms at `0x1362`, including one version retry from `0x1351`.

## Not yet proven

- A full Bo3 between two agents (roadmap P1.11, then P2.2 with decks the agents build). It needs launching both runtimes; the commands are in the [README](../README.md#run-an-agent-match).
- Board fidelity over real duels: the captured smoke sessions end at each duel's first prompt, so P1.12's zone checks need an agent match's capture.
- Cost per match (P2.3), Gemini CLI, and a 15-minute think (Q-02).

Downloaded card data stays local and out of Git.
