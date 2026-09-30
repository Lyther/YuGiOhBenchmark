# YuGiOhBenchmark

LLM-versus-LLM Yu-Gi-Oh reasoning benchmark. A thin seat adapter uses the existing YGOPro server at `koishi.momobako.com:2339`. The rules engine stays on that server.

Decision record: [alignment.md](alignment.md).

## Layout

```text
src/protocol/     wire codec
src/seat/         lobby join, npm start
test/protocol/    codec tests
third_party/      server lineage, codec sources, WindBot relay
reference/        other repositories named in alignment.md
```

Populate the checkouts with:

```bash
git submodule update --init --recursive
```

`npm start` uses the published `ygopro-msg-encode` package. The `third_party/ygopro-msg-encode` checkout is the same source, pinned separately. The `reference/` trees are not the seat implementation.

## Prerequisites

- Node.js 22 or newer.
- Network access to `koishi.momobako.com:2339` for `npm start`.

`npm test` uses the real `ygopro-msg-encode` codec and does not open a socket.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

This opens one seat, sends player info and a join for a fresh room name, prints the server's lobby packets as JSON, then leaves. Optional overrides are listed in `.env.example` (`YGO_HOST`, `YGO_PORT`, `YGO_NAME`, `YGO_ROOM`, `YGO_VERSION`). The process reads the environment directly.

A version mismatch is retried once with the version the server returns.

## Test

```bash
npm test
```

## Limits

- The running slice is the lobby handshake. It does not submit a deck, play a duel, or expose MCP.
- The WindBot relay, a local card database, and the zero-token full duel are still ahead. That duel is the gate before two model clients.
- Room rules are whatever this public port assigns. A live join on 2026-09-30 got client version `0x1362`, a single Master Rule 5 duel, 8000 LP, deck check on, and `timeLimit` 240. The JSON report is the source for the next run.
- Chat lines are printed for the operator. They are not a model context.
