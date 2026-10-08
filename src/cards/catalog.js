import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { unzipSync } from "fflate";
import initSqlJs from "sql.js";
import { YGOProCdb } from "ygopro-cdb-encode";
import { OcgcoreCommonConstants as C } from "ygopro-msg-encode";

import { mergeStrings, parseStringsConf } from "./strings-conf.js";

// Lowest priority first: a later layer replaces an earlier one code by code.
const LAYERS = Object.freeze([
  { source: "zh-CN", cdbs: ["cards.cdb"], strings: "strings.conf" },
  { source: "super-pre", cdbs: ["test-release.cdb", "test-update.cdb"], strings: "test-strings.conf" },
  { source: "super-pre-en", cdbs: ["test-release.cdb"], strings: "test-strings.conf" },
  { source: "en-US", cdbs: ["cards.cdb"], strings: "strings.conf", required: true },
]);

// YGOPro DataManager: descriptions up to 0x7ff are system strings, and the
// attribute and race names are system strings 1010+bit and 1020+bit.
const MAX_SYSTEM_STRING = 0x7ff;
const ATTRIBUTE_STRING = 1010;
const RACE_STRING = 1020;
const CARD_STRINGS = 16;
const SETCODE_BASE = 0xfff;

const TYPE_WORDS = [
  [C.TYPE_NORMAL, "normal"], [C.TYPE_EFFECT, "effect"], [C.TYPE_FUSION, "fusion"], [C.TYPE_RITUAL, "ritual"],
  [C.TYPE_SYNCHRO, "synchro"], [C.TYPE_XYZ, "xyz"], [C.TYPE_PENDULUM, "pendulum"], [C.TYPE_LINK, "link"],
  [C.TYPE_TUNER, "tuner"], [C.TYPE_SPIRIT, "spirit"], [C.TYPE_UNION, "union"], [C.TYPE_DUAL, "gemini"],
  [C.TYPE_FLIP, "flip"], [C.TYPE_TOON, "toon"], [C.TYPE_TOKEN, "token"], [C.TYPE_QUICKPLAY, "quick-play"],
  [C.TYPE_CONTINUOUS, "continuous"], [C.TYPE_EQUIP, "equip"], [C.TYPE_FIELD, "field"], [C.TYPE_COUNTER, "counter"],
];
export const TYPE_VOCABULARY = Object.freeze(TYPE_WORDS.map(([, word]) => word));

const LINK_MARKERS = [
  [C.LINK_MARKER_BOTTOM_LEFT, "bottom-left"], [C.LINK_MARKER_BOTTOM, "bottom"],
  [C.LINK_MARKER_BOTTOM_RIGHT, "bottom-right"], [C.LINK_MARKER_LEFT, "left"], [C.LINK_MARKER_RIGHT, "right"],
  [C.LINK_MARKER_TOP_LEFT, "top-left"], [C.LINK_MARKER_TOP, "top"], [C.LINK_MARKER_TOP_RIGHT, "top-right"],
];
const EXTRA_DECK_TYPES = C.TYPE_FUSION | C.TYPE_SYNCHRO | C.TYPE_XYZ | C.TYPE_LINK;
// Optional operator-supplied .ypk packs whose CDBs replace the effect text of
// their cards, such as first-edition effects the server plays instead of errata.
const PACK_DIR = "first-edition";
const PACK_SOURCE = "first-edition";
const SOURCE_NOTES = Object.freeze({
  [PACK_SOURCE]: "first-edition effect pack (data/cards/first-edition): the original text, in Chinese, before the current errata",
  "super-pre-en": "community translation of a pre-release card",
  "super-pre": "Chinese text: no English available yet",
  "zh-CN": "Chinese text: no English available yet",
});

export async function loadCatalog(dir, { log } = {}) {
  const SQL = await initSqlJs();
  const layers = [];
  for (const layer of LAYERS) {
    let loaded;
    try {
      loaded = await readLayer(SQL, join(dir, layer.source), layer);
    } catch (error) {
      // Only en-US is required; a broken optional source must not stop the seat.
      if (layer.required) throw error;
      log?.warn({ source: layer.source, err: error }, "card data source unreadable; skipped");
      continue;
    }
    if (loaded) {
      layers.push(loaded);
    } else if (layer.required) {
      throw new Error(`card data missing: ${join(dir, layer.source, layer.cdbs[0])} (en-US); run npm run cards`);
    } else {
      log?.warn({ source: layer.source }, "card data source missing; skipped");
    }
  }
  return new Catalog(layers, await readPacks(SQL, join(dir, PACK_DIR), log));
}

function readCdb(SQL, bytes) {
  const cdb = new YGOProCdb(SQL).from(new Uint8Array(bytes));
  try {
    return cdb.find();
  } finally {
    cdb.finalize();
  }
}

async function readLayer(SQL, dir, layer) {
  const entries = [];
  for (const [index, file] of layer.cdbs.entries()) {
    const bytes = await readFile(join(dir, file)).catch(() => null);
    if (!bytes) {
      if (index === 0) return null;
      continue;
    }
    try {
      entries.push(...readCdb(SQL, bytes));
    } catch (error) {
      throw new Error(`card data unreadable: ${join(dir, file)} (${layer.source}); run npm run cards`, { cause: error });
    }
  }
  const text = await readFile(join(dir, layer.strings), "utf8").catch((error) => {
    if (layer.required) throw new Error(`card data unavailable: ${join(dir, layer.strings)}; run npm run cards`, { cause: error });
    return "";
  });
  return { source: layer.source, entries, strings: parseStringsConf(text) };
}

async function readPacks(SQL, dir, log) {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.toLowerCase().endsWith(".ypk")).sort();
  const entries = [];
  for (const name of names) {
    try {
      const files = unzipSync(new Uint8Array(await readFile(join(dir, name))), { filter: (file) => file.name.toLowerCase().endsWith(".cdb") });
      for (const bytes of Object.values(files)) entries.push(...readCdb(SQL, bytes));
    } catch (error) {
      log?.warn({ err: error, pack: name }, "card data pack unreadable; skipped");
    }
  }
  return entries;
}

function words(bits, table) {
  return table.filter(([bit]) => bits & bit).map(([, word]) => word);
}

function bitNames(bits, base, strings) {
  const names = [];
  for (let index = 0; index < 32; index += 1) {
    if (bits & (2 ** index)) names.push(strings.system.get(base + index) ?? `#${2 ** index}`);
  }
  return names.length ? names.join("|") : undefined;
}

function kindOf(type) {
  if (type & C.TYPE_MONSTER) return "monster";
  return type & C.TYPE_SPELL ? "spell" : "trap";
}

function monsterFields(entry, strings) {
  const fields = {
    attribute: bitNames(entry.attribute, ATTRIBUTE_STRING, strings),
    race: bitNames(entry.race, RACE_STRING, strings),
    atk: entry.attack,
  };
  if (entry.type & C.TYPE_LINK) {
    fields.link = entry.level;
    fields.linkMarkers = words(entry.linkMarker, LINK_MARKERS);
  } else {
    fields[entry.type & C.TYPE_XYZ ? "rank" : "level"] = entry.level;
    fields.def = entry.defense;
  }
  if (entry.type & C.TYPE_PENDULUM) fields.scales = { left: entry.lscale, right: entry.rscale };
  return fields;
}

function toCard(entry, source, strings) {
  return {
    code: entry.code,
    alias: entry.alias,
    name: entry.name ?? "",
    text: entry.desc ?? "",
    kind: kindOf(entry.type),
    types: words(entry.type, TYPE_WORDS),
    ...(entry.type & C.TYPE_MONSTER ? monsterFields(entry, strings) : {}),
    setnames: entry.setcode.map((code) => strings.setname.get(code)).filter(Boolean),
    strings: Array.from({ length: CARD_STRINGS }, (_, index) => entry.strings?.[index] ?? ""),
    source,
  };
}

function isSetCard(setcodes, value) {
  return setcodes.some((code) => (code & SETCODE_BASE) === (value & SETCODE_BASE) && (code & value) === value);
}

function stars(card) {
  return card.level ?? card.rank ?? card.link;
}

class Catalog {
  constructor(layers, packEntries = []) {
    this.strings = mergeStrings(layers.map((layer) => layer.strings));
    const chosen = new Map();
    for (const layer of layers) {
      for (const entry of layer.entries) chosen.set(entry.code, { entry, source: layer.source });
    }
    this.cards = new Map();
    this.meta = new Map();
    for (const [code, { entry, source }] of chosen) {
      this.cards.set(code, toCard(entry, source, this.strings));
      this.meta.set(code, { type: entry.type, setcodes: entry.setcode });
    }
    for (const entry of packEntries) this.#applyPack(entry);
    this.sorted = [...this.cards.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.code - b.code);
    this.counts = Object.fromEntries([...layers.map((layer) => [layer.source, 0]), ...(packEntries.length ? [[PACK_SOURCE, 0]] : [])]);
    for (const card of this.cards.values()) this.counts[card.source] += 1;
    Object.freeze(this);
  }

  // A pack replaces the text and non-empty effect strings; name and stats stay.
  #applyPack(entry) {
    const card = this.cards.get(entry.code);
    if (!card) {
      this.cards.set(entry.code, toCard(entry, PACK_SOURCE, this.strings));
      this.meta.set(entry.code, { type: entry.type, setcodes: entry.setcode });
      return;
    }
    card.text = entry.desc || card.text;
    card.strings = card.strings.map((text, index) => entry.strings?.[index] || text);
    card.source = PACK_SOURCE;
  }

  get size() {
    return this.cards.size;
  }

  card(code) {
    return this.cards.get(code) ?? null;
  }

  info(code) {
    const card = this.card(code);
    if (!card) return null;
    const { strings, source, ...info } = card;
    return SOURCE_NOTES[source] ? { ...info, sourceNote: SOURCE_NOTES[source] } : info;
  }

  brief(card) {
    const keys = ["code", "name", "kind", "types", "attribute", "race", "level", "rank", "link", "atk", "def"];
    return Object.fromEntries(keys.filter((key) => card[key] !== undefined).map((key) => [key, card[key]]));
  }

  isExtraDeck(code) {
    return ((this.meta.get(code)?.type ?? 0) & EXTRA_DECK_TYPES) !== 0;
  }

  findByName(name) {
    const key = name.trim().toLowerCase();
    const pick = (cards) => ({ card: cards.find((card) => card.alias === 0) ?? cards[0] });
    const exact = this.sorted.filter((card) => card.name.toLowerCase() === key);
    if (exact.length) return pick(exact);
    const prefixed = this.sorted.filter((card) => card.name.toLowerCase().startsWith(key));
    const prefixNames = [...new Set(prefixed.map((card) => card.name))];
    if (prefixNames.length === 1) return pick(prefixed);
    if (prefixNames.length > 1) return { suggestions: prefixNames.slice(0, 5) };
    const containing = this.sorted.filter((card) => card.name.toLowerCase().includes(key));
    return { suggestions: [...new Set(containing.map((card) => card.name))].slice(0, 5) };
  }

  search(filters = {}) {
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;
    const tests = this.#filterTests(filters);
    const matches = this.sorted.filter((card) => tests.every((test) => test(card)));
    return { total: matches.length, offset, cards: matches.slice(offset, offset + limit).map((card) => this.brief(card)) };
  }

  #filterTests(filters) {
    const lower = (value) => String(value).toLowerCase();
    const named = (value) => (field) => (card) => (card[field] ?? "").toLowerCase().split("|").includes(lower(value));
    const tests = [];
    if (filters.text) tests.push((card) => card.text.toLowerCase().includes(lower(filters.text)));
    if (filters.name) tests.push((card) => card.name.toLowerCase().includes(lower(filters.name)));
    if (filters.kind) tests.push((card) => card.kind === filters.kind);
    if (filters.types?.length) tests.push((card) => filters.types.every((type) => card.types.includes(type)));
    if (filters.attribute) tests.push(named(filters.attribute)("attribute"));
    if (filters.race) tests.push(named(filters.race)("race"));
    if (filters.setname) tests.push(this.#setnameTest(lower(filters.setname)));
    tests.push(...rangeTests(filters));
    return tests;
  }

  #setnameTest(name) {
    const values = [...this.strings.setname].filter(([, text]) => text.toLowerCase() === name).map(([code]) => code);
    return (card) => values.some((value) => isSetCard(this.meta.get(card.code).setcodes, value));
  }

  desc(value) {
    if (value <= MAX_SYSTEM_STRING) return this.strings.system.get(value) || null;
    const card = this.cards.get(Math.floor(value / 16) % 0x10000000);
    return card?.strings[value % 16] || null;
  }

  systemString(id) {
    return this.strings.system.get(id) ?? null;
  }

  victoryReason(code) {
    return this.strings.victory.get(code) ?? null;
  }

  counterName(code) {
    return this.strings.counter.get(code) ?? null;
  }

  setName(code) {
    return this.strings.setname.get(code) ?? null;
  }

  attributeName(bits) {
    return bitNames(bits, ATTRIBUTE_STRING, this.strings) ?? null;
  }

  raceName(bits) {
    return bitNames(bits, RACE_STRING, this.strings) ?? null;
  }
}

function rangeTests(filters) {
  const tests = [];
  const between = (read, min, max) => (card) => {
    const value = read(card);
    return value !== undefined && value >= 0 && (min === undefined || value >= min) && (max === undefined || value <= max);
  };
  if (filters.level !== undefined) tests.push(between(stars, filters.level, filters.level));
  if (filters.levelMin !== undefined || filters.levelMax !== undefined) tests.push(between(stars, filters.levelMin, filters.levelMax));
  if (filters.atkMin !== undefined || filters.atkMax !== undefined) tests.push(between((card) => card.atk, filters.atkMin, filters.atkMax));
  if (filters.defMin !== undefined || filters.defMax !== undefined) tests.push(between((card) => card.def, filters.defMin, filters.defMax));
  return tests;
}
