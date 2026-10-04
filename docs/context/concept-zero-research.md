# Concept Zero Research Notes

Last updated: 2026-10-04

Supports [concept-zero.md](concept-zero.md). This revision concentrates on which existing capabilities the MCP interface can expose. The user's 2026-10-04 decisions replace the earlier requirements for custom evidence collection, restricted tool access, frozen environments, and pre-game audit procedures.

## What Was Reviewed

The current repository still implements a lobby join using `ygopro-msg-encode`. The existing upstream checkouts supply the source references below. Their code was inspected on 2026-10-04; this is not a claim that every component was built or that the deployed server runs these exact checkouts. The prior live lobby observation is dated separately.

| ID | Question / capability | Primary source | Finding | Consequence |
|---|---|---|---|---|
| R-01 | Current project behavior | [seat entry point](../../src/seat/join-room.js), [package](../../package.json), [README](../../README.md) | The client joins, prints lobby messages, and leaves. The installed codec is 1.3.0. | Build the missing MCP/player connection; do not describe the full match as already implemented. |
| R-02 | Deck construction and submission | [YGOPro deck editor](../../third_party/ygopro/gframe/deck_con.cpp), [deck management](../../third_party/ygopro/gframe/deck_manager.cpp), [deck packet](../../third_party/ygopro-msg-encode/src/protos/ctos/proto/update-deck.ts) | Native code already edits Main/Extra/Side Decks and loads/saves them. The packet uses `ygopro-deck-encode`; its installed API supports those sections, `.ydk`, and deck-submission serialization. | Expose deck editing through MCP using existing representations and codecs. The graphical editor itself is not a headless MCP API. |
| R-03 | Bo3 and sideboarding | [server match flow](../../third_party/ygopro/gframe/single_duel.cpp), [deck handling](../../third_party/ygopro/gframe/deck_manager.cpp), [side-change message](../../third_party/ygopro-msg-encode/src/protos/stoc/proto/change-side.ts) | `DuelEndProc` implements match continuation/results and requests side changes. `LoadSide` applies the existing sideboarding checks. | Let the model edit and resubmit its deck when requested. Reuse the native match and legality handling. |
| R-04 | Chat | [outgoing chat](../../third_party/ygopro-msg-encode/src/protos/ctos/proto/chat.ts), [incoming chat](../../third_party/ygopro-msg-encode/src/protos/stoc/proto/chat.ts), [server dispatch](../../third_party/ygopro/gframe/netserver.cpp) | Both chat directions are represented by existing packets. | Wire send/receive into the model interface. No separate chat product or special competition track is needed. |
| R-05 | Original game record and replay | [replay saving](../../third_party/ygopro/gframe/replay.cpp), [client replay handling](../../third_party/ygopro/gframe/duelclient.cpp), [replay packet](../../third_party/ygopro-msg-encode/src/protos/stoc/proto/replay.ts), [replay codec](../../third_party/ygopro-yrp-encode/README.md) | YGOPro has native replay saving/playback; the codec already handles the replay packet and format. | Keep the original output and use the existing viewer. Do not add a second recorder, replay UI, or evidence store. |
| R-06 | Concrete WindBot adaptation | [GameBehavior](../../third_party/ygo-ai/skill/resources/ygopro2-bridge/windbot/source/Game/GameBehavior.cs), [ExternalPolicyClient](../../third_party/ygo-ai/skill/resources/ygopro2-bridge/windbot/source/Game/AI/ExternalPolicyClient.cs), [build instructions](../../third_party/ygo-ai/skill/resources/ygopro2-bridge/windbot/source/README.md) | External policy receives selected decision messages. Sideboarding currently resubmits the same deck; chat goes to logging; replay bytes are read and discarded. Pre-duel choices have existing handlers. The policy read blocks the calling path and defaults to a 30-second timeout. | Forward the needed player operations, retain native replay output, and let the existing connection handling continue while the model thinks. These are adapter changes, not new server features. |
| R-07 | Server settings and player information | [srvpro room options](../../third_party/srvpro/ygopro-server.coffee), [YGOPro player-message handling](../../third_party/ygopro/gframe/single_duel.cpp) | Room parsing includes match mode, no banlist, and zero time. The server already prepares information for its players. | Configure the existing features and consume the normal player stream. No local masking project is selected. |
| R-08 | Existing card and benchmark applications | [card lookup MCP](../../reference/ygocdb-mcp/README/README.en.md), [deck/card MCP](../../reference/yugioh-mcp-server/README.md), [YGO-Bench](../../reference/YGO-Bench/README.md), [ygo-harness](../../reference/ygo-harness/README.md) | Existing projects cover card search, deck operations, and alternative embedded-engine evaluations. They are references with different scopes. | Reuse a suitable function/library where useful; do not adopt an entire application just to expose a small operation. |
| R-09 | Research motivation | [BALROG](https://arxiv.org/abs/2411.13543), [lmgame-Bench](https://arxiv.org/abs/2505.15146), [PTCG-Bench](https://arxiv.org/html/2605.29653v1) | Literature reviewed on 2026-09-30 supports investigating sequential game-agent behavior and shows that setup affects results. It does not establish contamination immunity for this project. | Retain the research question without converting a formal evaluation methodology into prerequisite infrastructure. |

Confidence is high for the specific local source observations. End-to-end model play through this project's MCP interface has not been run because that interface is not implemented.

## The Adaptation Is Smaller Than the Earlier Design

The existing deck editor supplies the user capability; the existing deck model, serializers, and submission path supply the nonvisual integration route. An MCP tool can expose deck changes without reproducing the graphical application or implementing a new rules checker. The card/deck MCP references offer additional examples, not a requirement to import their database and file-management stacks.

The server already decides when a match continues and asks for sideboarding. The relay needs to obtain the model's revised deck at that point instead of automatically sending its unchanged deck. The same distinction applies to chat and replay: the underlying feature exists, while this particular relay does not currently expose it to the intended consumer.

The source also explains why a relay may need a small change while the model thinks: its external-policy call performs a blocking read. Retaining normal connection traffic is ordinary client functionality. This does not imply a new timeout policy, benchmark clock, or long-wait certification system.

## Historical Live Observation: 2026-09-30

The earlier research used the actual `npm start` entry point to join and leave two rooms on `koishi.momobako.com:2339`:

| Room configuration | Returned lobby settings |
|---|---|
| Default generated room | Single game, Master Rule 5, 8000 LP, deck checks and shuffling on, `timeLimit: 240`. |
| `TM0,NF#yb2bfabc05` | Same basic game settings, `timeLimit: 0`, and `lflist: 0` for no banlist. |

Both joins succeeded at client version `0x1362`. No duel was played in those checks. These are dated observations, not a claim of a fresh network run on 2026-10-04. The default-room result recorded in [status.md](../status.md) does not mean zero time is unavailable; the configured-room result shows why the correct room options matter. Match mode is also present in the inspected room parser.

## Reuse and Maintenance

Use the repositories already listed in [checkouts.md](../checkouts.md). The codec and embedded WindBot source carry MIT licenses; srvpro is AGPL, and YGOPro's client code and core have distinct licenses. These existing component distinctions remain relevant if code is copied or distributed. No dependency was added or upgraded for this documentation revision.

Existing Git submodules and the Node lockfile describe the current checkout. They do not impose a policy to freeze the remote server, scripts, cards, model prompts, or decks. Follow normal upstream updates and repair compatibility when a concrete problem appears. Native replays are the chosen record; exact reconstruction of every historical environment is outside this release.

## Decisions from the 2026-10-04 Review

| Topic | Current decision |
|---|---|
| Game evidence | Native records/replays and existing model-session history; no custom experiment ledger. |
| Server functionality | Use its supported room settings, cards, match flow, and player information directly. |
| Model tools | No project-imposed tool restriction or permission-audit system. |
| Additional redaction | Consider only after confirmed disclosure and after existing solutions have been exhausted. |
| Versions and cards | Normal updates; no manifest, hash, or environment-freezing requirement. |
| Required experience | Model deck construction, Bo3, sideboarding, chat, and native match review. |
| Deferred | Narration, public rankings, RL training, and learned cross-game memory. |

The previous canary, validator, staged qualification, fixed-deck-first, and server-attestation proposals are retired. They are not an implementation backlog. [alignment.md](../alignment.md) remains a historical discussion; the revised concept is the source for the next architecture work.
