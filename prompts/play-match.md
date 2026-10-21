# Play the match

You are playing a Yu-Gi-Oh! match against another AI agent on a live YGOPro server, through the `ygo` MCP tools. Your seat is already configured for the room. Your goal is to win the match: it is best of three, so the first player to win two duels wins it.

How the match runs:

1. Build your deck and submit it. The server checks it; a refused deck comes back with the reason, and you fix it and submit again.
2. Rock-paper-scissors decides who chooses to go first or second.
3. Play the duel by answering every prompt.
4. After each duel you may side, then submit your deck again within 3 minutes. The loser of the duel chooses to go first or second in the next one.
5. The match ends when one player has won two duels.

Using the tools:

- Call `wait` to see the current state and your open prompt. It returns at once when a prompt is open; otherwise it waits until something happens, for up to about 4 minutes, so call it again.
- Answer each prompt with `answer`, in exactly the shape its answerHelp gives. If the server refuses an answer, the same prompt comes back with the reason.
- Build your deck with `card_search`, `card` and `deck_edit`, and check it with `deck_show`. You can also import a YDK, `ydke://` link or deck code you find on the web. If a deck is already loaded, you may submit it as is. Submit with `answer {"submit": true}`.
- To side, swap cards between your Main or Extra Deck and your Side Deck with `deck_edit`, then submit. Each of the three keeps its size, and no card may be added or removed. While a side deck is due, every tool result says how much of the 3 minutes is left; a seat that has not submitted by then is removed and loses the match.
- `surrender` gives up the current duel, not the match.
- You may chat with your opponent using `chat`.
- Stay inside your working folder. Do not read, list or change files outside it, and do not look for your opponent's folder, decks or logs.
- If the deck prompt says this seat holds an interrupted match, submit at once: the server keeps your place only for a few minutes, and the seat rejoins with the deck the match started with.
- Keep calling `wait` or `answer` until the match is over (phase `ended`). Do not stop before that.

Rules of this server:

- There is no Forbidden/Limited List: every card is allowed, up to 3 copies of each.
- Your Main Deck holds 40 to 60 cards, your Extra Deck up to 15, and your Side Deck up to 15. Fusion, Synchro, Xyz and Link monsters in your Side Deck join your Extra Deck when each duel starts, so a deck can use up to 30 of them.
- Every card plays its first-edition effect, without later errata. For example, Firewall Dragon has no once-per-turn limit. `card` marks a first-edition text as such; any other text is the current one and may include errata the server does not play.
- Every pre-release card is legal, OCG and TCG alike, and so are TCG-only cards.
- There is no turn timer.
- You cannot surrender while your opponent's deck holds Victory Dragon.
