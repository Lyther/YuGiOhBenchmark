import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

const noWait = { sleep: async () => { }, random: () => 0 };
// Downloads are checked for the SQLite header before install.
const cdb = (text) => `SQLite format 3\u0000${text}`;

test("the canonical list names the four contract sources with en-US required", () => {
  assert.deepEqual(CARD_SOURCES.map((source) => source.name), ["en-US", "super-pre-en", "super-pre", "zh-CN"]);
  assert.deepEqual(CARD_SOURCES.filter((source) => source.required).map((source) => source.name), ["en-US"]);
  assert.deepEqual(CARD_SOURCES.find((source) => source.name === "super-pre").files,
    ["test-release.cdb", "test-update.cdb", "test-strings.conf"]);
  for (const source of CARD_SOURCES) assert.match(source.base, /^https:\/\//);
});

test("a source is written whole, then reported current when unchanged", async (t) => {
  const { base } = await origin(t, { "/a/cards.cdb": { body: cdb("cdb-bytes") }, "/a/strings.conf": { body: "!system 1 x" } });
  const dir = await tempDir(t);
  const sources = [{ name: "en-US", base: `${base}/a/`, files: ["cards.cdb", "strings.conf"], required: true }];
  const first = await refreshCards(dir, { sources, ...noWait });
  assert.deepEqual(first.map(({ name, status }) => ({ name, status })), [{ name: "en-US", status: "updated" }]);
  assert.equal(await readFile(join(dir, "en-US/cards.cdb"), "utf8"), cdb("cdb-bytes"));
  assert.equal(await readFile(join(dir, "en-US/strings.conf"), "utf8"), "!system 1 x");
  const second = await refreshCards(dir, { sources, ...noWait });
  assert.equal(second[0].status, "current");
});

test("a failed file leaves the previous set untouched and no temporary files", async (t) => {
  const { base } = await origin(t, { "/b/cards.cdb": { body: cdb("new-cdb") } });
  const dir = await tempDir(t);
  await mkdir(join(dir, "zh-CN"), { recursive: true });
  await writeFile(join(dir, "zh-CN/cards.cdb"), "old-cdb");
  await writeFile(join(dir, "zh-CN/strings.conf"), "old-strings");
  const sources = [{ name: "zh-CN", base: `${base}/b/`, files: ["cards.cdb", "strings.conf"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 2, ...noWait });
  assert.equal(result.status, "failed");
  assert.match(result.error, /strings\.conf/);
  assert.match(result.error, /404/);
  assert.equal(await readFile(join(dir, "zh-CN/cards.cdb"), "utf8"), "old-cdb");
  assert.deepEqual((await readdir(join(dir, "zh-CN"))).sort(), ["cards.cdb", "strings.conf"]);
});

test("a transient server error is retried with backoff before giving up", async (t) => {
  let calls = 0;
  const { base, hits } = await origin(t, {
    "/c/test-release.cdb": () => (++calls < 3 ? { status: 503, body: "busy" } : { body: cdb("finally") }),
  });
  const dir = await tempDir(t);
  const waits = [];
  const sources = [{ name: "super-pre", base: `${base}/c/`, files: ["test-release.cdb"] }];
  const [result] = await refreshCards(dir, {
    sources, attempts: 3, sleep: async (ms) => waits.push(ms), random: () => 0.5,
  });
  assert.equal(result.status, "updated");
  assert.equal(hits.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0], "backoff grows between attempts");
  assert.equal(await readFile(join(dir, "super-pre/test-release.cdb"), "utf8"), cdb("finally"));
});

test("a 200 body that is not card data is refused and the previous files stay", async (t) => {
  const { base } = await origin(t, {
    "/d/cards.cdb": { body: "<html>sign in to the network</html>" }, "/d/strings.conf": { body: "!system 1 x" },
    "/e/cards.cdb": { body: cdb("good") }, "/e/strings.conf": { body: "<html>error</html>" },
  });
  const dir = await tempDir(t);
  await mkdir(join(dir, "zh-CN"), { recursive: true });
  await writeFile(join(dir, "zh-CN/cards.cdb"), cdb("old"));
  const sources = [
    { name: "zh-CN", base: `${base}/d/`, files: ["cards.cdb", "strings.conf"] },
    { name: "en-US", base: `${base}/e/`, files: ["cards.cdb", "strings.conf"] },
  ];
  const [html, strings] = await refreshCards(dir, { sources, ...noWait });
  assert.equal(html.status, "failed");
  assert.match(html.error, /cards\.cdb: not a SQLite card database/);
  assert.equal(await readFile(join(dir, "zh-CN/cards.cdb"), "utf8"), cdb("old"));
  assert.equal(strings.status, "failed");
  assert.match(strings.error, /strings\.conf: not a strings file/);
  assert.deepEqual(await readdir(dir), ["zh-CN"], "nothing was installed for the refused set");
});

test("a body over the size limit is refused without retrying", async (t) => {
  const { base, hits } = await origin(t, { "/f/test-release.cdb": { body: cdb("0123456789") } });
  const dir = await tempDir(t);
  const sources = [{ name: "super-pre", base: `${base}/f/`, files: ["test-release.cdb"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 3, maxFileBytes: 8, ...noWait });
  assert.equal(result.status, "failed");
  assert.match(result.error, /over the 8 byte limit/);
  assert.equal(hits.length, 1);
});

test("a body that streams past the size limit is cut off as it arrives", async (t) => {
  const { base, hits } = await origin(t, { "/g/test-release.cdb": { stream: cdb("0123456789") } });
  const dir = await tempDir(t);
  const sources = [{ name: "super-pre", base: `${base}/g/`, files: ["test-release.cdb"] }];
  const [result] = await refreshCards(dir, { sources, attempts: 3, timeoutMs: 2000, maxFileBytes: 64, ...noWait });
  assert.equal(result.status, "failed");
  assert.match(result.error, /over the 64 byte limit/, "not a timeout after buffering an endless body");
  assert.equal(hits.length, 1);
  assert.deepEqual(await readdir(dir), [], "nothing was installed");
});
