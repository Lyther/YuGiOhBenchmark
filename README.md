# YuGiOhBenchmark

LLM-versus-LLM Yu-Gi-Oh! on the existing server at `koishi.momobako.com:2339`: server ↔ MCP ↔ model.

Each model runs in its own agent runtime (Claude Code, Codex CLI, …) with one **seat**. The seat is a stdio MCP server and a normal YGOPro client. Both seats join one room, `M,TM0,NF#<id>`: Bo3, no clock, no banlist. The server runs the game: rules, deck and side checks, the match result, and replays. The accepted [concept](docs/context/concept-zero.md), [architecture](docs/architecture.md), [contracts](docs/contracts.md) and [roadmap](docs/roadmap.md) are the source of truth; [status](docs/status.md) says what has been proven.

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

`npm run smoke [-- --room 'M,TM0,NF#<id>' --deck <ydk> --names a,b]` starts two real seats over MCP. They submit `decks/sample.ydk`, chat once each, play rock-paper-scissors and the first-player choice, surrender at their first prompt in every duel, and keep their decks at side. The run passes when both seats saw the match end, heard each other's chat line, and hold a complete run folder: one replay per duel, the deck of every duel, and a `match` result line. Add `YGO_CAPTURE=1` to record the raw server packets as `session.bin`.

## Run an agent match

Pick a fresh room id. Each agent gets its own seat, the same room and a distinct name, and both receive [prompts/play-match.md](prompts/play-match.md).

Claude Code (headless). Write an MCP config:

```json
{ "mcpServers": { "ygo": { "command": "node", "args": ["/path/to/repo/src/bin/seat.js"],
  "env": { "YGO_ROOM": "M,TM0,NF#match01", "YGO_NAME": "claude-seat", "YGO_CARDS_DIR": "/path/to/repo/data/cards",
           "YGO_RUN_DIR": "/path/to/repo/runs", "YGO_CAPTURE": "1" } } } }
```

```bash
claude -p "$(cat prompts/play-match.md)" --mcp-config claude-mcp.json --allowedTools "mcp__ygo__*" WebSearch WebFetch
```

The pre-approval only lets headless mode run the seat and web tools without prompting; other tools and MCP servers stay as configured. In `-p` mode, long tool calls are not moved to the background.

Codex CLI:

```bash
codex exec \
  -c 'mcp_servers.ygo.command="node"' \
  -c 'mcp_servers.ygo.args=["/path/to/repo/src/bin/seat.js"]' \
  -c 'mcp_servers.ygo.env={YGO_ROOM="M,TM0,NF#match01",YGO_NAME="codex-seat",YGO_CARDS_DIR="/path/to/repo/data/cards",YGO_RUN_DIR="/path/to/repo/runs",YGO_CAPTURE="1"}' \
  -c 'mcp_servers.ygo.required=true' \
  -c 'mcp_servers.ygo.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.ygo.tool_timeout_sec=300' \
  -c 'tool_output_token_limit=100000' \
  "$(cat prompts/play-match.md)"
```

`codex exec` cannot ask for approval, so the seat's tools are pre-approved. The timeout is set explicitly above the seat's 240 s wait budget (`YGO_WAIT_MS`), and the output limit is raised so seat results are not truncated. Set `YGO_DECK` to a `.ydk` path to start an agent with a given deck; otherwise it builds one with the deck tools.

Watch live by joining the room as an observer in KoishiPro. Each seat writes `runs/<room id>/<name>/`: `results.jsonl`, `duel-<n>.ydk`, the server's `replay-<k>.yrp` files, and `session.bin` when capture is on. The server also announces a cloud replay id (`R#…`) for each duel in chat.

## Configuration

The seat reads only environment variables; [.env.example](.env.example) lists every name and default, and [contracts](docs/contracts.md#configuration) gives the rules. `YGO_ROOM` is required for the seat. `npm run probe` joins a room, prints the lobby JSON and leaves, which is useful to check room options.

## Tests

`npm test` runs offline against the codec, card loader, board, prompts, controller and MCP seat. It includes authored card fixtures, constructed messages, a connection double, and captured sessions in `test/fixtures/sessions/`; these are diagnostics, not proof of live gameplay. It never contacts 2339. Two specs run separately: `node --test spec/seat-entry.test.js` checks the MCP entry point and needs `npm run cards` first. `node --test spec/upstream-msg-encode.test.js` holds failing tests for [four codec defects](docs/upstream/ygopro-msg-encode.md) that the seat works around.

## Layout

| Path | Purpose |
| --- | --- |
| `src/bin/` | `seat.js` (MCP seat), `smoke.js`, `cards.js` (card refresh), `probe.js` (lobby check). |
| `src/seat/` | `controller.js` (the seat state machine), `view.js` (seat view DTOs), `record.js` (run folder). |
| `src/game/` | Board mirror, events, labels, and prompt builders under `prompts/`. |
| `src/cards/`, `src/deck/` | Card catalog and downloads; deck formats and edits. |
| `src/mcp/` | Tool definitions, text rendering, stdio server. |
| `src/protocol/`, `src/net/` | Packet codec wrappers and the TCP connection. |
| `decks/sample.ydk` | The smoke deck and a ready-made starting deck. |
| `test/`, `spec/` | Offline tests; separate entry-point and upstream specs. |
| `third_party/`, `reference/` | Upstream sources (`npm run submodules`), mapped in [docs/checkouts.md](docs/checkouts.md). |

Narration, public rankings, RL training and cross-game memory are deferred by the concept. The earlier [alignment discussion](docs/alignment.md) is historical.
