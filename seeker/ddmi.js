// Icons a world builds at run time (new /icon, Blend, Turn…) reach the client as a recipe, resource type 12
// "DDMI", which the client carries out itself. Worked out from samples of each icon proc (webtest test_ddmi):
//
//   "DDMI", u32 length of the rest, then a stack program:
//   01 u32 i      push resource i of the world's list (message 14)       08     push null
//   05 text \0    push a string                                           03 rgba push a colour
//   40 dir frame moving   icon(file, state): pops state, null, file; ff = any
//   42 mode       Blend(top, mode) into the icon below; 4d mode u16 x, u16 y: the same at x, y
//                 (mode 0 add, 1 subtract, 4 multiply, 7 overlay; the rest taken as overlay)
//   41 dir frame f32 delay moving   Insert(icon, state): pops state, icon
//   43 f32 r g b     SetIntensity (negative: unchanged)    44 d  Flip (d: DMI direction index)
//   45 f32 angle     Turn                                  47 d u16 n u8 wrap  Shift
//   48 u8            SwapColor(old, new): pops new, old    4a u8 n, n × f32    MapColors
//   49 u16 x1 y1 x2 y2  DrawBox(colour, …)                 4b u16 w, h         Scale
//   4c u16 x1 y1 x2 y2  Crop (0-based, from the top, end exclusive)
//
// The result is written as an ordinary DMI (PNG sheet + Description), so the rest of the gateway serves it
// like any other icon.
const { decodePng, encodePng } = require('./png');
const { readDmiMeta } = require('./dmi');

const DIRS = [2, 1, 4, 8, 6, 10, 5, 9]; // DMI order: S N E W SE SW NE NW

// Decoded DMI sheets by key (a resource id), the most recently used up to ~256 MB of pixels. Decoding a big
// sheet takes tens of milliseconds and blocks the whole gateway (every player waits): SS13 builds many run-time
// icons from the same few body sheets, and tgui asks for frames of the same icons again and again.
const sheets = new Map();
let sheetBytes = 0;
function decodeSheet(key, png) {
	let s = key != null && sheets.get(key);
	if (s) { sheets.delete(key); sheets.set(key, s); return s; }
	s = { meta: readDmiMeta(png), img: decodePng(png), dmi: null };
	if (key == null) return s;
	sheets.set(key, s);
	sheetBytes += s.img.data.length;
	for (const [k, old] of sheets) {
		if (sheetBytes <= 256e6 || k === key) break;
		sheets.delete(k); sheetBytes -= old.img.data.length;
	}
	return s;
}

// A DMI file -> { w, h, states: [{ name, dirs, frames, delay, loop, rewind, movement, px: [Buffer] }] }; the
// frames of a state are cut from the sheet when first used (px is a getter), most recipes use one state
function loadDmi(png, key) {
	const sheet = decodeSheet(key, png);
	if (sheet.dmi) return sheet.dmi;
	const { meta, img } = sheet, w = meta.width, h = meta.height, cols = meta.cols || 1;
	const states = meta.states.map(s => {
		const st = { name: s.name, dirs: s.dirs, frames: s.frames, delay: s.delay || [], loop: s.loop, rewind: s.rewind, movement: s.movement };
		let px = null;
		Object.defineProperty(st, 'px', { enumerable: true, get() {
			if (px) return px;
			px = [];
			for (let n = 0; n < s.dirs * s.frames; n++) {
				const k = s.offset + n, sx = (k % cols) * w, sy = Math.floor(k / cols) * h, out = Buffer.alloc(w * h * 4);
				for (let y = 0; y < h; y++) if (sy + y < img.height) img.data.copy(out, y * w * 4, ((sy + y) * img.width + sx) * 4, ((sy + y) * img.width + sx + w) * 4);
				px.push(out);
			}
			return px;
		} });
		return st;
	});
	return (sheet.dmi = { w, h, states });
}

function saveDmi(ic) {
	const n = ic.states.reduce((k, s) => k + s.px.length, 0) || 1, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
	const W = cols * ic.w, H = rows * ic.h, sheet = Buffer.alloc(W * H * 4);
	let k = 0;
	let desc = '# BEGIN DMI\nversion = 4.0\n\twidth = ' + ic.w + '\n\theight = ' + ic.h + '\n';
	for (const s of ic.states) {
		desc += 'state = ' + JSON.stringify(s.name) + '\n\tdirs = ' + s.dirs + '\n\tframes = ' + s.frames + '\n';
		if (s.frames > 1 && s.delay.length) desc += '\tdelay = ' + s.delay.join(',') + '\n';
		if (s.loop) desc += '\tloop = ' + s.loop + '\n';
		if (s.rewind) desc += '\trewind = ' + s.rewind + '\n';
		if (s.movement) desc += '\tmovement = 1\n';
		for (const p of s.px) {
			const sx = (k % cols) * ic.w, sy = Math.floor(k / cols) * ic.h;
			for (let y = 0; y < ic.h; y++) p.copy(sheet, ((sy + y) * W + sx) * 4, y * ic.w * 4, (y + 1) * ic.w * 4);
			k++;
		}
	}
	desc += '# END DMI\n';
	return encodePng(W, H, sheet, { Description: desc });
}

// per-pixel helpers on one frame
function eachFrame(ic, f) { for (const s of ic.states) s.px = s.px.map(p => f(p, ic.w, ic.h)); }
// add / subtract change the colour only: the icon keeps its own transparency (with an icon on top, the less
// opaque of the two). Adding to alpha too turned every transparent pixel solid: SS13 tints body parts with
// Blend(skin colour, ICON_ADD), and mobs came out as squares.
function blendPixel(d, i, r, g, b, a, mode, icon = false) {
	if (mode === 0) { d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + g); d[i + 2] = Math.min(255, d[i + 2] + b); if (icon) d[i + 3] = Math.min(d[i + 3], a); }
	else if (mode === 1) { d[i] = Math.max(0, d[i] - r); d[i + 1] = Math.max(0, d[i + 1] - g); d[i + 2] = Math.max(0, d[i + 2] - b); if (icon) d[i + 3] = Math.min(d[i + 3], a); }
	else if (mode === 4) { d[i] = d[i] * r / 255; d[i + 1] = d[i + 1] * g / 255; d[i + 2] = d[i + 2] * b / 255; d[i + 3] = d[i + 3] * a / 255; }
	else { // overlay: src over dst
		const sa = a / 255, da = d[i + 3] / 255, oa = sa + da * (1 - sa);
		if (oa <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
		d[i] = (r * sa + d[i] * da * (1 - sa)) / oa; d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa; d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa; d[i + 3] = oa * 255;
	}
}
function blendColor(ic, c, mode) {
	eachFrame(ic, p => { const d = Buffer.from(p); for (let i = 0; i < d.length; i += 4) blendPixel(d, i, c[0], c[1], c[2], c[3], mode); return d; });
}
// Blend(icon): frames are matched by state name, dir and frame where the source has them, else its first
function blendIcon(ic, src, mode, ox = 1, oy = 1) {
	const pick = (s, n) => {
		const t = src.states.find(q => q.name === s.name) || src.states[0];
		if (!t) return null;
		const dir = n % s.dirs, frame = Math.floor(n / s.dirs);
		return t.px[(Math.min(frame, t.frames - 1)) * t.dirs + (dir < t.dirs ? dir : 0)];
	};
	for (const s of ic.states) s.px = s.px.map((p, n) => {
		const q = pick(s, n), d = Buffer.from(p);
		if (!q) return d;
		for (let y = 0; y < ic.h; y++) for (let x = 0; x < ic.w; x++) {
			// x, y are 1-based from the bottom-left in BYOND
			const sx = x - (ox - 1), syb = (ic.h - 1 - y) - (oy - 1), sy = src.h - 1 - syb;
			if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) { if (mode === 4) d[(y * ic.w + x) * 4 + 3] = 0; continue; }
			const j = (sy * src.w + sx) * 4;
			blendPixel(d, (y * ic.w + x) * 4, q[j], q[j + 1], q[j + 2], q[j + 3], mode, true);
		}
		return d;
	});
}
function remap(ic, w, h, f) { // f(x, y) -> source [x, y] or null, per destination pixel
	for (const s of ic.states) s.px = s.px.map(p => {
		const d = Buffer.alloc(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const at = f(x, y);
			if (!at || at[0] < 0 || at[1] < 0 || at[0] >= ic.w || at[1] >= ic.h) continue;
			p.copy(d, (y * w + x) * 4, (at[1] * ic.w + at[0]) * 4, (at[1] * ic.w + at[0]) * 4 + 4);
		}
		return d;
	});
	ic.w = w; ic.h = h;
}

async function buildDdmi(buf, loadResource) {
	if (buf.toString('latin1', 0, 4) !== 'DDMI') throw new Error('not DDMI');
	const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
	let o = 8;
	const stack = [];
	const u8 = () => buf[o++], u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; }, f32 = () => { const v = buf.readFloatLE(o); o += 4; return v; };
	const icon = v => (v && v.icon ? v.icon : null);
	while (o < end) {
		const op = u8();
		if (op === 0x01) { stack.push({ file: buf.readUInt32LE(o) }); o += 4; }
		else if (op === 0x08) stack.push(null);
		else if (op === 0x05) { const z = buf.indexOf(0, o); stack.push({ str: buf.toString('utf8', o, z) }); o = z + 1; }
		else if (op === 0x03) { stack.push({ color: [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]] }); o += 4; }
		else if (op === 0x40) {
			const dir = u8(), frame = u8(), moving = u8();
			let state = null, file = null;
			while (stack.length) { const v = stack.pop(); if (v && v.str !== undefined && state === null) state = v.str; else if (v && (v.file !== undefined || v.icon)) { file = v; break; } }
			let src = null;
			if (file && file.icon) src = file.icon;
			else if (file) { const r = await loadResource(file.file); src = Buffer.isBuffer(r) ? loadDmi(r) : loadDmi(r.data, r.id); }
			if (!src) throw new Error('icon() without a file');
			// the chosen state only is copied (its frames are cut from the sheet now), or every state for a whole file
			let chosen = src.states;
			if (state !== null) {
				const want = src.states.filter(s => s.name === state);
				const one = want.find(s => moving === 0xff ? !s.movement : !!s.movement === !!moving) || want[0];
				chosen = one ? [{ ...one, name: '' }] : [];
			}
			const ic = { w: src.w, h: src.h, states: chosen.map(s => ({ ...s, px: s.px.slice() })) };
			if (dir !== 0xff) for (const s of ic.states) { s.px = Array.from({ length: s.frames }, (_, f) => s.px[f * s.dirs + (dir < s.dirs ? dir : 0)]); s.dirs = 1; }
			if (frame !== 0xff) for (const s of ic.states) { const f = Math.min(frame, s.frames - 1); s.px = s.px.slice(f * s.dirs, (f + 1) * s.dirs); s.frames = 1; s.delay = []; }
			stack.push({ icon: ic });
		} else if (op === 0x42 || op === 0x4d) {
			const mode = u8(), x = op === 0x4d ? u16() : 1, y = op === 0x4d ? u16() : 1;
			const src = stack.pop(), dst = icon(stack[stack.length - 1]);
			if (!dst) throw new Error('Blend without an icon');
			if (src && src.color) blendColor(dst, src.color, mode); else if (icon(src)) blendIcon(dst, icon(src), mode, x, y);
		} else if (op === 0x41) {
			const dir = u8(), frame = u8(), delay = f32(), moving = u8();
			const name = stack.pop(), src = icon(stack.pop()), dst = icon(stack[stack.length - 1]);
			if (!dst || !src) throw new Error('Insert without icons');
			const s = src.states[0];
			if (s) dst.states = dst.states.filter(q => q.name !== (name && name.str) || dir !== 0xff || frame !== 0xff).concat([{ ...s, name: name ? name.str : '', movement: moving ? 1 : 0, delay: delay > 0 ? [delay] : s.delay }]);
		} else if (op === 0x43) {
			const k = [f32(), f32(), f32()];
			eachFrame(icon(stack[stack.length - 1]), p => { const d = Buffer.from(p); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (k[c] >= 0) d[i + c] = Math.min(255, d[i + c] * k[c]); return d; });
		} else if (op === 0x44) {
			const d = DIRS[u8()] || 0, ic = icon(stack[stack.length - 1]);
			const fx = d & 12, fy = d & 3;
			remap(ic, ic.w, ic.h, (x, y) => [fx ? ic.w - 1 - x : x, fy ? ic.h - 1 - y : y]);
		} else if (op === 0x45) {
			const ang = f32() * Math.PI / 180, ic = icon(stack[stack.length - 1]), cx = (ic.w - 1) / 2, cy = (ic.h - 1) / 2;
			const c = Math.cos(ang), s = Math.sin(ang); // clockwise on screen (y down)
			remap(ic, ic.w, ic.h, (x, y) => { const dx = x - cx, dy = y - cy; return [Math.round(cx + dx * c + dy * s), Math.round(cy - dx * s + dy * c)]; });
		} else if (op === 0x47) {
			const d = DIRS[u8()] || 0, n = u16(), wrap = u8(), ic = icon(stack[stack.length - 1]);
			const dx = d & 4 ? n : d & 8 ? -n : 0, dy = d & 1 ? -n : d & 2 ? n : 0; // rows go down
			remap(ic, ic.w, ic.h, (x, y) => { let sx = x - dx, sy = y - dy; if (wrap) { sx = (sx % ic.w + ic.w) % ic.w; sy = (sy % ic.h + ic.h) % ic.h; } return [sx, sy]; });
		} else if (op === 0x48) {
			u8();
			const to = stack.pop(), from = stack.pop(), ic = icon(stack[stack.length - 1]);
			if (to && from && to.color && from.color) eachFrame(ic, p => { const d = Buffer.from(p); for (let i = 0; i < d.length; i += 4) if (d[i] === from.color[0] && d[i + 1] === from.color[1] && d[i + 2] === from.color[2] && d[i + 3] === from.color[3]) to.color.forEach((v, c) => { d[i + c] = v; }); return d; });
		} else if (op === 0x4a) {
			const n = u8(), m = Array.from({ length: n }, f32), ic = icon(stack[stack.length - 1]);
			// rows of 3 (rgb) or 4 (rgba) inputs, then the constant row
			const w = n === 12 || n === 9 ? 3 : 4, rows = n / w;
			eachFrame(ic, p => {
				const d = Buffer.from(p);
				for (let i = 0; i < d.length; i += 4) {
					const v = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255], out = [0, 0, 0, w === 3 ? v[3] : 0];
					for (let r = 0; r < rows; r++) for (let c = 0; c < w; c++) out[c] += (r < w ? v[r] : 1) * m[r * w + c];
					for (let c = 0; c < 4; c++) d[i + c] = Math.max(0, Math.min(255, Math.round(out[c] * 255)));
				}
				return d;
			});
		} else if (op === 0x49) {
			const x1 = u16(), y1 = u16(), x2 = u16(), y2 = u16(), col = stack.pop(), ic = icon(stack[stack.length - 1]);
			if (col && col.color) eachFrame(ic, (p, w, h) => {
				const d = Buffer.from(p);
				for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
					if (x < 1 || y < 1 || x > w || y > h) continue;
					const i = ((h - y) * w + (x - 1)) * 4; col.color.forEach((v, c) => { d[i + c] = v; });
				}
				return d;
			});
		} else if (op === 0x4b) {
			const w = u16(), h = u16(), ic = icon(stack[stack.length - 1]), ow = ic.w, oh = ic.h;
			remap(ic, w, h, (x, y) => [Math.floor(x * ow / w), Math.floor(y * oh / h)]);
		} else if (op === 0x4c) {
			const x1 = u16(), y1 = u16(), x2 = u16(), y2 = u16(), ic = icon(stack[stack.length - 1]);
			remap(ic, x2 - x1, y2 - y1, (x, y) => [x + x1, y + y1]);
		} else throw new Error('DDMI op ' + op.toString(16) + ' at ' + (o - 1));
	}
	const top = icon(stack[stack.length - 1]);
	if (!top) throw new Error('DDMI left no icon');
	return saveDmi(top);
}

module.exports = { buildDdmi, decodeSheet };
