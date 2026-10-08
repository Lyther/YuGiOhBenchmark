import { pathToFileURL } from "node:url";

import {
  ErrorMessageType,
  YGOProStocChat,
  YGOProStocErrorMsg,
  YGOProStocHsPlayerChange,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocTypeChange,
} from "ygopro-msg-encode";

import { readConfig } from "../config.js";
import { createLogger } from "../log.js";
import { openConnection } from "../net/connection.js";
import {
  encodeJoinGame, encodeLeaveGame, encodePlayerInfo, joinFailure, rejectedVersion,
} from "../protocol/packets.js";

export async function joinRoom(options, log = createLogger(options.logLevel)) {
  let version = options.version;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await readLobby({ ...options, version }, log);
    if (outcome.versionMismatch === undefined) return outcome;
    const offered = outcome.versionMismatch;
    if (offered === version || attempt === 1) {
      throw new Error(`server rejected client version 0x${version.toString(16)}; offered 0x${offered.toString(16)}`);
    }
    log.info({ version, offered }, "version mismatch; reconnecting once");
    version = offered;
  }
}

async function readLobby(options, log) {
  const messages = [];
  let connection;
  let timer;
  let joined = false;
  let settled = false;
  let finish;
  const decision = new Promise((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
  });
  try {
    connection = await openConnection({
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs,
      onMessage({ message }) {
        messages.push(message);
        if (settled) return;
        const mismatch = rejectedVersion(message);
        if (mismatch !== null) return finish({ versionMismatch: mismatch });
        const error = joinFailure(message);
        if (error) return finish({ error: `join rejected: ${error}` });
        if (message instanceof YGOProStocJoinGame) joined = true;
        if (joined) {
          clearTimeout(timer);
          timer = setTimeout(() => finish({ joined: true }), 1500);
        }
      },
      onError(error, packet) {
        log.error({ err: error, id: packet[2] }, "unreadable server packet");
        messages.push({ kind: "unreadable", id: packet[2], error: error.message });
      },
      onClose({ reason, error }) {
        finish(error ? { error: error.message } : joined ? { joined: true } : { error: `no STOC_JOIN_GAME before ${reason}` });
      },
    });
    connection.send(Buffer.concat([
      encodePlayerInfo(options.name), encodeJoinGame(options.version, options.room),
    ]));
    timer = setTimeout(() => finish({ error: "no STOC_JOIN_GAME before timeout" }), options.timeoutMs ?? 8000);
    const outcome = await decision;
    if (outcome.error) throw new Error(outcome.error);
    if (outcome.versionMismatch !== undefined) return outcome;
    return { host: options.host, port: options.port, name: options.name, room: options.room, version: options.version, messages };
  } finally {
    clearTimeout(timer);
    if (connection) {
      if (!connection.closed) connection.send(encodeLeaveGame());
      await connection.close();
    }
  }
}

export function describeMessage(message) {
  if (message instanceof YGOProStocJoinGame) {
    const info = message.info;
    return {
      type: "join", lflist: info.lflist, rule: info.rule, mode: info.mode,
      duelRule: info.duel_rule, noCheckDeck: info.no_check_deck,
      noShuffleDeck: info.no_shuffle_deck, startLp: info.start_lp,
      startHand: info.start_hand, drawCount: info.draw_count, timeLimit: info.time_limit,
    };
  }
  if (message instanceof YGOProStocTypeChange) {
    return { type: "type", position: message.playerPosition, host: message.isHost };
  }
  if (message instanceof YGOProStocHsPlayerEnter) {
    return { type: "enter", name: message.name, position: message.pos };
  }
  if (message instanceof YGOProStocHsPlayerChange) {
    return { type: "player", position: message.playerPosition, state: message.playerState };
  }
  if (message instanceof YGOProStocErrorMsg) {
    return { type: "error", msg: ErrorMessageType[message.msg] ?? message.msg, code: message.code };
  }
  if (message instanceof YGOProStocChat) {
    return { type: "chat", playerType: message.player_type, message: message.msg };
  }
  if (message?.kind) return { ...message, type: message.kind };
  return { type: message?.constructor?.name ?? "unparsed" };
}

async function main() {
  let log;
  try {
    const config = readConfig();
    log = createLogger(config.logLevel);
    const result = await joinRoom(config, log);
    process.stdout.write(`${JSON.stringify({
      ...result, version: `0x${result.version.toString(16)}`, messages: result.messages.map(describeMessage),
    }, null, 2)}\n`);
  } catch (error) {
    if (log) log.error({ err: error }, "probe failed");
    else process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
