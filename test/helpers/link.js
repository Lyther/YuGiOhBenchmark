import { YGOProCtos } from "ygopro-msg-encode";

import { parseServerPacket } from "../../src/protocol/packets.js";

// SUBSTITUTE_JUSTIFICATION
// - substitute: createLink in sessions.test.js and controller.test.js. The
//   controller tests that need no controlled packets run over real TCP: the
//   checks that nothing is sent, the one-call rule and a stop mid-match.
// - replaces: the live network connection, including incoming packet timing.
// - necessity: every other controller test checks one of these, which 2339
//   cannot be made to produce on demand: a server error or refusal (VERERROR,
//   DECKERROR, SIDEERROR, MSG_RETRY, a refused rejoin or surrender); a rare
//   server state (an observer seat, a forfeit, a match kill, a duel that ended
//   while the seat was away, chat from an observer or the server); packets that
//   must arrive in one callback or in a set order (chat with the match end,
//   deck edits during a join); or a close or replay at a set time. Their lobby
//   and duel steps only reach that state. Captured bytes need a driver that
//   delivers them in their original order.
// - proof-limit: every use is diagnostic; none proves interoperability or that
//   the server accepts the seat's responses.
// - real-proof: npm run smoke, and the 2026-10-12 agent match on 2339
//   (docs/status.md).
export function createLink() {
  const link = {
    connects: [],
    sent: [],
    open: false,
    handlers: null,
    connect(options) {
      link.connects.push({ host: options.host, port: options.port });
      link.handlers = options;
      link.open = true;
      return Promise.resolve({
        get closed() { return !link.open; },
        send(bytes) {
          if (!link.open) throw new Error("connection is closed");
          link.sent.push(YGOProCtos.getInstanceFromPayload(bytes));
        },
        async close() {
          if (!link.open) return;
          link.open = false;
          options.onClose({ reason: "local", error: null });
        },
      });
    },
    deliver(bytes) {
      let parsed;
      try {
        parsed = parseServerPacket(bytes);
      } catch (error) {
        link.handlers.onError(error, bytes);
        return;
      }
      link.handlers.onMessage(parsed, bytes);
    },
    serverClose() {
      link.open = false;
      link.handlers.onClose({ reason: "server-closed", error: null });
    },
    take() {
      const packets = link.sent.splice(0);
      return packets;
    },
  };
  return link;
}
