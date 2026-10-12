import pino from "pino";

// stderr by default: stdout carries the MCP stream.
export function createLogger(level = "info", dest = 2) {
  return pino({ level }, pino.destination({ dest, sync: true }));
}
