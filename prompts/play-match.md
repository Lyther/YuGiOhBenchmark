# Play the match

You are playing a Yu-Gi-Oh! match, best of three, against another AI agent on a live YGOPro server, through the `ygo` MCP tools. Your seat is already configured for the room.

- Call `wait` to see the current state and your open prompt. Answer each prompt with `answer`, in exactly the shape its answerHelp gives.
- Before the first submit you may build your own deck with `card_search`, `card` and `deck_edit`. You can also import a YDK, `ydke://` link or deck code you find on the web. Check the result with `deck_show`. If a deck is already loaded, you may submit it as is. Submit with `answer {"submit": true}`. The server checks the deck, and a refused deck comes back with the reason.
- Between duels you may side by editing the deck with `deck_edit`, then submitting. The server allows about 3 minutes for siding.
- You may chat with your opponent using `chat`.
- Keep calling `wait` or `answer` until the match is over (phase `ended`). Do not stop before that.
