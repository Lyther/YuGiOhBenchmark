import { readFile } from "node:fs/promises";

// SUBSTITUTE_JUSTIFICATION
// - substitute: the captured sessions in fixtures/sessions (described in its
//   README.md), read by readSession; used by seat/sessions.test.js and
//   game/board.test.js.
// - replaces: the live server's packet stream to one seat.
// - necessity: these are 2339's own bytes, but a live duel never repeats: the
//   same hands, answers and packet order cannot be produced again on demand,
//   so checking the seat against real server output offline needs the record.
// - proof-limit: a capture shows what the server sent then, not what it sends
//   now, and replaying it does not prove the server accepts the seat's answers.
// - real-proof: the live runs that recorded them (docs/status.md) and
//   npm run smoke.
export async function readSession(name) {
  const bytes = await readFile(new URL(`../fixtures/sessions/${name}.bin`, import.meta.url));
  const packets = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt16LE(offset + 4);
    packets.push({ ms: bytes.readUInt32LE(offset), packet: bytes.subarray(offset + 6, offset + 6 + length) });
    offset += 6 + length;
  }
  return packets;
}
