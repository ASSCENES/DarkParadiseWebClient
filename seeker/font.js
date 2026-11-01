// Family name of a TrueType/OpenType font (the 'name' table: typographic family 16, else family 1), so the page
// can register a world's fonts under the names its maptext CSS uses ("Grand9K Pixel" from Grand9K_Pixel.ttf).
function fontFamily(buf) {
	const tables = buf.readUInt16BE(4);
	for (let i = 0; i < tables; i++) {
		const o = 12 + i * 16;
		if (buf.toString('latin1', o, o + 4) !== 'name') continue;
		const at = buf.readUInt32BE(o + 8), count = buf.readUInt16BE(at + 2), strings = at + buf.readUInt16BE(at + 4);
		const found = {};
		for (let k = 0; k < count; k++) {
			const r = at + 6 + k * 12;
			const platform = buf.readUInt16BE(r), id = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), off = strings + buf.readUInt16BE(r + 10);
			if (id !== 1 && id !== 16) continue;
			const raw = buf.subarray(off, off + len);
			// Windows/Unicode names are UTF-16BE, Macintosh ones single-byte
			const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
			if (!found[id] || platform === 3) found[id] = text;
		}
		return found[16] || found[1] || null;
	}
	return null;
}

// Whether the font has a glyph for a character (the 'cmap' table, formats 4 and 12). Worlds may ship two files
// of one family (Paradise: Grand9K_Pixel and Grand9K_Pixel_modif, only the second with Cyrillic).
function hasGlyph(buf, code) {
	const tables = buf.readUInt16BE(4);
	for (let i = 0; i < tables; i++) {
		const o = 12 + i * 16;
		if (buf.toString('latin1', o, o + 4) !== 'cmap') continue;
		const at = buf.readUInt32BE(o + 8), n = buf.readUInt16BE(at + 2);
		for (let k = 0; k < n; k++) {
			const sub = at + buf.readUInt32BE(at + 4 + k * 8 + 4), format = buf.readUInt16BE(sub);
			if (format === 4) {
				const segs = buf.readUInt16BE(sub + 6) / 2, ends = sub + 14, starts = ends + segs * 2 + 2;
				const deltas = starts + segs * 2, offsets = deltas + segs * 2;
				for (let s = 0; s < segs; s++) {
					const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2);
					if (code < start || code > end) continue;
					const ro = buf.readUInt16BE(offsets + s * 2);
					if (!ro) return ((code + buf.readInt16BE(deltas + s * 2)) & 0xffff) !== 0;
					const g = buf.readUInt16BE(offsets + s * 2 + ro + (code - start) * 2);
					return g !== 0;
				}
			} else if (format === 12) {
				const groups = buf.readUInt32BE(sub + 12);
				for (let s = 0; s < groups; s++) {
					const p = sub + 16 + s * 12;
					if (code >= buf.readUInt32BE(p) && code <= buf.readUInt32BE(p + 4)) return true;
				}
			}
		}
		return false;
	}
	return false;
}

module.exports = { fontFamily, hasGlyph };
