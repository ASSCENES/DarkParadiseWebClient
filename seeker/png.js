// Minimal PNG decoder: 8-bit (and 1/2/4-bit palette/grey) non-interlaced images to straight (not premultiplied)
// RGBA. Browsers premultiply alpha when they decode, which destroys the colour of nearly transparent pixels;
// SS13 lighting icons keep a corner weight in alpha and need those bytes exactly.
const zlib = require('zlib');

function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
	let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
	const idat = [];
	while (o + 8 <= buf.length) {
		const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
		if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
		else if (kind === 'PLTE') palette = data;
		else if (kind === 'tRNS') trns = data;
		else if (kind === 'IDAT') idat.push(data);
		else if (kind === 'IEND') break;
		o += 12 + len;
	}
	if (interlace) throw new Error('interlaced PNG');
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
	if (!channels || (depth !== 8 && !(depth < 8 && (type === 0 || type === 3)))) throw new Error('unsupported PNG ' + type + '/' + depth);
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const bpp = Math.max(1, (channels * depth) >> 3), stride = (w * channels * depth + 7) >> 3;
	// unfiltered rows; one tight loop per filter type (the gateway decodes big DMI sheets while every player waits)
	const lines = new Uint8Array(stride * h), zero = new Uint8Array(stride);
	for (let y = 0, p = 0; y < h; y++) {
		const filter = raw[p++], o = y * stride, po = y ? o - stride : -1, prev = y ? lines : zero, pb = y ? po : 0;
		if (filter === 0) lines.set(raw.subarray(p, p + stride), o);
		else if (filter === 1) {
			for (let x = 0; x < bpp; x++) lines[o + x] = raw[p + x];
			for (let x = bpp; x < stride; x++) lines[o + x] = (raw[p + x] + lines[o + x - bpp]) & 255;
		} else if (filter === 2) {
			for (let x = 0; x < stride; x++) lines[o + x] = (raw[p + x] + prev[pb + x]) & 255;
		} else if (filter === 3) {
			for (let x = 0; x < bpp; x++) lines[o + x] = (raw[p + x] + (prev[pb + x] >> 1)) & 255;
			for (let x = bpp; x < stride; x++) lines[o + x] = (raw[p + x] + ((lines[o + x - bpp] + prev[pb + x]) >> 1)) & 255;
		} else {
			for (let x = 0; x < stride; x++) {
				const a = x >= bpp ? lines[o + x - bpp] : 0, b = prev[pb + x], c = x >= bpp ? prev[pb + x - bpp] : 0;
				const pa = Math.abs(b - c), pbb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
				lines[o + x] = (raw[p + x] + (pa <= pbb && pa <= pc ? a : pbb <= pc ? b : c)) & 255;
			}
		}
		p += stride;
	}
	// RGBA rows are the output as they are
	if (type === 6) return { width: w, height: h, data: Buffer.from(lines.buffer, lines.byteOffset, lines.length) };
	const out = Buffer.alloc(w * h * 4);
	const sample = (line, x) => {
		if (depth === 8) return line[x];
		const bit = x * depth;
		return (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
	};
	for (let y = 0; y < h; y++) {
		const line = lines.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < w; x++) {
			const q = (y * w + x) * 4;
			if (type === 2) { out[q] = line[x * 3]; out[q + 1] = line[x * 3 + 1]; out[q + 2] = line[x * 3 + 2]; out[q + 3] = 255; }
			else if (type === 4) { out[q] = out[q + 1] = out[q + 2] = line[x * 2]; out[q + 3] = line[x * 2 + 1]; }
			else if (type === 0) { const g = sample(line, x) * 255 / ((1 << depth) - 1); out[q] = out[q + 1] = out[q + 2] = g; out[q + 3] = 255; }
			else { const i = sample(line, x); out[q] = palette[i * 3]; out[q + 1] = palette[i * 3 + 1]; out[q + 2] = palette[i * 3 + 2]; out[q + 3] = trns && i < trns.length ? trns[i] : 255; }
		}
	}
	return { width: w, height: h, data: out };
}

// RGBA pixels to a PNG (no filtering): small icon frames for browser windows
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function encodePng(w, h, rgba, text = null) {
	const chunk = (kind, data) => {
		const head = Buffer.alloc(8), tail = Buffer.alloc(4);
		head.writeUInt32BE(data.length, 0); head.write(kind, 4, 'latin1');
		tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, tail]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	// text chunks (a DMI's "Description") go before the pixels, as BYOND writes them
	const texts = Object.entries(text || {}).map(([k, v]) => chunk('zTXt', Buffer.concat([Buffer.from(k + '\0\0', 'latin1'), zlib.deflateSync(Buffer.from(v, 'utf8'))])));
	return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...texts, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };
