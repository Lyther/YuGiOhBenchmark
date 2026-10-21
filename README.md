# YuGiOhBenchmark

LLM-versus-LLM Yu-Gi-Oh! on the existing server at `koishi.momobako.com:2339`: server ↔ MCP ↔ model.

Each model runs in its own agent runtime (Claude Code, Codex CLI, Droid, …) with one **seat**. The seat is a stdio MCP server and a normal YGOPro client. Both seats join one room, `M,TM0,NF#<id>`: Bo3, no clock, no banlist. The server runs the game: rules, deck and side checks, the match result, and replays. The accepted [concept](docs/context/concept-zero.md), [architecture](docs/architecture.md), [contracts](docs/contracts.md) and [roadmap](docs/roadmap.md) are the source of truth; [status](docs/status.md) says what has been proven.

## Install

Prerequisites: Node.js 22 or newer, npm, and network access to `koishi.momobako.com:2339`.

```bash
npm ci
npm run cards        # download card data into data/cards/ (about 17 MB, kept out of Git)
npm test             # offline tests
npm run smoke        # two model-free seats play a short Bo3 on 2339
```

Run `npm run cards` again before each session, because pre-release card data changes almost daily. Behind an HTTP proxy, start it with `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses `HTTPS_PROXY`. The game connection itself is plain TCP.

Optional first-edition effect pack: put `.ypk` files in `data/cards/first-edition/`. Their card text replaces the errata text of the cards they contain (see [contracts](docs/contracts.md#card-data-inputs)).

## Smoke run

`npm run smoke [-- --room 'M,TM0,NF#<id>' --deck <ydk> --names a,b]` starts two real seats over MCP. They submit `decks/sample.ydk`, chat once each, play rock-paper-scissors and the first-player choice, surrender at their first prompt in every duel, and keep their decks at side. The run passes when both seats saw the match end, heard each other's chat line, and hold a complete run folder: one replay per duel, the deck of every duel, and a `match` result line. Add `YGO_CAPTURE=1` to record the raw server packets as `session.bin`. Add `--restart` to also check a resume: one seat's process is killed at its first duel prompt, and a new process must finish the match from the same run folder.

## Run an agent match

Pick a fresh room id. Each agent gets its own seat, the same room and a distinct name, and both receive [prompts/play-match.md](prompts/play-match.md).

Start each agent in its own empty folder outside the repo, and make that folder its seat's `YGO_RUN_DIR`. An agent can explore its working folder, so it must not find the other seat's decks or packet capture there. The prompt also tells each agent to stay inside its folder; that rule and the separate folders are the whole separation, with no sandbox.

```bash
mkdir -p /path/to/match01/claude /path/to/match01/codex
```

Claude Code (headless). Write `/path/to/match01/claude/claude-mcp.json`:

```json
{ "mcpServers": { "ygo": { "command": "node", "args": ["/path/to/repo/src/bin/seat.js"],
  "env": { "YGO_ROOM": "M,TM0,NF#match01", "YGO_NAME": "claude-seat", "YGO_CARDS_DIR": "/path/to/repo/data/cards",
           "YGO_RUN_DIR": "/path/to/match01/claude", "YGO_CAPTURE": "1" } } } }
```

```bash
cd /path/to/match01/claude
claude -p "$(cat /path/to/repo/prompts/play-match.md)" --mcp-config claude-mcp.json --allowedTools "mcp__ygo__*" WebSearch WebFetch
```

The pre-approval only lets headless mode run the seat and web tools without prompting; other tools and MCP servers stay as configured. In `-p` mode, long tool calls are not moved to the background.

Codex CLI:

```bash
cd /path/to/match01/codex
codex exec --skip-git-repo-check \
  -c 'mcp_servers.ygo.command="node"' \
  -c 'mcp_servers.ygo.args=["/path/to/repo/src/bin/seat.js"]' \
  -c 'mcp_servers.ygo.env={YGO_ROOM="M,TM0,NF#match01",YGO_NAME="codex-seat",YGO_CARDS_DIR="/path/to/repo/data/cards",YGO_RUN_DIR="/path/to/match01/codex",YGO_CAPTURE="1"}' \
  -c 'mcp_servers.ygo.required=true' \
  -c 'mcp_servers.ygo.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.ygo.tool_timeout_sec=300' \
  -c 'tool_output_token_limit=100000' \
  "$(cat /path/to/repo/prompts/play-match.md)"
```

`codex exec` refuses to start outside a Git repository unless `--skip-git-repo-check` is given, and it cannot ask for approval, so the seat's tools are pre-approved. The timeout is set explicitly above the seat's 240 s wait budget (`YGO_WAIT_MS`), and the output limit is raised so seat results are not truncated. Set `YGO_DECK` to a `.ydk` path to start an agent with a given deck; otherwise it builds one with the deck tools.

Droid: run each agent with the launcher, from a machine where Droid is logged in:

```bash
npm run droid-agent -- --dir /path/to/match01 --label droid --model <model> --effort max --room 'M,TM0,NF#match01'
```

The launcher makes `/path/to/match01/droid/` the agent's working folder and its seat's `YGO_RUN_DIR`. It gives the agent its own Droid home, `/path/to/match01/droid.droid-home/`, holding the seat's MCP entry, the steer hook below and links to your Droid login, and nothing else. Droid reads that home instead of `~/.factory` through `FACTORY_HOME_OVERRIDE`.
- Nothing is added to your own config. Your MCP servers, skills, plugins, hooks and `AGENTS.md` do not reach the agent; Droid's built-in tools and skills do.
- That variable is undocumented, so the launcher first checks the agent's tool list and stops if any MCP server other than the seat appears.
- It then runs `droid exec` with `--auto high`, `--add-tools MCP:ygo` and the task prompt until the run folder records the match end, for at most 8 sessions (`--sessions`).
- Each session's stream log, the seat's log and a sessions log go to `/path/to/match01/logs/`.
- `--name` (default `<label>-seat`), `--deck` and `--prompt` are optional. Without `--effort`, Droid uses the model's default, since the agent's home holds none of your settings.

GPT-6 Luna often sent its moves to `Execute` or `Skill` instead of the seat and then gave up (the counts are in [status](docs/status.md)). Those calls succeeded: `echo choose5` exits 0 and tells the model nothing. The steer hook (`src/bin/steer.js`) adds the missing line. From the first duel to the match end, a call to any tool other than the seat's gets one more line in its result, saying the call did nothing in the match and naming `ygo___wait` and `ygo___answer`. The hook blocks nothing. In checks, Haiku and Luna both received a hook's added text, and Luna acted on this line. Whether it shortens a real collapse has not been measured yet. Before the private home existed, Luna had the operator's 70 MCP tools behind `ToolSearch`; `--add-tools MCP:ygo` lists the MCP tools up front and removes nothing.

If a connection drops, the seat rejoins the match by itself. If an agent or its seat stops mid-match, run the same command again in the same folder within about 5 minutes (how long 2339 holds a dropped seat): the new seat resumes the match from its run folder, with the deck the match started with. A model can also end its own session before the match is over; the Droid launcher then starts the next session itself.

A seat that has not sent its side deck 3 minutes after a duel is removed by the server, and its opponent wins the match; nothing resumes it. The seat says how much side time is left in every text result while a side deck is due, which is all it can do for a model that is not calling a tool.

Watch live from a current YGOPro client, such as KoishiPro on Windows, by joining the room after the duel has started. The server makes you an observer and sends you the duel from its start, then every later duel and the siding between them. Joined before both seats, you take a player place, and the second seat is refused and its match aborted. To wait in the lobby, move to the observer place at once. You stay the host, so the duel starts only when you press Start after both seats are ready. Your chat reaches both agents as observer lines.

Each seat writes `<YGO_RUN_DIR>/<room id>/<name>/`: `results.jsonl`, `duel-<n>.ydk`, the server's `replay-<k>.yrp` files (format YRP2), and `session.bin` when capture is on. A viewer replays a duel with its own card scripts, so a card whose script differs from 2339's can make the replay diverge.
- In KoishiPro, put the first-edition pack in its `expansions` folder before opening them. Its Mac download dates from November 2023, before ygopro's client version 0x1362 and the YRP2 format (both June 2025), so that build is unlikely to open these files or to join 2339.
- The web client [Neos](https://neos.moecube.com) imports `.yrp2` files in any browser, with MyCard's scripts.

The server announces a cloud replay code (`R#…`) for each duel in chat. Joined with such a code, 2339 sent a protocol client only the duel's summary, not the duel.

## Configuration

The seat reads only environment variables; [.env.example](.env.example) lists every name and default, and [contracts](docs/contracts.md#configuration) gives the rules. `YGO_ROOM` is required for the seat. `npm run probe` joins a room, prints the lobby JSON and leaves, which is useful to check room options.

## Tests

`npm test` runs offline against the codec, card loader, board, prompts and controller. It includes authored card fixtures, constructed messages, a connection double, and captured sessions in `test/fixtures/sessions/`; these are diagnostics, not proof of live gameplay. It never contacts 2339. `npm run spec` runs the real seat's MCP entry point and tools, card lookups and deck edits against the card data that `npm run cards` downloaded, so run that first. `node --test spec/upstream-msg-encode.test.js` holds failing tests for [five codec defects](docs/upstream/ygopro-msg-encode.md) that the seat works around.

## Layout

| Path | Purpose |
| --- | --- |
| `src/bin/` | `seat.js` (MCP seat), `droid-agent.js` (Droid agent launcher), `steer.js` (its hook), `smoke.js`, `cards.js` (card refresh), `probe.js` (lobby check). |
| `src/seat/` | `controller.js` (the seat state machine), `view.js` (seat view DTOs), `record.js` (run folder). |
| `src/game/` | Board mirror, events, labels, and prompt builders under `prompts/`. |
| `src/cards/`, `src/deck/` | Card catalog and downloads; deck formats and edits. |
| `src/mcp/` | Tool definitions, text rendering, stdio server. |
| `src/protocol/`, `src/net/` | Packet codec wrappers and the TCP connection. |
| `decks/sample.ydk` | The smoke deck and a ready-made starting deck. |
| `test/`, `spec/` | Offline tests; separate entry-point and upstream specs. |
| `third_party/`, `reference/` | Upstream sources (`npm run submodules`), mapped in [docs/checkouts.md](docs/checkouts.md). |

Narration, public rankings, RL training and cross-game memory are deferred by the concept. The earlier [alignment discussion](docs/alignment.md) is historical.
