// Native BYOND client transport (as used by DreamSeeker 516).
//
// Framing:  s2c [type u16 BE][len u16 BE][payload]
//           c2s [seq u16 BE][type u16 BE][len u16 BE][payload]   (no seq on the first, hello message)
// Cipher:   see crypt.js; payload ends with a checksum byte.
// Handshake:
//   c2s type 1 (plain): u32 516, u32 276, u32 R-0x01140204, u16 seq0, u32 build, f32 3.0
//   s2c type 1 (encrypted with R): u32 version, u32 minVersion, u8 x3,
//       u32 junk... until ((x + 0x1BD632F) & 0x4008000) == 0, then u32 k  => session key = R + k
//   c2s seq: seq' = (seq * 0x43D4) % 0xFFF1, 0 -> 1
const net = require('net');
const { EventEmitter } = require('events');
const { decrypt, encrypt } = require('./crypt');

const VERSION = 516, BUILD = 1688;

class ByondConnection extends EventEmitter {
	constructor(host, port) {
		super();
		this.host = host; this.port = port;
		this.key = 0; this.seq = 0; this.ready = false;
		this.buf = Buffer.alloc(0);
	}

	connect() {
		this.R = (Math.random() * 0xffffffff) >>> 0 || 1;
		this.seq = ((Math.random() * 0xfff0) | 0) + 1;
		this.key = this.R;
		this.sock = net.connect(this.port, this.host, () => this.sendHello());
		this.sock.on('data', d => this.onData(d));
		this.sock.on('close', () => this.emit('close'));
		this.sock.on('error', e => this.emit('error', e));
	}

	sendHello() {
		const p = Buffer.alloc(22);
		p.writeUInt32LE(VERSION, 0);
		p.writeUInt32LE(276, 4);
		p.writeUInt32LE((this.R - 0x01140204) >>> 0, 8);
		p.writeUInt16LE(this.seq, 12);
		p.writeUInt32LE(BUILD, 14);
		p.writeFloatLE(3.0, 18);
		const h = Buffer.alloc(4);
		h.writeUInt16BE(1, 0); h.writeUInt16BE(p.length, 2);
		this.sock.write(Buffer.concat([h, p]));
	}

	onData(d) {
		this.buf = Buffer.concat([this.buf, d]);
		while (this.buf.length >= 4) {
			let type = this.buf.readUInt16BE(0), len = this.buf.readUInt16BE(2), head = 4;
			// type 160 announces a long message: plain [u16 type][u32 len] BE, then the encrypted body with no header
			if (type === 160 && len === 6) {
				if (this.buf.length < 10) break;
				type = this.buf.readUInt16BE(4); len = this.buf.readUInt32BE(6); head = 10;
			}
			if (this.buf.length < head + len) break;
			const enc = this.buf.subarray(head, head + len);
			this.buf = this.buf.subarray(head + len);
			const { data, ok } = len ? decrypt(enc, this.key) : { data: Buffer.alloc(0), ok: true };
			if (!ok) { this.emit('bad', type, enc); continue; }
			if (type === 1 && !this.ready) { this.onServerHello(data); continue; }
			this.emit('message', type, data);
		}
	}

	onServerHello(p) {
		const version = p.readUInt32LE(0), minVersion = p.readUInt32LE(4);
		let o = 11;
		for (;;) {
			const x = p.readUInt32LE(o); o += 4;
			if ((((x + 0x1BD632F) >>> 0) & 0x4008000) === 0) break;
		}
		const k = p.readUInt32LE(o);
		this.key = (this.R + k) >>> 0;
		this.ready = true;
		const flags = [...p.subarray(8, 11)];
		this.emit('ready', { version, minVersion, flags, wideIds: !!(flags[2] & 1), wideVerbs: !!(flags[2] & 2) });
	}

	send(type, payload = Buffer.alloc(0)) {
		if (!this.sock || !this.ready) return; // (before the handshake there is no key to send with)
		const enc = encrypt(payload, this.key);
		const h = Buffer.alloc(6);
		h.writeUInt16BE(this.seq, 0); h.writeUInt16BE(type, 2); h.writeUInt16BE(enc.length, 4);
		this.sock.write(Buffer.concat([h, enc]));
		this.seq = (this.seq * 0x43D4) % 0xFFF1 || 1;
	}

	close() { this.sock && this.sock.destroy(); }
}

module.exports = { ByondConnection };
