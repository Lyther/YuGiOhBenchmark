import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Canonical card-data inputs (contracts.md Card Data Inputs), lowest merge
// priority last; the catalog decides merge order, this list only fetches.
export const CARD_SOURCES = Object.freeze([
  {
    name: "en-US",
    required: true,
    base: "https://raw.githubusercontent.com/mycard/ygopro-database/master/locales/en-US/",
    files: ["cards.cdb", "strings.conf"],
  },
  {
    name: "super-pre-en",
    base: "https://raw.githubusercontent.com/ElderLich/TransSuperpre/main/EN/Base%20Files/",
    files: ["test-release.cdb", "test-strings.conf"],
  },
  {
    name: "super-pre",
    base: "https://cdn02.moecube.com:444/ygopro-super-pre/data/",
    files: ["test-release.cdb", "test-update.cdb", "test-strings.conf"],
  },
  {
    name: "zh-CN",
    base: "https://raw.githubusercontent.com/mycard/ygopro-database/master/locales/zh-CN/",
    files: ["cards.cdb", "strings.conf"],
  },
]);

// An 8 MB CDB took 32 s through a proxy on 2026-10-07; allow slow links per attempt.
// The largest file is about 8 MB, so 64 MiB only stops a runaway body.
const DEFAULTS = Object.freeze({ attempts: 3, timeoutMs: 300_000, baseDelayMs: 500, maxFileBytes: 64 * 1024 * 1024 });
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

// A captive portal or an error page can answer 200; it must not replace good data.
function checkFile(file, bytes) {
  if (file.endsWith(".cdb")) {
    if (!bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw new Error("not a SQLite card database");
  } else if (!/^!/m.test(bytes.toString("utf8"))) {
    throw new Error("not a strings file (no ! entries)");
  }
}

export async function refreshCards(dir, options = {}) {
  const opts = { sources: CARD_SOURCES, fetchImpl: fetch, sleep: delay, random: Math.random, ...DEFAULTS, ...options };
  const results = [];
  for (const source of opts.sources) results.push(await refreshSource(dir, source, opts));
  return results;
}

async function refreshSource(dir, source, opts) {
  const fetched = [];
  for (const file of source.files) {
    opts.log?.info({ source: source.name, file }, "downloading card data");
    try {
      const bytes = await download(new URL(file, source.base).href, opts);
      checkFile(file, bytes);
      fetched.push({ file, bytes });
    } catch (error) {
      return { name: source.name, status: "failed", error: `${file}: ${error.message}` };
    }
  }
  const target = join(dir, source.name);
  const files = fetched.map(({ file, bytes }) => ({ file, bytes: bytes.length }));
  if (await matchesDisk(target, fetched)) return { name: source.name, status: "current", files };
  try {
    await install(target, fetched);
  } catch (error) {
    return { name: source.name, status: "failed", error: `write: ${error.message}` };
  }
  return { name: source.name, status: "updated", files };
}

async function download(url, { fetchImpl, timeoutMs, attempts, baseDelayMs, sleep, random, maxFileBytes }) {
  for (let attempt = 1; ; attempt += 1) {
    let retryable = true;
    const tooLarge = (bytes) => {
      retryable = false;
      return new Error(`${bytes} bytes is over the ${maxFileBytes} byte limit`);
    };
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        retryable = response.status >= 500 || response.status === 429;
        throw new Error(`HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxFileBytes) throw tooLarge(declared);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxFileBytes) throw tooLarge(bytes.length);
      return bytes;
    } catch (error) {
      if (!retryable || attempt >= attempts) throw error;
      // Exponential backoff with jitter in [0.5, 1.5) of the base step.
      await sleep(baseDelayMs * 2 ** (attempt - 1) * (0.5 + random()));
    }
  }
}

async function matchesDisk(target, fetched) {
  for (const { file, bytes } of fetched) {
    const existing = await readFile(join(target, file)).catch(() => null);
    if (!existing || !existing.equals(bytes)) return false;
  }
  return true;
}

// Every file of a source is staged under a temporary name first, so a failed
// download or write never replaces only part of a set.
async function install(target, fetched) {
  await mkdir(target, { recursive: true });
  const tag = randomBytes(4).toString("hex");
  const staged = [];
  try {
    for (const { file, bytes } of fetched) {
      const temp = join(target, `.${file}.${tag}.part`);
      await writeFile(temp, bytes);
      staged.push({ temp, final: join(target, file) });
    }
    for (const { temp, final } of staged) await rename(temp, final);
  } catch (error) {
    await Promise.all(staged.map(({ temp }) => rm(temp, { force: true })));
    throw error;
  }
}
