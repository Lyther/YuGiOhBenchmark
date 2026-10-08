import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import packageJson from "../../package.json" with { type: "json" };
import { loadCatalog } from "../cards/catalog.js";
import { readConfig } from "../config.js";
import { emptyDeck, parseDeck } from "../deck/deck.js";
import { createLogger } from "../log.js";
import { serveSeat } from "../mcp/server.js";
import { seatTools } from "../mcp/tools.js";
import { openConnection } from "../net/connection.js";
import { createSeat } from "../seat/controller.js";
import { createRecorder } from "../seat/record.js";

async function loadDeck(path) {
  if (!path) return emptyDeck();
  return parseDeck(await readFile(path, "utf8"));
}

// Startup order (architecture Runtime View): config, card data, deck, then
// MCP over stdio. No socket opens until the first deck submit.
async function main() {
  let log;
  try {
    const config = readConfig(process.env, { roomRequired: true });
    log = createLogger(config.logLevel);
    const catalog = await loadCatalog(config.cardsDir, { log });
    const deck = await loadDeck(config.deck);
    const record = createRecorder({ runDir: config.runDir, room: config.room, name: config.name, capture: config.capture, log });
    const seat = createSeat({ config, catalog, deck, record, connect: openConnection, log });
    const handle = serveSeat({ tools: seatTools({ seat, catalog, log }), log, version: packageJson.version });
    let stopping = false;
    const stop = async (why) => {
      if (stopping) return;
      stopping = true;
      log.info({ why }, "seat stopping");
      await seat.close(why);
      await handle.close();
      process.exit(0);
    };
    process.stdin.once("end", () => stop("stdin closed"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    log.info({ room: config.room, name: config.name, cards: catalog.size }, "seat ready");
  } catch (error) {
    if (log) log.fatal({ err: error }, "seat failed to start");
    else process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
