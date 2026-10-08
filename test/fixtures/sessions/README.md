# Captured sessions

Raw server packets recorded with `YGO_CAPTURE=1` (contracts.md, Persistent Data `session.bin`).

- `smoke-a.bin`, `smoke-b.bin`: both seats of `npm run smoke` on `koishi.momobako.com:2339`, room `M,TM0,NF#smc1c37f09`, 2026-10-07. Seat b won rock-paper-scissors, went first and surrendered both duels at its first prompt; seat a won the match 2-0. Each file holds the lobby, both duels, siding, `DUEL_END` and the two replays the server sent.
- `rejoin-a-1.bin`, `rejoin-a-2.bin`, `rejoin-a-3.bin`: one seat's three connections in room `M,TM0,NF#rc03a2fb92` on 2339, 2026-10-08, recorded by a two-client probe (seat `rc-a-733d`, deck `decks/sample.ydk`). Connection 1: lobby and duel 1 up to the seat's first prompt, then the seat dropped its socket. Connection 2: the rejoin (same name, room and deck, no `READY`), srvpro's mid-duel restore (`MSG_START` with empty decks, `MSG_RELOAD_FIELD`, `MSG_UPDATE_DATA`, then the same prompt), a surrender and the side prompt, then another drop. Connection 3: the rejoin while siding (`DUEL_START`, `CHANGE_SIDE`), duel 2, a surrender, both replays and `DUEL_END`.
