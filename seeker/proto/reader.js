// Little-endian reader over a decrypted message payload.
class Reader {
	constructor(buf) { this.b = buf; this.o = 0; }
	get left() { return this.b.length - this.o; }
	u8() { return this.b[this.o++]; }
	i8() { return this.b.readInt8(this.o++); }
	u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
	i16() { const v = this.b.readInt16LE(this.o); this.o += 2; return v; }
	u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
	i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
	f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
	id() { return this.u32(); } // ids are 32-bit on 516 servers
	str() {
		const e = this.b.indexOf(0, this.o);
		const end = e < 0 ? this.b.length : e;
		const s = this.b.toString('utf8', this.o, end);
		this.o = end + 1;
		return s;
	}
	bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}
module.exports = { Reader };
