# Contracts

Status: ACCEPTED (2026-10-07)

Source: [architecture.md](architecture.md), [context/concept-zero.md](context/concept-zero.md)

Last updated: 2026-10-07

## Applicability and Canonical Sources

- **Domain and data: `REQUIRED`.** The seat owns in-memory match state for one process and writes an append-only run folder. It reads card data it does not own. There is no database, so there are no migrations.
- **Interfaces: `REQUIRED`.** The interfaces are:
  - MCP tools over stdio (agent runtimes, the smoke command);
  - CLI commands;
  - environment configuration;
  - the card-data input layout;
  - the run-folder output files.

  There is no HTTP or RPC surface.
- **Canonical sources.** The code now exists, so each fact has one source in code:
  - tool inputs: the zod schemas in `src/mcp/tools.js`, with `test/mcp/tools.test.js` snapshotting `tools/list` so contract changes show up in review;
  - DTO mapping: `src/seat/view.js`;
  - file formats: `src/seat/record.js`;
  - environment: `src/config.js`;
  - card sources: `src/cards/sources.js`.

  This document then keeps the behavior rules and links to those files. A change to any of them updates this document in the same commit.

## Domain Model

All entities live in one seat process and die with it, except the run-folder files.

- **Seat** (owner `seat/controller.js`, one per process).
  - `phase`: `deck | lobby | rps | first | duel | side | ended | disconnected`.
  - Allowed moves:
    - `deck → lobby` (submit sent);
    - `lobby → deck` (`DECKERROR`);
    - `lobby → rps` (`SELECT_HAND`);
    - `rps → rps` (a tie re-sends `SELECT_HAND`);
    - `rps → first` (`SELECT_TP`, RPS winner only);
    - `rps | first → duel` (`DUEL_START`/`MSG_START`);
    - `duel → side` (`CHANGE_SIDE`);
    - `side → first | duel` (next duel);
    - `duel | side → ended` (`DUEL_END`, then the replay wait in architecture Runtime View);
    - any phase → `disconnected` (a refused join, or a rejoin that was refused or ran out of attempts; see Rejoin).

    A lost connection or a server packet the seat could not handle changes no phase: the seat rejoins with `waiting: rejoin`.

    Owner: `controller.js`.
  - `prompt`: the current Prompt or none. At most one prompt is pending. `lastPrompt` is kept for `MSG_RETRY`.
  - `events`: an append-only list of Events with sequence numbers starting at 1. It is never rewritten.
  - `delivered`: `{event, boardVersion}`, the last sequence number and board version returned to the caller. Both only increase.
  - `deck` (WorkingDeck) and `submitted` (a WorkingDeck snapshot or none).
  - `lobby`: `{host: boolean, opponent: string | null, opponentReady: boolean}`.
  - `match`: `{duel, results: DuelResult[], score: {me, opponent, draws}}`. `duel` is the server's duel number, from 1. The seat assumes no match length: the server's `DUEL_END` ends the match after however many duels it took.
  - `disconnect`: `{reason}` or none. It is set exactly once and ends the phase machine.
- **Board** (owner `game/board.js`, one per duel, built at `MSG_START`).
  - `me`: the duel player index (0 or 1) from `MSG_START`. It is fixed for the duel and may change in the next one.
  - `turn`, `phase` (draw, standby, main1, battle start/step, damage, damage calc, main2, end), `turnPlayer` (`me | opponent`), `lp: {me, opponent}`.
  - `sides.me` and `sides.opponent`, each with:
    - `hand: CardState[]`;
    - `monsters: (CardState | null)[7]`: indexes 0–4 are the main zones and 5–6 the Extra Monster Zones (left and right from that player's view); a card there sits in its controller's array;
    - `spells: (CardState | null)[8]`: indexes 0–4 are S/T zones (0 and 4 double as Pendulum zones under MR5), 5 is the Field zone, and 6–7 are unused under MR5 but kept because the server always sends 8 slots;
    - `deck: number`;
    - `extra: CardState[]`: the opponent's entries are face-down unless revealed;
    - `grave: CardState[]` and `banished: CardState[]`, top last.
  - `chain`: `{card: ZoneRef, code, desc, controller}[]`, oldest first.
  - `version`: increments on every change.
  - Invariant: a zone's contents equal the server's latest `UPDATE_DATA` for that zone, with later deltas applied. Owner: `board.js`; proof: `board.test.js`.
- **CardState.**
  - `code` (0 = unknown to this player), `position` (`faceup-attack | facedown-attack | faceup-defense | facedown-defense | faceup | facedown`).
  - Optional: `attack`, `defense`, `level`, `rank`, `link`, `counters: {name, count}[]`, `overlays: code[]`, `equippedTo: ZoneRef`, `targets: ZoneRef[]`, `negated: boolean`, `scales: {left, right}`.
  - A **ZoneRef** is `{side: me | opponent, zone: hand | monster | spell | deck | extra | grave | banished, index}`.
- **Prompt** (owner `game/prompts/*`). It is immutable after `build`.
  - `seq` (increasing), `kind` (closed set, listed in Answers), `text`, `options: Option[]`, constraints (`min`, `max`, `sumTarget`, `sumMode`, `must`, `total`, `cancelable`, `finishable`), `rejected` (string or none).
  - Internal only: `source`, the parsed message object.
  - Invariant: option `n` is the 1-based position of the n-th entry built from `source`'s arrays. `encode` only accepts numbers in range.
- **Option.** `{n, label, card?: {code, name, where}, detail?}`, plus the number the server judges the card by, in the three prompts that have one (architecture D-05):
  - `tributes` (`SELECT_TRIBUTE`): how many tributes the card counts as (`releaseParam`);
  - `values` (`SELECT_SUM`): the one or two amounts the card can count as, decoded from `opParam` the way ocgcore does;
  - `counters` (`SELECT_COUNTER`): how many of the requested counter the card holds.

  Internal only: `ref` (array index and command type for `IndexResponse`).
- **Event** (owner `game/events.js` and `controller.js`). `{seq, duel, turn, kind, text}`.
  - `kind` is one of: `lobby | duel | turn | phase | draw | summon | set | move | position | activate | chain | resolve | negate | attack | battle | damage | lp | counter | target | reveal | shuffle | random | hint | win | auto | rejected | chat | server | unreadable`.
  - Chat events add `from: opponent | observer | server`.
- **WorkingDeck** (owner `deck/deck.js`). `{main: code[], extra: code[], side: code[]}`, order preserved.
  - Codes are positive integers below 2^28.
  - There are no count or legality rules; the server owns them.
- **DuelResult** (owner `controller.js`, persisted by `record.js`). `{duel, result: win | loss | draw, reason, reasonCode, turns, first: boolean, at}`.
- **Card** (catalog read model, owner `cards/catalog.js`, read-only).
  - `{code, alias, name, text, kind (monster | spell | trap), types: string[], attribute?, race?, level?, rank?, link?, linkMarkers?, atk?, def?, scales?, setnames: string[], strings: string[16], source: en-US | super-pre-en | super-pre | zh-CN | first-edition}`.
  - `first-edition` means an operator pack replaced the text and effect strings; the name and stats are still those of the base source.

Not stored anywhere: model reasoning, tool-call history (the runtime keeps it), the opponent's hidden cards, metrics.

## Persistent Data

`record.js` is the only writer. All files are append-only or write-once, except `seat.json`, which is replaced atomically. The seat reads its folder back only to resume an interrupted match (Rejoin).

- **Folder:** `<YGO_RUN_DIR>/<roomId>/<name>/`.
  - `roomId` is the part of `YGO_ROOM` after `#`.
  - Both `roomId` and `name` are reduced to `[A-Za-z0-9._-]`, with other characters replaced by `_`. A part that changed this way gets `-` and the first 8 hex digits of its SHA-256, so names that differ stay apart.
  - The folder is claimed at the first deck submit, before anything is sent to the server:
    - no folder: it is created;
    - a folder whose `seat.json` names a seat process that has exited, with no `match` or `aborted` line: the new seat takes it over and resumes that match (a folder left before any duel started is reused afresh, its lobby deck file dropped);
    - otherwise the submit fails with the reason and nothing is sent: the owning seat is still running (a colliding seat), the match is over (a rerun), or the folder holds no `seat.json`.
- **`seat.json`.** The resume checkpoint, replaced atomically: `{"pid":4242,"started":true,"duel":2,"turn":5}`. It is written at the claim, at the first `DUEL_START` (`started`: srvpro now holds the seat on a drop), at each `MSG_START` and at each new turn, because a rejoin's field reload carries no turn count.
- **`results.jsonl`.** UTF-8, one JSON object per line, append-only:
  - `{"type":"duel","room":"M,TM0,NF#abc123","duel":1,"result":"win","reason":"LP reached 0","reasonCode":1,"turns":7,"first":true,"at":"2026-10-07T12:00:00.000Z"}`
  - `{"type":"match","room":"M,TM0,NF#abc123","result":"win","score":{"me":2,"opponent":1,"draws":0},"opponent":"gpt-seat","at":"…"}`, written once when the server ends the match, whether that took one, two or three duels.
    - A lost connection (`reasonCode` 4) ends the match. The player who stayed wins it whatever the score, and the line adds `"forfeit":true`. A leave between duels adds no `duel` line, because no duel was played.
    - A match-winning card effect (`MSG_MATCH_KILL`) ends the match after its duel. That duel's winner wins the match whatever the score, and the line adds `"matchKill":true`. If that duel is a draw, the score decides.
  - `{"type":"aborted","room":"…","phase":"duel","duel":2,"reason":"could not rejoin after 6 attempts (first: server-closed; last: server-closed)","at":"…"}`, written once if the seat disconnects before `match`.
  - `{"type":"interrupted","room":"…","phase":"duel","duel":2,"turn":5,"reason":"stdin closed","at":"…"}`, written when the seat process stops during a started match. It is not a result: the server still holds the seat (Rejoin).
  - `reason` is the catalog's `!victory` text for `reasonCode`, or `"#<code>"` if unknown.
  - Consumers must ignore unknown fields; new fields are only ever added.
- **`duel-<n>.ydk`.** The standard YDK text of the deck sent for duel *n*, written at each successful submit.
- **`replay-<k>.yrp`.** The `STOC_REPLAY` payload bytes exactly as received, numbered in arrival order from 1. The server sends one per duel; the seat keeps whatever arrives and requires no count. These files are not re-encoded.
- **`session.bin`.** Written only when `YGO_CAPTURE=1`. Each received packet is stored as a record: `u32le` milliseconds since connect, `u16le` length, then the full packet bytes including the 2-byte length and 1-byte STOC id. It is the fixture format for `test/fixtures/sessions/`.
- **Write failures.** An error event plus a log line; play continues.
- **Retention.** Left to the operator. `runs/` is gitignored.

## Rejoin

Resume first: a lost connection or a damaged seat state never gives a match up by itself. The seat comes back through srvpro's reconnect, which holds a dropped player's duel and lets the same player back in.

- **Triggers.** The server closing the socket, a socket error, or a server packet the seat could not read or handle (`unreadable` event). A failed packet can leave the board or the pending prompt stale, so the seat drops its connection and reloads the server's copy. Faults rejoin at most twice per duel; after that the seat reports them and plays on with what it has.
- **Before the first duel** (srvpro's lobby stage) srvpro does not hold the seat. The rejoin is a fresh join that sends the deck and `READY` again; after a refused deck it waits for the model's submit.
- **After the first duel started**, the rejoin sends `PLAYER_INFO` and `JOIN_GAME` with the same name and room, then `UPDATE_DECK` with the deck last sent before the first duel (srvpro compares those bytes). It never sends `READY` (during siding that would mark the side deck submitted). srvpro then sends `DUEL_START` and, by stage: `SELECT_HAND`, `SELECT_TP`, `CHANGE_SIDE`, or mid-duel an `MSG_START` with empty decks, `MSG_NEW_TURN`, `MSG_NEW_PHASE`, `MSG_RELOAD_FIELD`, `MSG_UPDATE_DATA` per location, and the pending hint and prompt (verified on 2339, fixtures `rejoin-a-*.bin`).
  - That `MSG_START` continues the current duel: no duel is counted and the turn count is kept, because the server does not resend it.
  - The pending prompt is cleared at the drop and comes back as a new prompt `seq`.
- **Attempts.** Backoff 1, 2, 4, 8, 16, 16 s, each with jitter in [0.5, 1.5): about 47 s, inside srvpro's default 90 s hold (2339 held a dropped seat for 298 s on 2026-10-08). At most 10 rejoins per match.
- **Refusals end the match record.** Seated as an observer (srvpro no longer holds the seat), or a deck error (the deck differs) → `disconnected` with that reason and an `aborted` line. So does running out of attempts. A fault alone never records a duel or match result.
- **A restarted seat** (the agent or its process stopped) resumes from its run folder when started with the same `YGO_ROOM`, `YGO_NAME` and `YGO_RUN_DIR` within srvpro's hold (about 5 minutes on 2339). Its deck prompt says so. Its submit restores the duel results, score, recorded decks and replay count, then rejoins as above with `duel-1.ydk`, whatever deck the new process was given; the working deck becomes the last one recorded. The turn count comes from `seat.json`. If the server no longer restores the match within 15 s of the rejoin (for example it already forfeited the seat, or made a new room of that name), the rejoin is refused.
- **Stopping.** A seat that stops during a started match (stdin closed, `SIGTERM`, `SIGINT`) does not send `LEAVE_GAME`, which would forfeit; it writes an `interrupted` line and closes the socket. srvpro forfeits the seat only if nobody rejoins within its hold. Before the first duel and after the match the seat leaves normally.
- **Limits.** A duel that ends while the seat is away (the opponent surrendered) is not seen; srvpro resends no `MSG_WIN`. A match-winning effect announced while away is lost the same way. When a dropped player never returns, 2339 closed the other player's socket after the hold with no `MSG_WIN`; that seat's rejoin then finds no match and records `aborted`, not a win.

## MCP Tools

There is one server, named `ygo`. Its full set is eight tools, listed in this order: `wait`, `answer`, `deck_show`, `deck_edit`, `card`, `card_search`, `chat`, `surrender`. A tool is registered once it works (roadmap), and the list never changes while a seat runs.

Rules shared by all tools:

- **Result.** A single text block. Tools that return the seat state accept `format: "text" | "json"` (default `text`). `json` returns the same DTO as JSON text. Text layout is not a stable interface; the JSON shape is.
- **Size.** No limit. A result carries every undelivered event and the full prompt; the seat never drops or shortens anything.
  - Every tool declares `_meta["anthropic/maxResultSizeChars"]: 500000`, so Claude Code keeps results inline instead of saving them to a file. Other clients ignore the key.
  - Other runtimes' output limits are raised in the launch recipes (architecture Operations).
  - The seat logs each result's size.
- **Errors.**
  - Argument shape errors are rejected by the schema.
  - Seat-state errors return `isError: true` with one sentence and a `next` hint. The cases are: no pending prompt, an answer field that does not fit the prompt kind, an option number out of range, an unknown card name in a deck edit, chat while not connected, an answer, chat or surrender while the seat is rejoining, or a tool called after `disconnected`.
  - Server rejections are never tool errors. They come back as the next prompt with `rejected`.
- **Annotations.** `deck_show`, `card` and `card_search` declare `readOnlyHint: true`; the other tools declare none. Approval is configured in the runtime (architecture Operations), not inferred from hints.
- **Concurrency.** At most one blocking call (`wait`, `answer`, `surrender`) runs at a time per seat. A second one returns an `isError` that says a call is already waiting. `deck_show`, `deck_edit`, `card`, `card_search` and `chat` can run at any time, including while a `wait` is blocked.

### `wait`

- **Input:** `{full?: boolean, format?}`.
- **Behavior:**
  - Returns at once if a prompt is pending or the phase is `ended` or `disconnected`.
  - Otherwise it blocks until one of those happens, an opponent chat line arrives, or `YGO_WAIT_MS` passes.
  - It advances the `delivered` cursors past everything it returns.
- **Result:** SeatView. The board is included when it changed since it was last delivered, or when `full` is true.

### `answer`

- **Input:** exactly one of these fields, plus `format?`:
  - `choose: int[]`
  - `counts: {option: int, count: int}[]`
  - `card: int | string`
  - `submit: true`
  - `cancel: true`
  - `finish: true`
- **Behavior:**
  - The seat checks that the field fits the pending prompt's kind (see Answers) and that the numbers are in range.
  - It encodes the answer (or, for `deck`/`side`, sends the working deck), clears the prompt, then waits exactly as `wait` does.
  - A `MSG_RETRY`, `DECKERROR` or `SIDEERROR` reply comes back as the re-issued prompt with `rejected` set.
- **Result:** SeatView.

### `deck_show`

- **Input:** `{format?: "text" | "json" | "ydk" | "ydke" | "code"}`.
- **Result:**
  - `text`/`json`: a DeckView of the working deck.
  - `ydk`/`ydke`/`code`: the export string, via `ygopro-deck-encode`.

### `deck_edit`

- **Input:** `{import?: string, clear?: boolean, add?: Edit[], remove?: Edit[], move?: Move[]}`, applied in the order `import`, `clear`, `remove`, `add`, `move`.
  - `Edit` is `{card: int | string, count?: 1..60, section?: "main" | "extra" | "side"}`.
  - `Move` is `{card: int | string, count?: int, from: section, to: section}`.
- **Behavior:**
  - `import` replaces the deck and accepts YDK text, a `ydke://` URL or a KoishiPro deck code.
  - A name must resolve to exactly one catalog card (case-insensitive exact name, then a unique prefix). Otherwise the call is an error that lists up to 5 suggestions.
  - `add` without a section puts Fusion/Synchro/Xyz/Link cards in extra and everything else in main.
  - Edits are allowed in any phase; only the submitted deck matters.
- **Result:** DeckView.

### `card`

- **Input:** `{code?: int, name?: string}`, exactly one.
- **Result:** CardInfo, or `isError` with up to 5 suggestions.

### `card_search`

- **Input:** `{text?, name?, kind?: "monster" | "spell" | "trap", types?: string[], attribute?, race?, setname?, level?, levelMin?, levelMax?, atkMin?, atkMax?, defMin?, defMax?, limit?: 1..50 (default 20), offset?: int (default 0)}`.
  - `text` matches card text and `name` matches names, both as case-insensitive substrings.
  - `types` uses the type words in DTO Vocabularies (all must match).
  - `attribute`, `race` and `setname` are names from the catalog's strings.
- **Result:** `{total, offset, cards: CardBrief[]}`, ordered by name then code.

### `chat`

- **Input:** `{text: string}`, 1–255 characters.
- **Behavior:** sends `CTOS_CHAT` as given. A line starting with `/` is a srvpro command and is not shown to the opponent. Calling it before the seat connects is an error.
- **Result:** the line as sent and the number of undelivered events. Chat events, including replies, arrive through `wait`, so each is delivered exactly once.

### `surrender`

- **Input:** `{}`.
- **Behavior:** sends `CTOS_SURRENDER` for the current duel. Allowed only in the `duel` phase.
- **Result:** SeatView after the server's reaction (same wait rules as `answer`).

## DTOs

- **SeatView.**
  - `phase`, `room`, `you: {name, host}`, `opponent: string | null`.
  - `match: {duel, score: {me, opponent, draws}}`.
  - `board: BoardView | null` (null means unchanged), `boardVersion`.
  - `events: EventView[]`: every event after the cursor.
  - `prompt: PromptView | null`.
  - `waiting`: `opponent | server | rejoin | null`.
  - `disconnected`: a reason or null.
  - `next`: one imperative sentence telling the model what to call.
- **BoardView.**
  - `duel`, `turn`, `phase`, `turnPlayer`, `lp: {you, opponent}`.
  - `you: SideView` and `opponent: SideView`.
  - `chain: {n, card: CardRefView, effect}[]`.
- **SideView.**
  - `hand`: `CardRefView[]` for you; for the opponent, a count plus any revealed cards.
  - `monsters` and `spells`: slot arrays of `CardRefView | null`.
  - `deck`: count.
  - `extra`: `CardRefView[]` for you; for the opponent, a count plus face-up cards.
  - `grave` and `banished`: `CardRefView[]`.
- **CardRefView.**
  - `name` (or `"face-down card"`), `code` (absent when unknown), `position`.
  - Optional: `atk`, `def`, `level` / `rank` / `link`, `counters`, `materials` (names), `equippedTo`, `targets` (zone labels), `scales: {left, right}`, `negated`. Scales are the server's current values; Extra Deck and banished cards keep their face-up/face-down position.
- **PromptView.**
  - `seq`, `kind`, `text`, `options: {n, label, tributes?, values?, counters?}[]`.
  - Optional, kind-dependent: `min`, `max`, `sumTarget`, `sumMode` (`exactly` | `at least`), `mustInclude` (`{label, values}[]`), `total`, `cancelable`, `finishable`, `rejected`.
  - `answerHelp`: the exact answer shape for this kind.
- **EventView.** `{seq, turn, text}`. The JSON form adds `kind` and, for chat, `from`.
- **DeckView.** `{main: Entry[], extra: Entry[], side: Entry[], counts: {main, extra, side}}`, where an `Entry` is `{code, name, count}`, grouped by code in first-seen order.
- **CardInfo.** All Card fields except `strings` and `source`, plus `sourceNote` when the text does not come from en-US. Examples: "community translation of a pre-release card", "Chinese text: no English available yet".
- **CardBrief.** `{code, name, kind, types, attribute?, race?, level? | rank? | link?, atk?, def?}`.
- **Vocabularies** (closed sets in English). Attributes, races and type words come from the en-US `strings.conf` and the CDB type bits:
  - `normal effect fusion ritual synchro xyz pendulum link tuner spirit union gemini flip toon token quick-play continuous equip field counter`.

## Answers by Prompt Kind

The `kind` values are closed. Each row gives the answer field, what the server accepts, and when the seat answers automatically (AD-07). The seat states the rule and the server checks it.

| Kind | Source | Answer | Auto when |
|---|---|---|---|
| `deck`, `side` | seat / `CHANGE_SIDE` | `submit` | never |
| `rps` | `SELECT_HAND`, `MSG_ROCK_PAPER_SCISSORS` | `choose` 1 of Rock, Paper, Scissors | never |
| `first` | `SELECT_TP` | `choose` 1 of Go first, Go second | never |
| `command` | `SELECT_IDLECMD` | `choose` 1 | never |
| `battle` | `SELECT_BATTLECMD` | `choose` 1 | never |
| `yesno`, `effect` | `SELECT_YESNO`, `SELECT_EFFECTYN` | `choose` 1 of Yes, No | never |
| `option` | `SELECT_OPTION` | `choose` 1 | one option |
| `chain` | `SELECT_CHAIN` | `choose` 1 (option 1 is Pass unless forced) | zero options, or one forced option |
| `cards` | `SELECT_CARD` | `choose` `min`..`max` cards, or `cancel` if cancelable | `min` = `max` = number of cards, not cancelable |
| `tribute` | `SELECT_TRIBUTE` | `choose` at most `max` cards whose `tributes` add up to at least `min`, or `cancel` if cancelable | every card counts as 1 tribute, `min` = `max` = number of cards, not cancelable |
| `unselect` | `SELECT_UNSELECT_CARD` | `choose` 1, or `finish` / `cancel` when allowed | never |
| `sum` | `SELECT_SUM` | `choose` the non-mandatory cards; each card, mandatory ones included, counts as one of its `values`. `exactly`: `min`..`max` chosen cards whose total can equal `sumTarget`. `at least`: the total reaches `sumTarget` with no spare card. Mandatory cards are in `mustInclude` | never |
| `sort` | `SORT_CARD` | `choose` all options in the new order, or `cancel` to keep the order; the seat sends each card's new position, as ocgcore reads it | one card |
| `counter` | `SELECT_COUNTER` | `counts` adding up to `total`, each at most that card's `counters` | one card |
| `place` | `SELECT_PLACE`, `SELECT_DISFIELD` | `choose` `min` zones. A server count of 0 (setting a Spell/Trap) means 1 zone or `cancel`; the seat sends a cancel as `[player, 0, 0]` | exactly `min` zones available, not cancelable |
| `position` | `SELECT_POSITION` | `choose` 1 | one position |
| `race`, `attribute` | `ANNOUNCE_RACE`, `ANNOUNCE_ATTRIB` | `choose` exactly `min` | available = `min` |
| `number` | `ANNOUNCE_NUMBER` | `choose` 1 | one number |
| `declare` | `ANNOUNCE_CARD` | `card` (code or exact name); the server checks it | never |

For `tribute`, `min` is a tribute total and `max` a card count. A card worth two tributes can make several answers legal, so a tribute is answered automatically only when every card counts as one. `sumMode` is `exactly` when the message's mode is 0 and `at least` when it is 1.

`choose: []` submits zero cards for card, tribute and sum selections. It is distinct from cancellation; the server decides whether the empty selection is legal, including a sum met by mandatory cards alone.

Every automatic answer appends an `auto` event naming what was chosen. The seat also answers `STOC_TIME_LIMIT` with `CTOS_TIME_CONFIRM` and, as host, sends `HS_START`; neither produces an event.

## Mapping and Validation Ownership

- **SeatView** is built by `seat/view.js` from Seat, Board and Prompt.
  - `board` comes from `board.js` state, with absolute player ids converted to `you` / `opponent`.
  - `events` are all Events with `seq` greater than `delivered.event`.
  - `next` is derived from phase and prompt.
- **PromptView** omits `source` and every Option's `ref`.
  - Labels come from `labels.js` and the catalog. A zeroed code is resolved through the board; if that fails, the label is `face-down card` plus the zone.
  - `tributes`, `values` and `counters` are copied from the message, with `values` split as ocgcore's `get_sum_params` does.
- **These never cross the boundary:**
  - parsed message objects, raw bytes, `IndexResponse` refs;
  - absolute player ids;
  - sockets, timers, file paths, configuration other than `room` and `name`;
  - log records, `lastPrompt`.
- **Validation layers:**
  - zod validates shapes and ranges at `mcp/tools.js`.
  - The seat checks only that an answer fits the pending prompt (`prompts/index.js` `encode`) and that deck-edit names resolve (`deck.js`). It never checks game legality.
  - The server validates decks, side swaps, answers and declarations.
- **Wire mapping:** answers go to `CTOS_RESPONSE` bytes through `ygopro-msg-encode` `prepareResponse` with `IndexResponse`, or a primitive (position bit, zone triple, number, code). `SELECT_SUM` is padded for mandatory cards (architecture D-02). The deck goes to `CTOS_UPDATE_DECK` through `YGOProDeck`.

## CLI

- `npm run seat`: the MCP seat on stdio. Configured only by environment; no arguments.
- `npm run smoke [-- --room <flags#id>] [--deck <ydk>] [--names <a>,<b>]`: a model-free plumbing check. The room defaults to a fresh `M,TM0,NF#sm<8 hex>`, the deck to `decks/sample.ydk`.
  - Two seats submit the deck, play fixed rock-paper-scissors hands, go first when asked, send one chat line each, surrender at their first in-duel prompt and keep the deck at each side prompt.
  - Exits 0 when both seats reached `ended`, each heard the other's chat line, and both run folders hold a `match` line, one replay per duel played and the deck of each duel. Otherwise it exits 1 and prints what is missing.
- `npm run cards`: refreshes `YGO_CARDS_DIR`. Exits 0 when every source was fetched or was already current, and 1 on any failure, in which case existing files are kept.
- `npm run probe` (also `npm start`): one lobby join; prints JSON; leaves.
- `npm test`: `node --test "test/**/*.test.js"`, offline.

## Configuration

| Variable | Default | Rule | Read by |
|---|---|---|---|
| `YGO_HOST` | `koishi.momobako.com` | hostname | seat, probe |
| `YGO_PORT` | `2339` | 1–65535 | seat, probe |
| `YGO_VERSION` | `0x1362` | uint16, hex or decimal | seat, probe |
| `YGO_NAME` | `ygobench-<4 hex>` | 1–19 UTF-16 units; distinct per seat in a match | seat, probe |
| `YGO_ROOM` | required for seat; random for probe | 1–19 UTF-16 units. Bo3 is `M,TM0,NF#<id>`, so `<id>` has at most 10 characters; a Bo1 room drops the `M` | seat, probe |
| `YGO_DECK` | none | path to a `.ydk` loaded as the working deck at start | seat |
| `YGO_RUN_DIR` | `./runs` | writable directory | seat |
| `YGO_CARDS_DIR` | `./data/cards` | readable directory with the layout below | seat, cards |
| `YGO_WAIT_MS` | `240000` | 1000–1,500,000; below the per-call timeout each recipe sets (Codex 300 s) and Claude Code's 30-minute stdio idle window | seat |
| `YGO_CAPTURE` | `0` | `0` or `1` | seat |
| `YGO_LOG_LEVEL` | `info` | pino level | all |

An invalid value stops the process at start, with the variable named on stderr. The smoke command sets `YGO_ROOM`, `YGO_NAME` and `YGO_DECK` for the two seats it spawns.

## Card Data Inputs

`npm run cards` downloads individual files into this layout under `YGO_CARDS_DIR`. The URLs below were checked on 2026-10-07, and `src/cards/sources.js` holds the canonical list.

```text
en-US/cards.cdb, en-US/strings.conf
    https://raw.githubusercontent.com/mycard/ygopro-database/master/locales/en-US/{cards.cdb,strings.conf}
super-pre-en/test-release.cdb, super-pre-en/test-strings.conf
    https://raw.githubusercontent.com/ElderLich/TransSuperpre/main/EN/Base%20Files/{test-release.cdb,test-strings.conf}
super-pre/test-release.cdb, super-pre/test-update.cdb, super-pre/test-strings.conf
    https://cdn02.moecube.com:444/ygopro-super-pre/data/{test-release.cdb,test-update.cdb,test-strings.conf}
zh-CN/cards.cdb, zh-CN/strings.conf
    https://raw.githubusercontent.com/mycard/ygopro-database/master/locales/zh-CN/{cards.cdb,strings.conf}
```

- **Merge order.** The catalog merges cards lowest priority first, so later rows replace earlier ones: zh-CN, super-pre (release then update), super-pre-en, en-US. A code is described by the highest-priority source that has it.
- **Strings.** `strings.conf` files merge the same way. `test-strings.conf` only adds setnames and counters.
- **Missing files.** A missing en-US set is fatal at seat start. Any other missing set is logged and skipped.
- **Failed refresh.** Each file is downloaded with a 5-minute timeout and up to three attempts with jittered backoff (server errors only), staged under a temporary name, and renamed into place only after the whole set for that source arrives. A file must also look like what it claims to be: a `.cdb` starts with the SQLite header, a strings file has `!` entries, and nothing is over 64 MiB. That way an error page or captive portal answering 200 cannot replace good data. On failure the previous files stay. At seat start, an unreadable optional database is logged and skipped; an unreadable en-US one stops the seat and names `npm run cards`. Behind an HTTP proxy, run with `NODE_USE_ENV_PROXY=1`.
- **First-edition packs.** Optional `first-edition/*.ypk` files are placed by the operator and never downloaded. Every CDB inside a pack replaces the `text` and the non-empty effect strings of its cards, and those cards report `source: first-edition`. A pack that cannot be read is logged and skipped.

## Compatibility

- The seat, the smoke command and the tests ship together, so there is no wire-version field.
- **Tool names and input fields** are stable. New inputs must be optional. Removing or renaming one is a breaking change and needs a concept or contract update.
- **JSON DTOs and `results.jsonl`** only gain fields; consumers ignore unknown fields.
- **Text output** may change at any time.
- **YGOPro version.** The version starts at `YGO_VERSION`. One `VERERROR` retry adopts the server's version and logs it.

## Examples

`wait` in the deck phase (text):

```text
Phase: deck · room M,TM0,NF#abc123 · you: opus-seat
Prompt 1 · deck
Build your deck: Main 40–60, Extra ≤15, Side ≤15 (the server checks it). Use card_search, card and deck_edit; deck_show to review.
Answer: answer {"submit": true}
Next: build the deck, then submit.
```

`answer` returning a command prompt (text, abridged):

```text
Duel 1 · Turn 3 · Main Phase 1 · your turn · LP you 8000 / opponent 6100
Opponent: hand 4 · deck 31 · extra 15 · GY 2 · banished 0
  M: [-] [Ash Blossom & Joyous Spring 0/1800 faceup-defense] [-] [-] [-] · EMZ: [-] [-]
  S: [face-down] [-] [-] [-] [-] · Field: -
You: hand 5 · deck 30 · extra 15 · GY 1 · banished 0
  M: [-] [-] [-] [-] [-] · S: [-] [-] [-] [-] [-] · Field: -
  Hand: Elemental HERO Stratos, Pot of Desires, Infinite Impermanence, Polymerization, Mirror Force
Events: #41 Opponent Special Summoned Ash Blossom & Joyous Spring to M2 · #42 Opponent's turn ends · #43 Turn 3 (you): you drew Mirror Force
Prompt 7 · command
 1) Normal Summon Elemental HERO Stratos (hand)
 2) Activate Pot of Desires (hand): "Banish 10 cards from the top of your Deck, face-down; draw 2 cards."
 3) Set Infinite Impermanence (hand)
 4) Set Mirror Force (hand)
 5) Go to Battle Phase
 6) End turn
Answer: answer {"choose": [n]}
```

A tribute prompt (text, abridged), where option 1 alone or options 1 and 2 are both legal:

```text
Prompt 12 · tribute
Select the monsters to Tribute: worth at least 2 tributes, at most 2 cards.
 1) Double Coston (your M2) · counts as 2
 2) Mystic Tomato (your M4) · counts as 1
Answer: answer {"choose": [n, …]}
```
