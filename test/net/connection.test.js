import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { YGOProStocChat } from "ygopro-msg-encode";

import { openConnection } from "../../src/net/connection.js";
import { encodeLeaveGame, encodePlayerInfo } from "../../src/protocol/packets.js";

// These are real TCP transport tests. The peer does not implement game rules;
// only the live probe establishes interoperability with the hosted game server.
async function listen(t, handle) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    handle(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return { host: "127.0.0.1", port: server.address().port, server };
}

function chat(text) {
  const message = new YGOProStocChat();
  message.msg = text;
  message.player_type = 0;
  return Buffer.from(message.toFullPayload());
}

test("connection sends in order and delivers split/coalesced packets with raw bodies", { timeout: 3000 }, async (t) => {
  const first = chat("first\nline");
  const second = chat("second");
  const sent = Buffer.concat([encodePlayerInfo("wire-check"), encodeLeaveGame()]);
  let received = Buffer.alloc(0);
  const peer = await listen(t, (socket) => {
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length === sent.length) {
        socket.write(first.subarray(0, 1));
        setImmediate(() => socket.end(Buffer.concat([first.subarray(1), second])));
      }
    });
  });
  const messages = [];
  const errors = [];
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const connection = await openConnection({
    ...peer,
    onMessage: (decoded, packet) => messages.push({ ...decoded, packet }),
    onError: (error) => errors.push(error),
    onClose: finish,
  });
  connection.send(encodePlayerInfo("wire-check"));
  connection.send(encodeLeaveGame());
  assert.equal((await closed).reason, "server-closed");
  assert.deepEqual(received, sent);
  assert.deepEqual(errors, []);
  assert.deepEqual(messages.map(({ message }) => message.msg), ["first\nline", "second"]);
  assert.deepEqual(messages[0].raw, first.subarray(3));
  assert.deepEqual(messages[0].packet, first);
  assert.throws(() => connection.send(sent), /closed/);
  await connection.close();
});

test("an unreadable message is reported and the following packet is delivered", { timeout: 3000 }, async (t) => {
  const malformedChat = Buffer.from([1, 0, 0x19]);
  const valid = chat("still readable");
  const peer = await listen(t, (socket) => socket.end(Buffer.concat([malformedChat, valid])));
  const messages = [];
  const errors = [];
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  await openConnection({
    ...peer,
    onMessage: ({ message }) => messages.push(message.msg),
    onError: (error, packet) => errors.push({ error, packet }),
    onClose: finish,
  });
  assert.equal((await closed).reason, "server-closed");
  assert.deepEqual(messages, ["still readable"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /too short/);
  assert.deepEqual(errors[0].packet, malformedChat);
});

test("a truncated packet at EOF reports a transport error", { timeout: 3000 }, async (t) => {
  const peer = await listen(t, (socket) => socket.end(chat("incomplete").subarray(0, 4)));
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  await openConnection({
    ...peer,
    onMessage: () => assert.fail("a partial packet must not be delivered"),
    onError: (error) => assert.fail(error.message),
    onClose: finish,
  });
  const result = await closed;
  assert.equal(result.reason, "error");
  assert.match(result.error.message, /during a packet/);
});

test("local close flushes queued writes and reports local exactly once", { timeout: 3000 }, async (t) => {
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  const peer = await listen(t, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finishRead(Buffer.concat(chunks)));
  });
  const reasons = [];
  const connection = await openConnection({
    ...peer,
    onMessage: () => assert.fail("peer sends no packets"),
    onError: (error) => assert.fail(error.message),
    onClose: ({ reason }) => reasons.push(reason),
  });
  connection.send(encodeLeaveGame());
  await connection.close();
  await connection.close();
  assert.deepEqual(await read, encodeLeaveGame());
  assert.deepEqual(reasons, ["local"]);
});

test("a refused real TCP connection is reported once, by the rejection", { timeout: 3000 }, async (t) => {
  const peer = await listen(t, () => { });
  await new Promise((resolve) => peer.server.close(resolve));
  const closes = [];
  await assert.rejects(openConnection({
    ...peer,
    onMessage: () => assert.fail("no server is listening"),
    onError: (error) => assert.fail(error.message),
    onClose: (closed) => closes.push(closed),
  }), { code: "ECONNREFUSED" });
  // The socket's close event follows its error; a second report would land here.
  await delay(50);
  assert.deepEqual(closes, [], "a caller that retries on the rejection must not retry on a close as well");
});
