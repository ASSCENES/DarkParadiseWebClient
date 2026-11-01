// Reader for BYOND .rsc resource archives.
// Entry: [u32 size][u8 valid][u8 type][u32 id][u32 time][u32 time][u32 len][name\0][data len bytes]
// size counts everything after the valid byte. id is the resource id used on the wire (type 14 etc).
const fs = require('fs');

class Rsc {
	// A missing archive (Dream Daemon recreates *.dyn.rsc at startup) indexes as empty until it appears.
	constructor(file) {
		this.file = file;
		this.entries = new Map();
		try { this.fd = fs.openSync(file, 'r'); } catch (_) { this.fd = null; return; }
		this.index();
	}

	index() {
		const size = fs.fstatSync(this.fd).size;
		const head = Buffer.alloc(22 + 256);
		let off = 0;
		while (off + 22 <= size) {
			fs.readSync(this.fd, head, 0, head.length, off);
			const entSize = head.readUInt32LE(0), valid = head[4];
			const next = off + 5 + entSize;
			if (entSize === 0 || next > size) break;
			if (valid) {
				const type = head[5], id = head.readUInt32LE(6), len = head.readUInt32LE(18);
				const nameEnd = head.indexOf(0, 22);
				const name = head.toString('latin1', 22, nameEnd < 0 ? head.length : nameEnd);
				this.entries.set(id, { id, type, name, dataOff: off + 22 + name.length + 1, len });
			}
			off = next;
		}
	}

	get(id) {
		const e = this.entries.get(id);
		if (!e || this.fd === null) return null;
		const buf = Buffer.alloc(e.len);
		fs.readSync(this.fd, buf, 0, e.len, e.dataOff);
		return { ...e, data: buf };
	}
}

// Entries of an .rsc held in memory (the fragments the server sends): [{ id, type, name, data }], valid only
function parseRsc(buf) {
	const out = [];
	let off = 0;
	while (off + 22 <= buf.length) {
		const entSize = buf.readUInt32LE(off), next = off + 5 + entSize;
		if (entSize === 0 || next > buf.length) break;
		if (buf[off + 4]) {
			const nameEnd = buf.indexOf(0, off + 22), len = buf.readUInt32LE(off + 18);
			const dataOff = nameEnd + 1;
			out.push({ id: buf.readUInt32LE(off + 6), type: buf[off + 5], name: buf.toString('latin1', off + 22, nameEnd), data: buf.subarray(dataOff, dataOff + len) });
		}
		off = next;
	}
	return out;
}

module.exports = { Rsc, parseRsc };

if (require.main === module) {
	const t = Date.now();
	const r = new Rsc(process.argv[2]);
	const byType = {};
	for (const e of r.entries.values()) byType[e.type] = (byType[e.type] || 0) + 1;
	console.log(r.entries.size, 'entries in', Date.now() - t, 'ms; by type', JSON.stringify(byType));
	console.log([...r.entries.values()].slice(0, 8).map(e => e.id.toString(16) + ' ' + e.type + ' ' + e.name + ' ' + e.len).join('\n'));
}
