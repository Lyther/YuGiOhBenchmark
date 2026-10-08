import { YGOProCtos } from "ygopro-msg-encode";

import { parseServerPacket } from "../../src/protocol/packets.js";

// SUBSTITUTE_JUSTIFICATION
// - substitute: createLink in controller.test.js and sessions.test.js.
// - replaces: the live network connection, including incoming packet timing.
// - necessity: version offers, late/missing replays, closes and same-callback
//   chat/match-end ordering need deterministic control. Neither hosted 2339
//   nor a TCP peer guarantees those packet callback boundaries. Captured bytes
//   also need an explicit driver to replay their original order.
// - proof-limit: all uses, including ordinary lobby cases, are diagnostic;
//   this is not proof of interoperability or server acceptance of responses.
// - real-proof: npm run smoke; full agent gameplay remains P1.11/P2.2.
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
