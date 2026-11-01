// Generates test.dmi (floor, wall, mob states) for the webclient test world
const zlib = require('zlib'), fs = require('fs');
const W = 96, H = 32, cols = [[90, 90, 100], [40, 40, 50], [200, 60, 60]];
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
	raw[y * (W * 4 + 1)] = 0;
	for (let x = 0; x < W; x++) {
		const s = Math.floor(x / 32), lx = x % 32;
		let c = cols[s], a = 255;
		if (s == 0 && (lx == 0 || y == 0)) c = [70, 70, 80];
		if (s == 2) { const dx = lx - 16, dy = y - 16; if (dx * dx + dy * dy > 100) a = 0; }
		const o = y * (W * 4 + 1) + 1 + x * 4;
		raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = a;
	}
}
const table = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
function crc(b) { let r = ~0; for (const x of b) r = table[(r ^ x) & 255] ^ (r >>> 8); return (~r) >>> 0; }
function chunk(type, data) {
	const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
	return Buffer.concat([l, td, c]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
let desc = '# BEGIN DMI\nversion = 4.0\n\twidth = 32\n\theight = 32\n';
for (const s of ['floor', 'wall', 'mob']) desc += 'state = "' + s + '"\n\tdirs = 1\n\tframes = 1\n';
desc += '# END DMI\n';
const ztxt = Buffer.concat([Buffer.from('Description\0\0'), zlib.deflateSync(Buffer.from(desc))]);
fs.writeFileSync(process.argv[2], Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk('IHDR', ihdr), chunk('zTXt', ztxt), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
