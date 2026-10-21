import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "../cards/catalog.js";
import { refreshCards } from "../cards/sources.js";
import { readConfig } from "../config.js";
import { createLogger } from "../log.js";

function describe(result) {
  if (result.status === "failed") return `${result.name}: failed (${result.error}); previous files kept`;
  const files = result.files.map(({ file, bytes }) => `${file} ${bytes} bytes`).join(", ");
  return `${result.name}: ${result.status} (${files})`;
}

async function main() {
  let log;
  try {
    const config = readConfig();
    log = createLogger(config.logLevel);
    const results = await refreshCards(config.cardsDir, { log });
    for (const result of results) process.stdout.write(`${describe(result)}\n`);
    const catalog = await loadCatalog(config.cardsDir, { log });
    const counts = Object.entries(catalog.counts).map(([name, count]) => `${name} ${count}`).join(", ");
    process.stdout.write(`catalog: ${catalog.size} cards (${counts})\n`);
    if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  } catch (error) {
    if (log) log.error({ err: error }, "card refresh failed");
    else process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

// argv[1] keeps any symlink in the launch path; import.meta.url is the real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
