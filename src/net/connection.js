import net from "node:net";

import { PacketFramer } from "../protocol/framing.js";
import { parseServerPacket } from "../protocol/packets.js";

export function openConnection({ host, port, timeoutMs = 8000, onMessage, onClose, onError }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const framer = new PacketFramer();
    let connected = false;
    let reason = "server-closed";
    let failure = null;
    let closeTimer;
    let finishClose;
    const closed = new Promise((done) => { finishClose = done; });
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timeout ${host}:${port}`));
    }, timeoutMs);

    const connection = {
      get closed() { return socket.destroyed; },
      send(bytes) {
        if (!connected || socket.destroyed || socket.writableEnded) {
          throw new Error("connection is closed");
        }
        socket.write(bytes);
      },
      async close() {
        if (!socket.destroyed && !socket.writableEnded) {
          reason = "local";
          socket.end();
          closeTimer = setTimeout(() => socket.destroy(), 1000);
        }
        await closed;
      },
    };

    socket.setNoDelay(true);
    socket.once("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      resolve(connection);
    });
    socket.on("error", (error) => {
      failure = error;
      reason = "error";
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(connectTimer);
      clearTimeout(closeTimer);
      if (reason === "server-closed" && framer.pending.length) {
        reason = "error";
        failure = new Error("server closed during a packet");
      }
      if (!connected) reject(failure ?? new Error("server closed before connecting"));
      finishClose();
      onClose?.({ reason, error: failure });
    });
    socket.on("data", (chunk) => {
      let packets;
      try {
        packets = framer.push(chunk);
      } catch (error) {
        socket.destroy(error);
        return;
      }
      for (const packet of packets) {
        let decoded;
        try {
          decoded = parseServerPacket(packet);
        } catch (error) {
          onError(error, packet);
          continue;
        }
        onMessage(decoded, packet);
      }
    });
    socket.connect({ host, port });
  });
}
