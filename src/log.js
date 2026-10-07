import pino from "pino";

export function createLogger(level = "info") {
  return pino({ level }, pino.destination({ dest: 2, sync: true }));
}
