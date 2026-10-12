import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { CardDataEntry, YGOProCdb } from "ygopro-cdb-encode";

import { loadCatalog } from "../../src/cards/catalog.js";

// SUBSTITUTE_JUSTIFICATION
// - substitute: cards.json, through writeFixtureCards/fixtureCatalog and the
//   rows catalog.test.js writes itself.
// - replaces: the downloaded card pool and its text (codes/stats are retained;
//   effect text is authored test text, not a claim about an actual card).
// - necessity: catalog.test.js checks prefix and ambiguity resolution, search
//   totals, layer merges, missing or corrupt sources and first-edition packs,
//   and deck.test.js an ambiguous edit: each needs a row set or a failure that
//   the live data cannot be made to hold. The game, seat, view and render tests
//   check the exact model-facing text built from names and effect strings,
//   which needs those strings fixed. The real CDB writer and loader run.
// - proof-limit: no qualification of live card text, pool support or gameplay.
// - real-proof: npm run spec loads the downloaded catalog (entry point, tools,
//   lookups, deck edits); npm run smoke and the 2026-10-12 agent match play it.
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
