// Parser for message type 38: appearance definition (client handler 0x10046620 in byondcore 516).
const { Reader } = require('./reader');

function readFilter(r) {
	const f = { type: r.u8() };
	if (!f.type) return null;
	f.index = r.u8();
	f.flags0 = r.u32();
	let flags = r.u8();
	if (flags & 0x80) { r.o--; flags = r.u32() & ~0x80; }
	if (flags & 0x1) f.x = r.f32();
	// outline, drop_shadow and bloom keep a colour here (u32 like appearance colours); the others a number
	if (flags & 0x2) { if (f.type === 2 || f.type === 3 || f.type === 14) f.rgba = r.u32(); else f.y = r.f32(); }
	if (flags & 0x4) f.size = r.f32();
	if (flags & 0x8) f.offset = r.f32();
	if (flags & 0x10) f.c = r.f32();
	if (flags & 0x20) f.u16 = r.u16();
	if (flags & 0x40) f.color = r.u32();
	if (flags & 0x100) f.icon = r.u32();
	if (flags & 0x200) f.render_source = r.str();
	if (flags & 0x400) f.matrix = Array.from({ length: 20 }, () => r.f32());
	if (flags & 0x800) f.v1 = r.u32();
	if (flags & 0x1000) f.v2 = r.u32();
	if (flags & 0x2000) f.b = r.u8();
	if (flags & 0x4000) { if (r.u8()) f.transform = Array.from({ length: 6 }, () => r.f32()); }
	f.flags = flags;
	// names by type (probed with filter(type = …) on the test world; fields follow their flag bits)
	f.kind = FILTER_KINDS[f.type] || 'unknown';
	if (f.type === 3) { // drop_shadow: bit 0 size, 1 colour, 2 x, 3 y, 4 offset (BYOND defaults otherwise)
		const size = flags & 1 ? f.x : 1, x = flags & 4 ? f.size : 1, y = flags & 8 ? f.offset : -1, offset = flags & 16 ? f.c : 0;
		Object.assign(f, { size, x, y, offset });
		delete f.c;
	}
	if (f.type === 2 && !(flags & 1)) f.x = 1; // outline: bit 0 size, 1 colour, 0x20 flags
	return f;
}
const FILTER_KINDS = [null, 'blur', 'outline', 'drop_shadow', 'motion_blur', 'wave', 'ripple', 'alpha', 'displace', 'color',
	'radial_blur', 'angular_blur', 'rays', 'layer', 'bloom'];

// opts.wideVerbs: verb ids are u32 (hello flags bit 1); other ids are u32 on 516 (bit 0).
function parseAppearance(buf, opts = {}) {
	const r = new Reader(buf);
	const wideVerbs = opts.wideVerbs !== false;
	const a = {};
	a.id = r.id();
	a.name = r.str();
	a.desc = r.str();
	a.icon = r.id();
	a.icon_state = r.str();
	a.text = r.str();
	a.maptext = r.str(); // checked against maptext set from DM and ss1984 status displays
	a.maptext_width = r.u16(); a.maptext_height = r.u16();
	a.maptext_x = r.i16(); a.maptext_y = r.i16();
	a.dir = r.u8();
	a.flags = r.u32();
	a.opacity = a.flags & 1;        // probed: an opaque wall has bit 0, a floor has not
	a.density = (a.flags >>> 1) & 1;
	// bits 12-13 (probed by setting it from DM): 0 -> mouse_opacity 1 (by pixel), 1 -> 2 (whole tile), 3 -> 0 (none)
	a.mouse_opacity = [1, 2, 1, 0][(a.flags >>> 12) & 3];
	a.override = (a.flags >>> 18) & 1;
	// probed: image(…, dir) given in the constructor keeps its own dir as an overlay (SS13 floor decals);
	// otherwise an overlay faces like its atom
	a.ownDir = (a.flags >>> 17) & 1;
	// appearance_flags sit in bits 21+ (probed: RESET_COLOR 2 -> bit 22 … PIXEL_SCALE 512 -> bit 30)
	a.appearance_flags = (a.flags >>> 21) & 0x7ff;
	a.cursors = [];
	for (let i = 0; i < 3; i++) { const k = r.u8(); a.cursors.push(k === 2 ? r.id() : null); }
	a.parent = r.id();
	const list = (wide = true) => { const n = r.u16(); return Array.from({ length: n }, () => wide ? r.id() : r.u16()); };
	a.verbs = list(wideVerbs);
	a.overlays = list();
	a.underlays = list();
	a.layer = r.f32();
	a.screen_loc = r.str();
	let f = r.u8();
	if (f & 0x80) { r.o--; f = r.u32(); }
	a.optFlags = f;
	if (f & 0x1) a.opt1 = r.u8();
	if (f & 0x2) a.opt2 = r.u8();
	if (f & 0x4) a.invisibility = r.u8(); // hidden from mobs whose see_invisible is lower
	if (f & 0x8) { a.pixel_x = r.i16(); a.pixel_y = r.i16(); a.pixel_w = r.i16(); a.pixel_z = r.i16(); }
	if (f & 0x10) a.glide_size = r.f32(); // probed: set from DM (pixels per server tick; 0 = automatic)
	if (f & 0x20) a.transform = Array.from({ length: 6 }, () => r.f32());
	if (f & 0x40) a.color = r.u32();
	if (f & 0x100) a.blend_mode = r.u8(); // probed: BLEND_ADD 2, SUBTRACT 3, MULTIPLY 4
	if (f & 0x200) a.plane = r.i16(); // FLOAT_PLANE is -32767
	if (f & 0x400) a.color_matrix = Array.from({ length: 20 }, () => r.f32());
	if (f & 0x800) {
		a.filters = [];
		let n = r.u8();
		while (n--) { const fl = readFilter(r); if (fl) a.filters.push(fl); }
	}
	if (f & 0x1000) { a.render_source = r.str(); a.render_target = r.str(); }
	if (f & 0x2000) a.vis_flags = r.u16(); // probed: VIS_INHERIT_ICON 1 … VIS_UNDERLAY 64
	if (f & 0x4000) a.flags_hi = r.u32();
	if (f & 0x8000) { a.opt8000a = r.u16(); a.opt8000b = r.u16(); }
	a._left = r.left;
	return a;
}

module.exports = { parseAppearance };
