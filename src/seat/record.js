import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const UNSAFE = /[^A-Za-z0-9._-]/g;
const MAX_RECORD_BYTES = 0xffff;
const DIGEST_CHARS = 8;

function segment(text) {
  const safe = text.replace(UNSAFE, "_");
  // "." and ".." would climb out of the run folder.
  const clean = /^\.*$/.test(safe) ? safe.replace(/\./g, "_") || "_" : safe;
  // A name that lost characters keeps a digest, so 名前 and 名称 stay apart.
  if (clean === text) return clean;
  return `${clean}-${createHash("sha256").update(text).digest("hex").slice(0, DIGEST_CHARS)}`;
}

export function runFolder(runDir, room, name) {
  const roomId = room.includes("#") ? room.slice(room.indexOf("#") + 1) : room;
  return join(runDir, segment(roomId), segment(name));
}

// The only writer of the run folder: results.jsonl lines, the submitted deck
// per duel, the server's replay bytes as received, and optional session.bin.
class Recorder {
  #room; #capture; #now; #monotonic; #log;
  #created = null;
  #replays = 0;
  #connectedAt;
  #captureChain = Promise.resolve();
  // Writes run one at a time in call order, so a duel line always precedes
  // the match line written right after it.
  #writeChain = Promise.resolve();

  constructor({ runDir, room, name, capture, now, monotonic, log }) {
    this.folder = runFolder(runDir, room, name);
    this.#room = room;
    this.#capture = capture;
    this.#now = now;
    this.#monotonic = monotonic;
    this.#log = log;
    this.#connectedAt = monotonic();
  }

  #ensure() {
    this.#created ??= mkdir(this.folder, { recursive: true });
    return this.#created;
  }

  // Claims the folder for this seat. An existing folder means a rerun or a
  // second seat with the same room and name, whose files would mix with these.
  // Synchronous, so the join that follows keeps its order; it runs once.
  claim() {
    mkdirSync(dirname(this.folder), { recursive: true });
    try {
      mkdirSync(this.folder);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(`run folder ${this.folder} already exists; use a fresh room id or another YGO_NAME`, { cause: error });
    }
    this.#created = Promise.resolve();
  }

  #queue(write) {
    const run = this.#writeChain.then(() => this.#ensure()).then(write);
    this.#writeChain = run.catch(() => {});
    return run;
  }

  deck(duel, ydkText) {
    return this.#queue(() => writeFile(join(this.folder, `duel-${duel}.ydk`), ydkText, { flag: "wx" }));
  }

  replay(bytes) {
    this.#replays += 1;
    const index = this.#replays;
    return this.#queue(() => writeFile(join(this.folder, `replay-${index}.yrp`), bytes, { flag: "wx" })).then(() => index);
  }

  result({ type, ...fields }) {
    const line = { type, room: this.#room, ...fields, at: this.#now().toISOString() };
    return this.#queue(() => appendFile(join(this.folder, "results.jsonl"), `${JSON.stringify(line)}\n`));
  }

  startCapture() {
    this.#connectedAt = this.#monotonic();
  }

  packet(bytes) {
    if (!this.#capture) return;
    if (bytes.length > MAX_RECORD_BYTES) {
      this.#log?.warn({ bytes: bytes.length }, "packet too large for session.bin; not captured");
      return;
    }
    const header = Buffer.alloc(6);
    header.writeUInt32LE(Math.max(0, Math.round(this.#monotonic() - this.#connectedAt)), 0);
    header.writeUInt16LE(bytes.length, 4);
    const record = Buffer.concat([header, bytes]);
    this.#captureChain = this.#captureChain
      .then(() => this.#ensure())
      .then(() => appendFile(join(this.folder, "session.bin"), record))
      .catch((error) => this.#log?.error({ err: error }, "session capture write failed"));
  }

  async flush() {
    await Promise.all([this.#captureChain, this.#writeChain]);
  }

  async close() {
    await this.flush();
  }
}

export function createRecorder({
  runDir, room, name, capture = false, now = () => new Date(), monotonic = () => performance.now(), log,
}) {
  return new Recorder({ runDir, room, name, capture, now, monotonic, log });
}
