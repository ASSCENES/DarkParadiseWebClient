// Client-side map state, mirroring DreamSeeker's handlers:
//   type 62 (0x100485A0): u16 maxx, u16 maxy, u16 bufW, u16 bufH, ... view info
//   type 97 / 18 / 20 (0x10047730; 20 as the eye moves): u16 x0, u16 y0, u16 z, then bufW*bufH turf appearance ids, row-major from the
//            bottom row. Cells already covered by the previous window (same z) or outside the world are not sent.
//            Token: u32 id, or 0xFFFFFFFF + u8 n = previous id for this cell and the next n cells.
//   type 38: appearance definitions (appearance.js)
const { Reader } = require('./reader');
const { parseAppearance } = require('./appearance');

class MapState {
	constructor() {
		this.maxx = 0; this.maxy = 0;
		this.bufW = 0; this.bufH = 0;
		this.x0 = 0; this.y0 = 0; this.z = -1;
		this.turfs = new Map();       // "x,y" (0-based world coords) -> appearance id
		this.appearances = new Map(); // id -> appearance
		this.resources = [];          // index -> { id, type } (type 14 list)
		this.wideVerbs = true;        // from server hello flags (bit 1)
	}

	handle(type, data) {
		switch (type) {
			case 14: return this.onResources(data);
			case 38: { const a = parseAppearance(data, { wideVerbs: this.wideVerbs }); this.appearances.set(a.id, a); return a; }
			case 62: return this.onMapSize(data);
			// 20 comes as the eye moves (the window scrolls by a few tiles), in the same format as 97
			case 18: case 20: case 97: return this.onTurfs(data, type === 18);
		}
	}

	onResources(d) {
		for (let o = 0; o + 5 <= d.length; o += 5) this.resources.push({ id: d.readUInt32LE(o), type: d[o + 4] });
	}

	onMapSize(d) {
		const r = new Reader(d);
		this.maxx = r.u16(); this.maxy = r.u16();
		const w = r.u16(), h = r.u16();
		if (w !== this.bufW || h !== this.bufH) this.resized = true; // the next window comes whole
		this.bufW = w; this.bufH = h;
		this.viewInfo = [];
		while (r.left >= 2) this.viewInfo.push(r.u16());
	}

	onTurfs(d, full) {
		const r = new Reader(d);
		const px = this.x0, py = this.y0, pz = this.z;
		this.x0 = r.u16(); this.y0 = r.u16(); this.z = r.u16();
		const keep = !full && !this.resized && pz === this.z;
		this.resized = false;
		let prev = 0xffffffff, count = 0;
		for (let by = 0; by < this.bufH; by++) {
			for (let bx = 0; bx < this.bufW; bx++) {
				const wx = this.x0 + bx, wy = this.y0 + by;
				if (keep && wx >= px && wx < px + this.bufW && wy >= py && wy < py + this.bufH) continue;
				if (wx >= this.maxx || wy >= this.maxy || wx < 0 || wy < 0) continue;
				let id;
				if (count) { count--; id = prev; }
				else {
					id = r.u32();
					if (id === 0xffffffff) { id = prev; count = r.u8(); }
					else prev = id;
				}
				this.turfs.set(wx + ',' + wy, id);
			}
		}
		return { left: r.left };
	}
}

module.exports = { MapState };
