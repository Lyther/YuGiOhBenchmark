export class PacketFramer {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const packets = [];
    while (this.pending.length >= 2) {
      // The wire length is uint16 and includes the message identifier.
      const declared = this.pending.readUInt16LE(0);
      if (declared === 0) throw new Error("rejected packet length 0");
      const total = 2 + declared;
      if (this.pending.length < total) break;
      packets.push(Buffer.from(this.pending.subarray(0, total)));
      this.pending = this.pending.subarray(total);
    }
    return packets;
  }
}
