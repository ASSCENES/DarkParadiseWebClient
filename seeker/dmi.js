// Reads the DMI "Description" metadata (zTXt/tEXt chunk) from a PNG.
const zlib = require('zlib');

function readDmiMeta(png) {
	let o = 8, desc = null, width = 0, height = 0;
	while (o + 8 <= png.length) {
		const len = png.readUInt32BE(o), type = png.toString('latin1', o + 4, o + 8);
		const data = png.subarray(o + 8, o + 8 + len);
		if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
		else if ((type === 'zTXt' || type === 'tEXt') && data.toString('latin1', 0, 11) === 'Description') {
			const body = data.subarray(12);
			desc = type === 'zTXt' ? zlib.inflateSync(body.subarray(1)).toString('utf8') : body.toString('utf8');
		}
		if (type === 'IEND') break;
		o += 12 + len;
	}
	return parseDescription(desc, width, height);
}

function parseDescription(desc, pngW, pngH) {
	const meta = { width: 32, height: 32, pngW, pngH, states: [] };
	// a plain image (no DMI description, e.g. a title screen PNG): one state, one frame, the whole picture
	if (!desc) { meta.width = pngW; meta.height = pngH; meta.cols = 1; meta.states.push({ name: '', dirs: 1, frames: 1, delay: [], offset: 0 }); return meta; }
	let cur = null, offset = 0;
	for (const raw of desc.split('\n')) {
		const m = raw.trim().match(/^(\w+)\s*=\s*(.*)$/);
		if (!m) continue;
		const [, key, val] = m;
		if (key === 'width') meta.width = +val;
		else if (key === 'height') meta.height = +val;
		else if (key === 'state') {
			if (cur) offset += cur.dirs * cur.frames;
			cur = { name: JSON.parse(val), dirs: 1, frames: 1, delay: [], offset };
			meta.states.push(cur);
		} else if (cur) {
			if (key === 'dirs') cur.dirs = +val;
			else if (key === 'frames') cur.frames = +val;
			else if (key === 'delay') cur.delay = val.split(',').map(Number);
			else if (key === 'rewind') cur.rewind = +val;
			else if (key === 'loop') cur.loop = +val;
			else if (key === 'movement') cur.movement = +val;
		}
	}
	meta.cols = Math.max(1, Math.floor(pngW / meta.width));
	return meta;
}

module.exports = { readDmiMeta };
