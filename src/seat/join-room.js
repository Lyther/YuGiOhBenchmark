import { randomBytes } from "node:crypto";
import net from "node:net";
import { pathToFileURL } from "node:url";

import { YGOProStocJoinGame } from "ygopro-msg-encode";
import {
  CLIENT_VERSION,
  PacketFramer,
  describeMessage,
  encodeJoinGame,
  encodeLeaveGame,
  encodePlayerInfo,
  joinFailure,
  parseServerPacket,
  rejectedVersion,
} from "../protocol/index.js";

const DEFAULT_HOST = "koishi.momobako.com";
const DEFAULT_PORT = 2339;
const DEFAULT_NAME = "ygobench";

export async function joinRoom(options) {
  const timeoutMs = options.timeoutMs ?? 8000;
  let version = options.version;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await openSeat({ ...options, version, timeoutMs });
    if (outcome.versionMismatch === undefined) {
      return outcome;
    }
    const offered = outcome.versionMismatch;
    if (offered === version || attempt === 1) {
      throw new Error(
        `server rejected client version 0x${version.toString(16)}; offered 0x${offered.toString(16)}`,
      );
    }
    process.stderr.write(`version mismatch; retrying at 0x${offered.toString(16)}\n`);
    version = offered;
  }
  throw new Error("join ended without a seat");
}

export function readConfig(env = process.env) {
  const room = env.YGO_ROOM;
  return {
    host: env.YGO_HOST || DEFAULT_HOST,
    port: readPort(env.YGO_PORT, DEFAULT_PORT),
    name: env.YGO_NAME || DEFAULT_NAME,
    room: room ? room : `yb${randomBytes(4).toString("hex")}`,
    version: readVersion(env.YGO_VERSION, CLIENT_VERSION),
  };
}

async function openSeat(options) {
  const socket = await connect(options.host, options.port, options.timeoutMs);
  const messages = [];
  try {
    socket.write(
      Buffer.concat([
        encodePlayerInfo(options.name),
        encodeJoinGame(options.version, options.room),
      ]),
    );
    const decision = await readLobby(socket, messages, options.timeoutMs);
    if (decision.stop === "version") {
      return { versionMismatch: decision.version, messages };
    }
    if (decision.stop === "error") {
      throw new Error(`join rejected: ${decision.error}`);
    }
    if (decision.stop !== "joined") {
      const seen = messages.map((message) => describeMessage(message).type).join(",") || "none";
      throw new Error(`no STOC_JOIN_GAME before ${decision.stop}; saw ${seen}`);
    }
    return {
      host: options.host,
      port: options.port,
      name: options.name,
      room: options.room,
      version: options.version,
      messages,
    };
  } finally {
    await release(socket);
  }
}

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`connect timeout ${host}:${port}`));
    }, timeoutMs);
    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    socket.once("connect", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.on("error", () => { });
      resolve(socket);
    });
    socket.once("error", (error) => {
      fail(error);
    });
  });
}

function readLobby(socket, messages, timeoutMs) {
  const framer = new PacketFramer();
  return new Promise((resolve, reject) => {
    let settled = false;
    let joined = false;
    let timer = setTimeout(() => finish(() => resolve({ stop: "timeout" })), timeoutMs);

    function armIdle() {
      clearTimeout(timer);
      timer = setTimeout(() => finish(() => resolve({ stop: "joined" })), 1500);
    }

    function finish(settle) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      settle();
    }

    function onData(chunk) {
      let packets;
      try {
        packets = framer.push(chunk);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      let stop = null;
      for (const packet of packets) {
        let message;
        try {
          message = parseServerPacket(packet);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        messages.push(message);
        if (stop || joined) {
          if (joined) {
            armIdle();
          }
          continue;
        }
        const mismatch = rejectedVersion(message);
        if (mismatch !== null) {
          stop = { stop: "version", version: mismatch };
          continue;
        }
        const failed = joinFailure(message);
        if (failed) {
          stop = { stop: "error", error: failed };
          continue;
        }
        if (message instanceof YGOProStocJoinGame) {
          joined = true;
          armIdle();
        }
      }
      if (stop) {
        finish(() => resolve(stop));
      }
    }

    function onClose() {
      finish(() => resolve({ stop: joined ? "joined" : "closed" }));
    }

    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

function release(socket) {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 1000);
    try {
      socket.write(encodeLeaveGame(), () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
    } catch {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    }
  });
}

function readPort(raw, fallback) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("YGO_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function readVersion(raw, fallback) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const version = raw.startsWith("0x") || raw.startsWith("0X")
    ? Number.parseInt(raw, 16)
    : Number(raw);
  if (!Number.isInteger(version) || version < 0 || version > 0xffff) {
    throw new Error("YGO_VERSION must fit in uint16");
  }
  return version;
}

function report(seat) {
  return {
    host: seat.host,
    port: seat.port,
    room: seat.room,
    name: seat.name,
    version: `0x${seat.version.toString(16)}`,
    messages: seat.messages.map(describeMessage),
  };
}

async function main() {
  const config = readConfig();
  const seat = await joinRoom(config);
  process.stdout.write(`${JSON.stringify(report(seat), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
