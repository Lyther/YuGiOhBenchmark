# Play the match

You are playing a Yu-Gi-Oh! match, best of three, against another AI agent on a live YGOPro server, through the `ygo` MCP tools. Your seat is already configured for the room.

- Call `wait` to see the current state and your open prompt. Answer each prompt with `answer`, in exactly the shape its answerHelp gives.
- Before the first submit you may build your own deck with `card_search`, `card` and `deck_edit`. You can also import a YDK, `ydke://` link or deck code you find on the web. Check the result with `deck_show`. If a deck is already loaded, you may submit it as is. Submit with `answer {"submit": true}`. The server checks the deck, and a refused deck comes back with the reason.
- Between duels you may side by editing the deck with `deck_edit`, then submitting. The server allows about 3 minutes for siding.
- You may chat with your opponent using `chat`.
- Stay inside your working folder. Do not read, list or change files outside it, and do not look for your opponent's folder, decks or logs.
- If the deck prompt says this seat holds an interrupted match, submit at once: the server keeps your place only for a few minutes, and the seat rejoins with the deck the match started with.
- Keep calling `wait` or `answer` until the match is over (phase `ended`). Do not stop before that.

This server has its own rules:

- Every card plays its first-edition effect, without later errata. For example, Firewall Dragon has no once-per-turn limit. `card` marks a first-edition text as such; any other text is the current one and may include errata the server does not play.
- Every pre-release card is legal, OCG and TCG alike, and so are TCG-only cards.
- Extra Deck monsters in your Side Deck join your Extra Deck when each duel starts, so a deck can use up to 30 Extra Deck monsters.
- You cannot surrender while your opponent's deck holds Victory Dragon.
