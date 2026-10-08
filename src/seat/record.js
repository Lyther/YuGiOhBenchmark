import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const UNSAFE = /[^A-Za-z0-9._-]/g;
const MAX_RECORD_BYTES = 0xffff;
const DIGEST_CHARS = 8;
const STATE_FILE = "seat.json";
const DECK_FILE = /^duel-(\d+)\.ydk$/;
const REPLAY_FILE = /^replay-\d+\.yrp$/;
const END_TYPES = new Set(["match", "aborted"]);

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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A hard stop can cut the last line; a line that does not parse is skipped.
function readResults(folder) {
  const file = join(folder, "results.jsonl");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// The only writer of the run folder: results.jsonl lines, the submitted deck
// per duel, the server's replay bytes as received, seat.json for a resume, and
// optional session.bin.
class Recorder {
  #room; #capture; #now; #monotonic; #log; #isAlive;
  #created = null;
  #seatState = null;
  #replays = 0;
  #connectedAt;
  #captureChain = Promise.resolve();
  // Writes run one at a time in call order, so a duel line always precedes
  // the match line written right after it.
  #writeChain = Promise.resolve();

  constructor({ runDir, room, name, capture, now, monotonic, log, isAlive }) {
    this.folder = runFolder(runDir, room, name);
    this.#room = room;
    this.#capture = capture;
    this.#now = now;
    this.#monotonic = monotonic;
    this.#log = log;
    this.#isAlive = isAlive;
    this.#connectedAt = monotonic();
  }

  #ensure() {
    this.#created ??= mkdir(this.folder, { recursive: true });
    return this.#created;
  }

  // What an existing folder holds; read back only to resume an interrupted
  // match (contracts.md Persistent Data). Null when there is no folder.
  inspect() {
    if (!existsSync(this.folder)) return null;
    const state = readJson(join(this.folder, STATE_FILE));
    if (!Number.isInteger(state?.pid)) return { refused: `run folder ${this.folder} already exists and holds no seat state; use a fresh room id or another YGO_NAME` };
    const lines = readResults(this.folder);
    const end = lines.find((line) => END_TYPES.has(line.type));
    if (end) return { refused: `run folder ${this.folder} already holds a match that is over (${end.type}); use a fresh room id or another YGO_NAME` };
    if (this.#isAlive(state.pid)) {
      return { refused: `run folder ${this.folder} belongs to seat process ${state.pid}, which is still running; stop it or use another YGO_NAME` };
    }
    const files = readdirSync(this.folder);
    const decks = new Map(files.flatMap((file) => {
      const found = DECK_FILE.exec(file);
      return found ? [[Number(found[1]), readFileSync(join(this.folder, file), "utf8")]] : [];
    }));
    return {
      started: state.started === true, duel: state.duel ?? 0, turn: state.turn ?? 0,
      results: lines.filter((line) => line.type === "duel"), decks, replays: files.filter((file) => REPLAY_FILE.test(file)).length,
    };
  }

  // Claims the folder once, before the join; synchronous so the join keeps its
  // order. A new folder is made; one a stopped seat left mid-match is taken
  // over and returned for the resume. Anything else refuses, so two runs'
  // files never mix.
  claim() {
    const found = this.inspect();
    if (found?.refused) throw new Error(found.refused);
    if (!found) this.#makeFolder();
    if (found && !found.started) {
      // No duel was played: the next join records its own lobby deck.
      for (const duel of found.decks.keys()) rmSync(join(this.folder, `duel-${duel}.ydk`));
      found.decks.clear();
    }
    this.#replays = found?.replays ?? 0;
    this.#seatState = { pid: process.pid, started: found?.started ?? false, duel: found?.duel ?? 0, turn: found?.turn ?? 0 };
    const temp = join(this.folder, `.${STATE_FILE}.tmp`);
    writeFileSync(temp, `${JSON.stringify(this.#seatState)}\n`);
    renameSync(temp, join(this.folder, STATE_FILE));
    this.#created = Promise.resolve();
    return found;
  }

  #makeFolder() {
    mkdirSync(dirname(this.folder), { recursive: true });
    try {
      mkdirSync(this.folder);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(`run folder ${this.folder} already exists; use a fresh room id or another YGO_NAME`, { cause: error });
    }
  }

  // The resume checkpoint, seat.json: whether a duel started, and the duel
  // and turn in progress, which the server does not resend on a rejoin.
  checkpoint(fields) {
    this.#seatState = { ...this.#seatState, ...fields };
    const text = `${JSON.stringify(this.#seatState)}\n`;
    return this.#queue(async () => {
      const temp = join(this.folder, `.${STATE_FILE}.tmp`);
      await writeFile(temp, text);
      await rename(temp, join(this.folder, STATE_FILE));
    });
  }

  #queue(write) {
    const run = this.#writeChain.then(() => this.#ensure()).then(write);
    this.#writeChain = run.catch(() => { });
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
  runDir, room, name, capture = false, now = () => new Date(), monotonic = () => performance.now(), log, isAlive = processAlive,
}) {
  return new Recorder({ runDir, room, name, capture, now, monotonic, log, isAlive });
}
