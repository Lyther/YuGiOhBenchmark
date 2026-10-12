import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import initSqlJs from "sql.js";
import { CardDataEntry, YGOProCdb } from "ygopro-cdb-encode";

import { CARD_SOURCES, refreshCards } from "../../src/cards/sources.js";

// SUBSTITUTE_JUSTIFICATION: the real origins (GitHub raw, MyCard CDN) cannot be
// made to fail or flap on demand, so these cases use a disposable real HTTP
// server on loopback. The live `npm run cards` run is the proof against the
// real origins; these results only cover the temp-then-rename and retry logic.
async function origin(t, routes) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    const route = routes[request.url];
    const reply = typeof route === "function" ? route() : route;
    if (!reply) {
      response.writeHead(404).end("missing");
      return;
    }
    if (reply.stream) {
      // No length and no end: the chunk repeats until the client goes away.
      response.writeHead(200);
      const timer = setInterval(() => response.write(reply.stream), 1);
      response.on("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(reply.status ?? 200).end(reply.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ygo-cards-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Real timers, with the retry backoff cut to a 1 ms base.
const QUICK = { baseDelayMs: 1 };
const fixture = JSON.parse(await readFile(new URL("../fixtures/cards.json", import.meta.url), "utf8"));
const SQL = await initSqlJs();

// A real card database, written by the real writer; its one row is a fixture
// card, and different rows give databases that differ.
function cardDatabase(row = 0) {
  const data = fixture.datas[row];
  const cdb = new YGOProCdb(SQL);
  cdb.addCard([new CardDataEntry().fromSqljsRow({ ...data, ...fixture.texts.find((entry) => entry.id === data.id) })]);
  const bytes = Buffer.from(cdb.export());
  cdb.finalize();
  return bytes;
}

test("the canonical list names the four contract sources with en-US required", () => {
  assert.deepEqual(CARD_SOURCES.map((source) => source.name), ["en-US", "super-pre-en", "super-pre", "zh-CN"]);
  assert.deepEqual(CARD_SOURCES.filter((source) => source.required).map((source) => source.name), ["en-US"]);
  assert.deepEqual(CARD_SOURCES.find((source) => source.name === "super-pre").files,
    ["test-release.cdb", "test-update.cdb", "test-strings.conf"]);
  for (const source of CARD_SOURCES) assert.match(source.base, /^https:\/\//);
});

test("a source is written whole, then reported current when unchanged", async (t) => {
  const database = cardDatabase();
  const { base } = await origin(t, { "/a/cards.cdb": { body: database }, "/a/strings.conf": { body: "!system 1 x" } });
  const dir = await tempDir(t);
  const sources = [{ name: "en-US", base: `${base}/a/`, files: ["cards.cdb", "strings.conf"], required: true }];
  const first = await refreshCards(dir, { sources, ...QUICK });
  assert.deepEqual(first.map(({ name, status }) => ({ name, status })), [{ name: "en-US", status: "updated" }]);
  assert.deepEqual(await readFile(join(dir, "en-US/cards.cdb")), database);
  assert.equal(await readFile(join(dir, "en-US/strings.conf"), "utf8"), "!system 1 x");
  const second = await refreshCards(dir, { sources, ...QUICK });
  assert.equal(second[0].status, "current");
});

test("a failed file leaves the previous set untouched and no temporary files", async (t) => {
  const { base } = await origin(t, { "/b/cards.cdb": { body: cardDatabase(1) } });
  const dir = await tempDir(t);
  await mkdir(join(dir, "zh-CN"), { recursive: true });
  await writeFile(join(dir, "zh-CN/cards.cdb"), cardDatabase(0));
  await writeFile(join(dir, "zh-CN/strings.conf"), "old-strings");
  const sources = [{ name: "zh-CN", base: `${base}/b/`, files: ["cards.cdb", "strings.conf"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 2, ...QUICK });
  assert.equal(result.status, "failed");
  assert.match(result.error, /strings\.conf/);
  assert.match(result.error, /404/);
  assert.deepEqual(await readFile(join(dir, "zh-CN/cards.cdb")), cardDatabase(0));
  assert.deepEqual((await readdir(join(dir, "zh-CN"))).sort(), ["cards.cdb", "strings.conf"]);
});

test("a transient server error is retried with backoff before giving up", async (t) => {
  const times = [];
  const database = cardDatabase();
  const { base, hits } = await origin(t, {
    "/c/test-release.cdb": () => (times.push(performance.now()) < 3 ? { status: 503, body: "busy" } : { body: database }),
  });
  const dir = await tempDir(t);
  const sources = [{ name: "super-pre", base: `${base}/c/`, files: ["test-release.cdb"] }];
  // Real sleeps. The jitter is fixed at its middle so the waits are 40 and 80 ms:
  // with real jitter a grown second wait could be shorter than the first.
  const [result] = await refreshCards(dir, { sources, attempts: 3, baseDelayMs: 40, random: () => 0.5 });
  assert.equal(result.status, "updated");
  assert.equal(hits.length, 3);
  // Lower bounds only: a slow machine makes waits longer, never shorter.
  const [first, second] = [times[1] - times[0], times[2] - times[1]];
  assert.ok(first >= 35, `first wait ${first} ms`);
  assert.ok(second >= 70, `second wait ${second} ms: the backoff grows`);
  assert.deepEqual(await readFile(join(dir, "super-pre/test-release.cdb")), database);
});

test("a 200 body that is not card data is refused and the previous files stay", async (t) => {
  const { base } = await origin(t, {
    "/d/cards.cdb": { body: "<html>sign in to the network</html>" }, "/d/strings.conf": { body: "!system 1 x" },
    "/e/cards.cdb": { body: cardDatabase(1) }, "/e/strings.conf": { body: "<html>error</html>" },
  });
  const dir = await tempDir(t);
  await mkdir(join(dir, "zh-CN"), { recursive: true });
  await writeFile(join(dir, "zh-CN/cards.cdb"), cardDatabase(0));
  const sources = [
    { name: "zh-CN", base: `${base}/d/`, files: ["cards.cdb", "strings.conf"] },
    { name: "en-US", base: `${base}/e/`, files: ["cards.cdb", "strings.conf"] },
  ];
  const [html, strings] = await refreshCards(dir, { sources, ...QUICK });
  assert.equal(html.status, "failed");
  assert.match(html.error, /cards\.cdb: not a SQLite card database/);
  assert.deepEqual(await readFile(join(dir, "zh-CN/cards.cdb")), cardDatabase(0));
  assert.equal(strings.status, "failed");
  assert.match(strings.error, /strings\.conf: not a strings file/);
  assert.deepEqual(await readdir(dir), ["zh-CN"], "nothing was installed for the refused set");
});

test("a body over the size limit is refused without retrying", async (t) => {
  const { base, hits } = await origin(t, { "/f/test-release.cdb": { body: cardDatabase() } });
  const dir = await tempDir(t);
  const sources = [{ name: "super-pre", base: `${base}/f/`, files: ["test-release.cdb"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 3, maxFileBytes: 8, ...QUICK });
  assert.equal(result.status, "failed");
  assert.match(result.error, /over the 8 byte limit/);
  assert.equal(hits.length, 1);
});

test("a body that streams past the size limit is cut off as it arrives", async (t) => {
  const { base, hits } = await origin(t, { "/g/test-release.cdb": { stream: cardDatabase() } });
  const dir = await tempDir(t);
  const sources = [{ name: "super-pre", base: `${base}/g/`, files: ["test-release.cdb"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 3, timeoutMs: 2000, maxFileBytes: 64, ...QUICK });
  assert.equal(result.status, "failed");
  assert.match(result.error, /over the 64 byte limit/, "not a timeout after buffering an endless body");
  assert.equal(hits.length, 1);
  assert.deepEqual(await readdir(dir), [], "nothing was installed");
});
