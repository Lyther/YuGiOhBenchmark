import { randomBytes } from "node:crypto";

import { CLIENT_VERSION } from "./protocol/packets.js";

export function readConfig(env = process.env, { roomRequired = false } = {}) {
  const room = env.YGO_ROOM || (roomRequired ? "" : `M,TM0,NF#yb${randomBytes(4).toString("hex")}`);
  return Object.freeze({
    host: env.YGO_HOST || "koishi.momobako.com",
    port: integer(env.YGO_PORT, "YGO_PORT", 2339, 1, 65535),
    name: fixedText(env.YGO_NAME || `ygobench-${randomBytes(2).toString("hex")}`, "YGO_NAME"),
    room: fixedText(room, "YGO_ROOM"),
    version: integer(env.YGO_VERSION, "YGO_VERSION", CLIENT_VERSION, 0, 65535, true),
    deck: env.YGO_DECK || null,
    runDir: env.YGO_RUN_DIR || "./runs",
    cardsDir: env.YGO_CARDS_DIR || "./data/cards",
    waitMs: integer(env.YGO_WAIT_MS, "YGO_WAIT_MS", 240000, 1000, 1500000),
    capture: flag(env.YGO_CAPTURE),
    logLevel: logLevel(env.YGO_LOG_LEVEL || "info"),
  });
}

function integer(raw, name, fallback, min, max, hex = false) {
  if (raw === undefined || raw === "") return fallback;
  const pattern = hex ? /^(?:[0-9]+|0x[0-9a-f]+)$/i : /^[0-9]+$/;
  const value = Number(raw);
  if (!pattern.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}${hex ? " (hex or decimal)" : ""}`);
  }
  return value;
}

function fixedText(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 19 || value.includes("\0")) {
    throw new Error(`${name} must be 1..19 UTF-16 units without NUL`);
  }
  return value;
}

function flag(raw) {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("YGO_CAPTURE must be 0 or 1");
}

function logLevel(value) {
  if (!["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(value)) {
    throw new Error("YGO_LOG_LEVEL must be a pino level");
  }
  return value;
}
