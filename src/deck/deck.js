import YGOProDeck from "ygopro-deck-encode";

const MAX_CARD_CODE = 2 ** 28;
const FORMATS = "YDK text, a ydke:// URL or a KoishiPro deck code";
// A KoishiPro deck code is unpadded or padded base64url.
const DECK_CODE = /^[A-Za-z0-9_-]+={0,2}$/;
const YDK_MARKER = /^\s*(?:#main|#extra|!side)\s*$/m;

export function emptyDeck() {
  return { main: [], extra: [], side: [] };
}

function plain(deck) {
  const result = { main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
  for (const code of [...result.main, ...result.extra, ...result.side]) {
    if (!Number.isInteger(code) || code < 1 || code >= MAX_CARD_CODE) {
      throw new Error(`deck card code ${code} is not a positive integer below 2^28`);
    }
  }
  return result;
}

export function parseDeck(text) {
  const source = String(text).trim();
  if (/^ydke:\/\//i.test(source)) {
    try {
      return plain(YGOProDeck.fromYdkeURL(source));
    } catch (error) {
      throw new Error(`invalid ydke:// URL: ${error.message}`);
    }
  }
  if (YDK_MARKER.test(source)) return plain(YGOProDeck.fromYdkString(source));
  if (!DECK_CODE.test(source)) throw new Error(`deck import expects ${FORMATS}`);
  let decoded;
  try {
    decoded = YGOProDeck.fromEncodedString(source);
  } catch (error) {
    throw new Error(`invalid deck code: ${error.message}`);
  }
  return plain(decoded);
}

export function exportDeck(deck, format) {
  const encoded = new YGOProDeck(plain(deck));
  if (format === "ydk") return encoded.toYdkString();
  if (format === "ydke") return encoded.toYdkeURL();
  if (format === "code") return encoded.toEncodedString();
  throw new Error(`unknown deck format ${format}; use ydk, ydke or code`);
}

export function sectionFor(code, catalog) {
  return catalog.isExtraDeck(code) ? "extra" : "main";
}

// A deck edit that cannot apply; the whole call is rejected and nothing changes.
export class DeckEditError extends Error {}

const SECTIONS = ["main", "extra", "side"];
const MAX_COPIES = 60;

function resolveCard(card, catalog) {
  if (Number.isInteger(card)) {
    if (card < 1 || card >= MAX_CARD_CODE) throw new DeckEditError(`card code ${card} is not a positive integer below 2^28`);
    return card;
  }
  if (typeof card !== "string" || !card.trim()) throw new DeckEditError("card is a card code or a card name");
  const found = catalog.findByName(card);
  if (found.card) return found.card.code;
  const hint = found.suggestions.length ? `; did you mean: ${found.suggestions.join(", ")}` : "";
  throw new DeckEditError(`no single card named "${card}"${hint}`);
}

function copies(count) {
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_COPIES) throw new DeckEditError(`count ${count} must be 1..${MAX_COPIES}`);
  return value;
}

function section(name) {
  if (name !== undefined && !SECTIONS.includes(name)) throw new DeckEditError(`section ${name} must be main, extra or side`);
  return name;
}

// Removes `count` copies of `code`, newest first, from the named section or
// from the first section that holds enough of them.
function takeCopies(deck, code, count, from, catalog) {
  const name = catalog.card(code)?.name ?? `#${code}`;
  const parts = from ? [from] : SECTIONS;
  for (const part of parts) {
    if (deck[part].filter((entry) => entry === code).length >= count) {
      for (let removed = 0; removed < count; removed += 1) deck[part].splice(deck[part].lastIndexOf(code), 1);
      return;
    }
  }
  const held = parts.reduce((total, part) => total + deck[part].filter((entry) => entry === code).length, 0);
  const where = from ?? "the deck";
  throw new DeckEditError(held ? `only ${held} ${name} in ${where}` : `no ${name} in ${where}`);
}

function importDeck(text) {
  try {
    return parseDeck(text);
  } catch (error) {
    throw new DeckEditError(error.message);
  }
}

export function applyEdits(deck, edits, catalog) {
  const present = ["import", "clear", "remove", "add", "move"].filter((key) => {
    const value = edits[key];
    return value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
  });
  if (!present.length) throw new DeckEditError("nothing to do: give import, clear, remove, add or move");
  let next = plain(deck);
  if (edits.import !== undefined) next = importDeck(edits.import);
  if (edits.clear) next = emptyDeck();
  for (const edit of edits.remove ?? []) takeCopies(next, resolveCard(edit.card, catalog), copies(edit.count), section(edit.section), catalog);
  for (const edit of edits.add ?? []) {
    const code = resolveCard(edit.card, catalog);
    const target = section(edit.section) ?? sectionFor(code, catalog);
    for (let added = copies(edit.count); added > 0; added -= 1) next[target].push(code);
  }
  for (const edit of edits.move ?? []) {
    const code = resolveCard(edit.card, catalog);
    const count = copies(edit.count);
    takeCopies(next, code, count, section(edit.from) ?? "main", catalog);
    for (let moved = 0; moved < count; moved += 1) next[section(edit.to) ?? "main"].push(code);
  }
  return next;
}
