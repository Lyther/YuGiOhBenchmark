# Status

Last checked: 2026-10-08. The accepted [concept](context/concept-zero.md), [architecture](architecture.md), [contracts](contracts.md) and [roadmap](roadmap.md) govern development. [alignment.md](alignment.md) is historical.

## Implemented

The MCP seat is implemented: `src/bin/seat.js` serves eight tools over stdio (`wait`, `answer`, `deck_show`, `deck_edit`, `card`, `card_search`, `chat`, `surrender`) and plays as a normal YGOPro client. It covers card data, the deck model, the board mirror, readable events, prompt builders for all 20 response-bearing messages, the seat state machine, the run folder, and the text and JSON views. `npm run cards`, `npm run smoke` and `npm run probe` are the operator commands.

`npm test` passes 153 offline tests on Node 22.23.2, 24.15.0 and 26.10.0. These include authored card fixtures, constructed codec messages, a connection double and captured sessions; their results are diagnostic, not live-duel proof. Separately, `spec/seat-entry.test.js` passes against the real seat. `spec/upstream-msg-encode.test.js` fails on purpose: it holds the four codec defects the seat works around ([report](upstream/ygopro-msg-encode.md), not filed).

The code review added eight regressions, first observed failing and then passing: empty card/sum selections, the shuffle wire layout and occupied slots, Extra Deck returns on a Deck/GY swap, the chat/match-end write race, model-visible scales/positions/targets, and the required English strings file. A ninth test checks that a sum prompt tells the model an empty choice is allowed. These fixes still need normal-duel coverage in P1.11–P1.12.

The 2026-10-08 readiness review fixed five more problems, each with a regression test: agent recipes that shared one run folder, run folders reused or shared by colliding names, forfeits recorded from the wrong side, chat or names posing as seat output, and card downloads installed unchecked.

The follow-up review fixed three more, test first: setting a Spell/Trap asked for "0 zones" and refused a cancel; a match won by a match-winning effect was recorded as a draw; and the exec launch recipe lacked `--skip-git-repo-check`, so it could not start in its own folder.

Resume first (architecture AD-14): a lost connection, a packet the seat cannot handle, and a restarted seat all rejoin the match through srvpro's reconnect instead of giving it up. A packet fault no longer ends the process; it is logged with its bytes and the duel is reloaded from the server. A seat stopped mid-match leaves it resumable, and a new process in the same run folder resumes it (contracts Rejoin). Mutation checks: each of 17 deliberate faults in this code made a test fail.

The third peer review fixed four recovery problems. Each fix has a regression test that fails on the old code:

- A refused rejoin counted twice, so the budget ran out after three connects and a stray retry could connect after the seat gave up.
- A dropped rejoin's restore deadline aborted the next, successful rejoin.
- The reload's `MSG_NEW_TURN` reset the resume checkpoint to turn 1.
- A duel that ended while a seat was away renumbered the rest of the match and turned a 2-1 win into a draw. Such a duel is now `unknown`, and so is the match unless the known duels decide it.

A PR review then found that a restarted seat whose `YGO_VERSION` the server refuses aborted a match srvpro still held; its rejoin now gets the one version retry, test first. The same review found that the 64 MiB card download cap read a body with no length whole before checking it; the cap now counts bytes as they arrive. A later review found that a join sent the working deck instead of the submitted one, so edits made after a submit reached the server with `READY`. The next found that a seat made an observer stayed on and recorded another player's results as its own; it is now refused. Opponent chat and names also lose Unicode line separators now, which JSON quoting left in place.

The fourth peer review, of the whole first-party code at `022e106`, found that the board dropped a card's current type, Attribute and monster Type, which effects can change; the model now sees them. Checking that against a live capture showed two older text problems, now fixed too: Spells, Traps and non-Pendulum cards showed the server's 0/0 stats and scales, and list lines joined cards with the same commas as their details. The chat tool now states 2339's 100-character limit.

A PR review of `ee350f8` found two ways a hard stop mid-write could damage a run folder; each fix has a test that fails on the old code. A deck file that was opened but not yet written stayed empty, and every later resume failed to parse it. A resumed seat appended its first result line to the fragment of a cut line, so both were lost. Decks are now written under a temporary name and linked into place, and a resume cuts off the fragment. `npm run smoke -- --restart` passed afterwards in `smbd706af1`.

## Live evidence on 2339 (2026-10-07 and 2026-10-08)

- **Smoke runs.** Two model-free seats passed `npm run smoke` in rooms `M,TM0,NF#smc1c37f09` and `M,TM0,NF#smedf73be1`. Each run covered the join, rock-paper-scissors, the first-player choice, two duels ended by surrender, siding, `DUEL_END` and both replays in each run folder, with chat delivered both ways. The captured packets are now test fixtures.
- **Post-review smoke.** `YGO_CAPTURE=1 npm run smoke` passed in `M,TM0,NF#smea60dcf7`. Both seats heard chat and completed two surrendered duels. Each folder under `runs/smea60dcf7/` holds two decks, two replays, results and a capture. Independent readback parsed all 108 packets from the first seat and all 112 from the second, and confirmed that every saved replay exactly equals its captured server payload.
- **Pre-release cards.** The server accepted a deck holding the super-pre card Angelechy Brilliant Move (101306093).
- **Side Deck timer.** srvpro announces a 3-minute limit for siding ("你现在有3分钟来更换副卡组"). Agents must finish siding within it. The line reaches them as a server chat event, and the task prompt mentions it.
- **Cloud replays.** The server announces a cloud replay id per duel (for example `R#19402`) and sends the held replays right after `DUEL_END`.
- **Runtimes.** Claude Code 2.1.280 (`claude -p --mcp-config`) and Codex CLI 0.159.2 (`codex exec` with the README overrides) both connected to the seat. Each held one `answer` call through the full 240 s wait budget, got the lobby view back, and the seat left cleanly when the runtime ended.
- **Fresh clone and Node versions (2026-10-08).** A fresh clone followed the README (`npm ci`, `npm run cards`, `npm test`, `npm run smoke`) to a passing smoke in `sm9df5820b`. The smoke also passed on Node 22 (`sm473aa0c3`), on Node 24 (`sm0081e31a`), and on Node 26 after the review fixes (`sm5c8debb4`). All 1,092 packets in the ten captures replay through the controller without an exception.
- **Earlier probe runs** joined Bo3, zero-clock, no-banlist rooms at `0x1362`, including one version retry from `0x1351`.
- **Reconnect (2026-10-08).** A two-client probe dropped one socket with a duel prompt pending and rejoined 3 s later with the same name, room and deck and no `READY`. srvpro restored the duel (an `MSG_START` with empty decks, `MSG_RELOAD_FIELD`, 12 `MSG_UPDATE_DATA`, then the same prompt). A drop while siding came back with `CHANGE_SIDE`, and the match finished with both replays. These packets are the `rejoin-a-*.bin` fixtures. In another room a seat that never returned was held for 298 s; srvpro then closed the other seat's socket without `MSG_WIN`.
- **Restarted seat (2026-10-08).** `npm run smoke -- --restart` passed in `M,TM0,NF#sm2cde4817`. Seat b's process was killed with `SIGKILL` at its first duel prompt. A new process offered the resume, rejoined, got the same prompt back and finished the 0-2 match; both run folders hold two duel lines, two replays, both decks and the match line. The plain smoke passed afterwards in `sm16da4a44`, and the restart smoke again on the final code in `smc74c2825`.
- **A duel that ended while a seat was away (2026-10-08).** A two-process probe killed seat b during duel 1, seat a surrendered, and b resumed while siding; then each seat surrendered once. Before the fix (`awa5fe6836`), b numbered duels 2 and 3 as 1 and 2 and recorded a draw. After it (`aw043b381a`), b recorded duel 1 as `unknown`, numbered duels 2 and 3 as a did, and recorded the match as `unknown` at 1-1. Each folder holds three decks and three replays. After these fixes the restart smoke passed in `sm12cbc239` and `sm681dbd46`, and the plain smoke in `sm22dae75d`.
- **Restart with a refused version (2026-10-08).** Seat b was killed in duel 1 and restarted with `YGO_VERSION=0x1351`, which 2339 refuses on a normal join. Before the fix (`vr2bbfadf8`), 2339 answered the rejoin with `VERERROR` and b aborted the match. After it (`vr9beac23b`), b reconnected once with `0x1362`, got its prompt back, and the 2-0 match finished.
- **Edits after a submit (2026-10-08).** Seat b submitted the sample deck, then added a 41st card to its working deck: once while its join was in flight, once in the lobby before a dropped connection and a rejoin. Before the fix, 2339 dealt the edited deck both times (36 cards left at duel start against the opponent's 35, rooms `dead202a0d` and `ded2876773`), and in the second room `duel-1.ydk` named the 40-card deck. After it (`de1595de91`, `de7460d1e7`), the server dealt the submitted deck and `duel-1.ydk` matched it. Offered later as a side deck, the edited deck was refused, as the side rule requires. The plain smoke passed in `sm16da71f0`.
- **A third seat in a dueling room (2026-10-08).** Two seats started a duel and a third joined the room; srvpro made it an observer. Before the fix (`ob8e53bdd0`), the third seat mirrored the duel as player 1 and recorded a 2-0 match win it never played. After it (`obf8a73c7a`), it stopped at once with "no free player seat" and an `aborted` line, and the real match finished.
- **Changed Side Deck and a restart (2026-10-08, peer review).** A seat changed and submitted its Side Deck, was killed while the other player was still siding, missed the next duel's start, and was restarted. It resumed with the edited deck, and the three-duel match finished 2-1/1-2 with three deck files and three replays per seat (`sr3e2e1550`); all six replays equal their captured payloads. In the same room, a 100-character chat line reached the opponent and a 101-character one was dropped with a server warning.

## Not yet proven

- A full Bo3 between two agents (roadmap P1.11, then P2.2 with decks the agents build). It needs launching both runtimes; the commands are in the [README](../README.md#run-an-agent-match).
- Board fidelity over real duels: the captured smoke sessions end at each duel's first prompt, so P1.12's zone checks need an agent match's capture.
- Cost per match (P2.3), Gemini CLI, and a 15-minute think (Q-02).
- A rejoin caused by a live packet fault: only reproduced locally (a malformed `MSG_START` now leaves the seat running) and replayed from captured bytes.

Downloaded card data stays local and out of Git.
