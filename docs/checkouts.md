# Checkouts

`npm run submodules` runs `git submodule update --init --recursive`.

`third_party/` contains existing game, protocol, and client sources. `reference/` contains alternative implementations and card tools. The [current concept](context/concept-zero.md) and [architecture](architecture.md) select a Node MCP seat on the hosted server. WindBot is a source reference. The lobby probe uses the npm codec and does not need these checkouts to run.

| Path | Remote | Role |
| --- | --- | --- |
| `third_party/ygopro` | `Fluorohydride/ygopro` | Native client/server, deck editor, match handling, and replay facilities. Nested checkouts: `ocgcore`, `script`. |
| `third_party/ygopro-core` | `Fluorohydride/ygopro-core` | Core named in the decision record. MIT. Distinct from `third_party/ygopro/ocgcore`. |
| `third_party/srvpro` | `mycard/srvpro` | Node room host used by the Koishi servers. |
| `third_party/koishipro-core.js` | `purerosefallen/koishipro-core.js` | JavaScript core bindings for reference; no embedded engine is selected. |
| `third_party/ygopro-msg-encode` | `purerosefallen/ygopro-msg-encode` | Codec source. `npm run probe` uses the published 1.3.0 package. |
| `third_party/ygopro-yrp-encode` | `purerosefallen/ygopro-yrp-encode` | Replay codec. |
| `third_party/ygo-ai` | `jinyan438/ygo-ai` | WindBot relay at `skill/resources/ygopro2-bridge/windbot/source/Game/AI/ExternalPolicyClient.cs`. |
| `reference/YGO-Bench` | `erwinmsmith/YGO-Bench` | Benchmark reference. `yugi-bench` is under `vendor/yugi-bench`. |
| `reference/ygo-harness` | `kwabenaa/ygo-harness` | Game-agent integration reference. |
| `reference/yugioh-game` | `tspivey/yugioh-game` | Existing text client. |
| `reference/ygocdb-mcp` | `lieyanqzu/ygocdb-mcp` | Card lookup MCP reference. |
| `reference/yugioh-mcp-server` | `alisyedn/yugioh-mcp-server` | Card and deck tool reference. |
