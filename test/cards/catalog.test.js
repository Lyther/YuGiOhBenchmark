import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import initSqlJs from "sql.js";
import { CardDataEntry, YGOProCdb } from "ygopro-cdb-encode";

import { loadCatalog } from "../../src/cards/catalog.js";

const fixture = JSON.parse(await readFile(new URL("../fixtures/cards.json", import.meta.url), "utf8"));
const SQL = await initSqlJs();

function rows() {
  const texts = new Map(fixture.texts.map((text) => [text.id, text]));
  return fixture.datas.map((data) => ({ ...data, ...texts.get(data.id) }));
}

async function writeSet(dir, source, cdbFiles, stringsFile, strings) {
  await mkdir(join(dir, source), { recursive: true });
  for (const [file, entries] of Object.entries(cdbFiles)) {
    const cdb = new YGOProCdb(SQL);
    cdb.addCard(entries.map((row) => new CardDataEntry().fromSqljsRow(row)));
    await writeFile(join(dir, source, file), cdb.export());
    cdb.finalize();
  }
  await writeFile(join(dir, source, stringsFile), strings.join("\n"));
}

async function englishOnly(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeSet(dir, "en-US", { "cards.cdb": rows() }, "strings.conf", fixture.strings);
  return dir;
}

test("monster, spell and trap rows become cards with English vocabulary", async (t) => {
  const catalog = await loadCatalog(await englishOnly(t));
  const { text, strings, ...blueEyes } = catalog.card(89631139);
  assert.deepEqual(blueEyes, {
    code: 89631139, alias: 0, name: "Blue-Eyes White Dragon", kind: "monster", types: ["normal"],
    attribute: "Light", race: "Dragon", level: 8, atk: 3000, def: 2500, setnames: ["Blue-Eyes"], source: "en-US",
  });
  assert.match(text, /legendary dragon/i);
  assert.equal(strings.length, 16);
  assert.equal(catalog.card(1861629).strings[0], "Stop that activation and destroy it");
  const decode = catalog.card(1861629);
  assert.equal(decode.link, 3);
  assert.deepEqual(decode.linkMarkers, ["bottom-left", "bottom-right", "top"]);
  assert.equal(decode.def, undefined, "a Link monster has no DEF");
  assert.equal(decode.level, undefined);
  assert.deepEqual(decode.types, ["effect", "link"]);
  const utopia = catalog.card(84013237);
  assert.equal(utopia.rank, 4);
  assert.equal(utopia.level, undefined);
  assert.deepEqual(utopia.setnames, ["Number", "Utopia"]);
  const oddEyes = catalog.card(16178681);
  assert.equal(oddEyes.level, 7);
  assert.deepEqual(oddEyes.scales, { left: 4, right: 4 });
  assert.deepEqual(oddEyes.types, ["effect", "pendulum"]);
  assert.deepEqual(catalog.card(14558127).types, ["effect", "tuner"]);
  assert.deepEqual(catalog.card(44508094).types, ["effect", "synchro"]);
  assert.equal(catalog.card(10000).atk, -2, "unknown ATK keeps the CDB value -2");
  assert.equal(catalog.card(55144522).kind, "spell");
  assert.equal(catalog.card(44095762).kind, "trap");
  assert.equal(catalog.card(89631140).alias, 89631139, "alternate art keeps its alias");
  assert.equal(catalog.card(123), null);
  assert.equal(catalog.isExtraDeck(44508094), true);
  assert.equal(catalog.isExtraDeck(1861629), true);
  assert.equal(catalog.isExtraDeck(16178681), false, "a main-deck Pendulum stays in main");
});

test("names resolve exactly, then by a unique prefix, else return suggestions", async (t) => {
  const catalog = await loadCatalog(await englishOnly(t));
  assert.equal(catalog.findByName("blue-eyes WHITE dragon").card.code, 89631139, "the original artwork wins");
  assert.equal(catalog.findByName("Decode").card.code, 1861629);
  const ambiguous = catalog.findByName("Pot of");
  assert.equal(ambiguous.card, undefined);
  assert.deepEqual(ambiguous.suggestions, ["Pot of Desires", "Pot of Greed"]);
  const contains = catalog.findByName("magician");
  assert.equal(contains.card, undefined);
  assert.deepEqual(contains.suggestions, ["Dark Magician"]);
  assert.deepEqual(catalog.findByName("zzz").suggestions, []);
});

test("search filters, orders by name then code, and pages without losing the total", async (t) => {
  const catalog = await loadCatalog(await englishOnly(t));
  const names = (result) => result.cards.map((card) => card.name);
  assert.deepEqual(names(catalog.search({ kind: "spell" })), ["Pot of Desires", "Pot of Greed"]);
  assert.deepEqual(names(catalog.search({ types: ["synchro"] })), ["Stardust Dragon"]);
  assert.deepEqual(names(catalog.search({ setname: "hero" })), ["Elemental HERO Stratos"], "archetype membership by base code");
  assert.deepEqual(names(catalog.search({ atkMin: 3000 })), ["Blue-Eyes White Dragon", "Blue-Eyes White Dragon"]);
  assert.deepEqual(catalog.search({ atkMin: 3000 }).cards.map((card) => card.code), [89631139, 89631140]);
  assert.deepEqual(names(catalog.search({ text: "special summons", race: "insect" })), ['Maxx "C"']);
  assert.deepEqual(names(catalog.search({ attribute: "Dark", levelMin: 7, kind: "monster" })),
    ["Dark Magician", "Odd-Eyes Pendulum Dragon", "Ten Thousand Dragon"]);
  const page = catalog.search({ kind: "monster", limit: 2, offset: 3 });
  assert.equal(page.total, 12);
  assert.equal(page.offset, 3);
  assert.deepEqual(names(page), ["Dark Magician", "Decode Talker"]);
  assert.deepEqual(Object.keys(page.cards[0]).sort(), ["atk", "attribute", "code", "def", "kind", "level", "name", "race", "types"]);
});

test("descriptions resolve system strings and per-card effect strings", async (t) => {
  const catalog = await loadCatalog(await englishOnly(t));
  assert.equal(catalog.desc(95), "Use the effect of [%ls]?");
  assert.equal(catalog.desc((1861629 << 4) | 0), "Stop that activation and destroy it");
  assert.equal(catalog.desc((55144522 << 4) | 3), null, "an empty card string is unknown");
  assert.equal(catalog.desc((123 << 4) | 1), null);
  assert.equal(catalog.victoryReason(1), "LP reached 0");
  assert.equal(catalog.counterName(1), "Spell Counter");
  assert.equal(catalog.attributeName(0x20), "Dark");
  assert.equal(catalog.raceName(0x1000000), "Cyberse");
});

test("layers merge zh-CN < super-pre < super-pre-en < en-US and name their source", async (t) => {
  const dir = await englishOnly(t);
  const [blueEyes] = rows().filter((row) => row.id === 89631139);
  const chinese = { ...blueEyes, name: "青眼白龙" };
  const chineseOnly = { ...blueEyes, id: 99999001, name: "仅中文卡" };
  const preRelease = { ...blueEyes, id: 100000001, name: "超先行卡" };
  const preReleaseCn = { ...blueEyes, id: 100000002, name: "只有中文的先行卡" };
  await writeSet(dir, "zh-CN", { "cards.cdb": [chinese, chineseOnly] }, "strings.conf", ["!setname 0x9999 只在中文"]);
  await writeSet(dir, "super-pre", { "test-release.cdb": [preRelease, preReleaseCn], "test-update.cdb": [] },
    "test-strings.conf", []);
  await writeSet(dir, "super-pre-en", { "test-release.cdb": [{ ...preRelease, name: "Pre-release Card" }] },
    "test-strings.conf", []);
  const catalog = await loadCatalog(dir);
  assert.equal(catalog.card(89631139).name, "Blue-Eyes White Dragon");
  assert.equal(catalog.card(100000001).name, "Pre-release Card");
  assert.equal(catalog.card(100000001).source, "super-pre-en");
  assert.equal(catalog.info(100000001).sourceNote, "community translation of a pre-release card");
  assert.equal(catalog.card(100000002).source, "super-pre");
  assert.equal(catalog.info(100000002).sourceNote, "Chinese text: no English available yet");
  assert.equal(catalog.card(99999001).source, "zh-CN");
  assert.equal(catalog.info(89631139).sourceNote, undefined);
  assert.equal(catalog.info(89631139).strings, undefined, "card info omits raw strings");
  assert.equal(catalog.setName(0x9999), "只在中文");
  assert.deepEqual(catalog.counts, { "zh-CN": 1, "super-pre": 1, "super-pre-en": 1, "en-US": 15 });
  assert.equal(catalog.size, 18);
});

test("a missing en-US set stops loading and names the refresh command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ygo-catalog-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(loadCatalog(dir), /en-US.*npm run cards/);
});

test("an en-US database without strings.conf cannot silently lose prompt text", async (t) => {
  const dir = await englishOnly(t);
  await rm(join(dir, "en-US/strings.conf"));
  await assert.rejects(loadCatalog(dir), /strings\.conf.*npm run cards/);
});

test("a first-edition pack overrides effect text and strings of its cards but keeps English names", async (t) => {
  const { zipSync } = await import("fflate");
  const dir = await englishOnly(t);
  const [blueEyes] = rows().filter((row) => row.id === 89631139);
  const firstText = "------------------------------\r\n原始文本\r\n------------------------------\r\n第一版效果";
  const cdb = new YGOProCdb(SQL);
  cdb.addCard([new CardDataEntry().fromSqljsRow({ ...blueEyes, ot: 11, name: "青眼白龙", desc: firstText, str1: "卡组检索" })]);
  await mkdir(join(dir, "first-edition"));
  await writeFile(join(dir, "first-edition/pack.ypk"), zipSync({ "2012.cdb": cdb.export(), "script/c89631139.lua": new Uint8Array([45, 45]) }));
  cdb.finalize();
  await writeFile(join(dir, "first-edition/broken.ypk"), "not a zip archive");
  const warnings = [];
  const catalog = await loadCatalog(dir, { log: { warn: (fields, message) => warnings.push([fields.pack, message]) } });
  const card = catalog.card(89631139);
  assert.equal(card.name, "Blue-Eyes White Dragon");
  assert.equal(card.text, firstText);
  assert.equal(card.strings[0], "卡组检索");
  assert.equal(card.source, "first-edition");
  assert.equal(card.atk, 3000);
  assert.match(catalog.info(89631139).sourceNote, /first-edition/);
  assert.equal(catalog.desc(89631139 * 16), "卡组检索");
  assert.equal(catalog.card(89631140).source, "en-US", "only the pack's own codes change");
  assert.deepEqual(catalog.counts, { "en-US": 14, "first-edition": 1 });
  assert.equal(catalog.size, 15);
  assert.deepEqual(warnings.filter(([pack]) => pack), [["broken.ypk", "card data pack unreadable; skipped"]]);
});
