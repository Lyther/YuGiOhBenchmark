const SECTIONS = ["system", "victory", "counter", "setname"];

function emptyStrings() {
  return Object.fromEntries(SECTIONS.map((section) => [section, new Map()]));
}

export function parseStringsConf(text) {
  const strings = emptyStrings();
  for (const line of text.split(/\r?\n/)) {
    const match = /^!(\w+) (\S+) ?(.*)$/.exec(line);
    if (!match || !SECTIONS.includes(match[1])) continue;
    const key = Number(match[2]);
    if (!Number.isInteger(key)) continue;
    strings[match[1]].set(key, match[3].trim());
  }
  return strings;
}

// Lowest priority first; a later set replaces an earlier one key by key.
export function mergeStrings(sets) {
  const merged = emptyStrings();
  for (const set of sets) {
    for (const section of SECTIONS) {
      for (const [key, value] of set[section]) merged[section].set(key, value);
    }
  }
  return merged;
}
