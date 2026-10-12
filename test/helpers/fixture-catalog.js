import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { CardDataEntry, YGOProCdb } from "ygopro-cdb-encode";

import { loadCatalog } from "../../src/cards/catalog.js";

// SUBSTITUTE_JUSTIFICATION
// - substitute: cards.json via writeFixtureCards/fixtureCatalog; used by the
//   catalog, deck, game, controller, view, render and MCP tool diagnostics.
// - replaces: the downloaded card pool and its text (codes/stats are retained;
//   effect text is authored test text, not a claim about an actual card).
// - necessity: exact ambiguity, precedence, missing-source and text-mapping
//   assertions require controlled rows; the live mutable sources cannot be
//   made to hold those rows or failure states. The real CDB writer/loader runs.
// - proof-limit: no qualification of live card text, pool support or gameplay.
// - real-proof: spec/seat-entry.test.js loads the downloaded catalog; npm run
//   smoke exercises a real deck; full gameplay remains P1.11/P2.2.
export async function writeFixtureCards(dir) {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/cards.json", import.meta.url), "utf8"));
  const texts = new Map(fixture.texts.map((text) => [text.id, text]));
  const SQL = await initSqlJs();
  const cdb = new YGOProCdb(SQL);
  try {
    cdb.addCard(fixture.datas.map((data) => new CardDataEntry().fromSqljsRow({ ...data, ...texts.get(data.id) })));
    await mkdir(join(dir, "en-US"), { recursive: true });
    await writeFile(join(dir, "en-US/cards.cdb"), cdb.export());
    await writeFile(join(dir, "en-US/strings.conf"), fixture.strings.join("\n"));
  } finally {
    cdb.finalize();
  }
}

// The fixture card set read through the real loader.
export async function fixtureCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "ygo-fixture-cards-"));
  try {
    await writeFixtureCards(dir);
    return await loadCatalog(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
