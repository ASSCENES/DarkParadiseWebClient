// Parser for message type 8: movable object updates (client handler 0x1004A5C0, protocol >= 0x202).
// Sections, each "u8 n" then n entries starting with {u32 ref, u16 kind}:
//   del, pos {u16 x, y, z}, next {u32 ref}, dir {u8}, appearance {u32},
//   step {u16 ×4}, bounds {u16 ×4}, glide {u16, u16, u32}, vis_contents {u16 n, n×(u8, u32)}, s10 {u32}
// followed by a trailing u8. "next" links the objects sharing a turf in contents order (0xffff ends the
// list); it is not a container: an object inside another one has x = y = 0xffff instead.
const { Reader } = require('./reader');

// start: byte offset; withFlags: type 8 begins with a flags byte, the mob block inside type 7 does not.
function parseObjects(buf, start = 0, withFlags = true) {
	const r = new Reader(buf);
	r.o = start;
	const flags = withFlags ? r.u8() : 0;
	if (flags & 2) r.o += 2; // DreamSeeker skips a u16 for each of these flags
	if (flags & 4) r.o += 2;
	const out = { flags, del: [], pos: [], next: [], dir: [], appearance: [], step: [], bounds: [], glide: [], vis: [], s10: [] };
	const section = (list, body) => {
		let n = r.u8();
		while (n--) { const e = { ref: r.u32(), kind: r.u16() }; body(e); list.push(e); }
	};
	section(out.del, () => {});
	section(out.pos, e => { e.x = r.u16(); e.y = r.u16(); e.z = r.u16(); });
	section(out.next, e => { e.next = r.u32(); });
	section(out.dir, e => { e.dir = r.u8(); });
	section(out.appearance, e => { e.appearance = r.u32(); });
	section(out.step, e => { e.v = [r.u16(), r.u16(), r.u16(), r.u16()]; });
	section(out.bounds, e => { e.v = [r.u16(), r.u16(), r.u16(), r.u16()]; });
	section(out.glide, e => { e.v = [r.u16(), r.u16(), r.u32()]; });
	section(out.vis, e => { const n = r.u16(); e.items = Array.from({ length: n }, () => ({ t: r.u8(), ref: r.u32() })); });
	section(out.s10, e => { e.v = r.u32(); });
	out.tail = r.left ? r.u8() : null;
	out._left = r.left;
	return out;
}

// Type 7 (client/eye update): a variable header followed by the same sections for mobs.
// Finds the earliest offset where the sections parse exactly to the end of the message.
// known: the block's offset when the header could be read (its fields are known); the block may be followed by
// zero padding. Scanning is the fallback: a step (pos, then next = 0xffff) shifted by one byte also parses,
// reading x|y<<16 as "next" and z as the next section's count, and the move would be lost.
function findMobBlock(buf, known = null) {
	if (known !== null) {
		try {
			const o = parseObjects(buf, known, false);
			if (o._left >= 0 && buf.subarray(buf.length - o._left).every(b => b === 0)) { o.start = known; return o; }
		} catch (_) {}
	}
	for (let start = 1; start < buf.length; start++) {
		try {
			const o = parseObjects(buf, start, false);
			if (o._left !== 0) continue;
			const all = [].concat(o.del, o.pos, o.next, o.dir, o.appearance, o.step, o.bounds, o.glide, o.vis, o.s10);
			if (all.some(e => e.ref > 0xffffff)) continue;
			// every entry of one object carries the same {ref, kind}; a misaligned start breaks that
			const kinds = new Map();
			if (all.some(e => kinds.has(e.ref) ? kinds.get(e.ref) !== e.kind : (kinds.set(e.ref, e.kind), false))) continue;
			if (o.pos.some(e => e.z > 0x400 || e.x > 0x4000 || e.y > 0x4000)) continue;
			o.start = start;
			return o;
		} catch (_) {}
	}
	return null;
}

module.exports = { parseObjects, findMobBlock };
