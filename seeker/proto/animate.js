// Parser for message type 240: animate(). Worked out from captures of every easing, flag, delay, loop and
// chained calls (see PROTOCOL.md).
//
// u8 target type (2 obj, 3 mob, 0x0d image), u32 ref, u16 (varies per atom), f32 start of the first step
// relative to now (ticks, <= 0), u8 calls made by this message, u8 n steps, u8 0; then n steps:
//   u32 appearance before, u32 appearance after, f32 time (ticks), i32 loop, u8 easing, u8 flags
//   [flags & 0x80: u8, u8, f32 delay (ticks)] [flags & ANIMATION_PARALLEL: u32]
//   then u32 call number + u16 for the first step of each animate() call, or only u16 for the steps chained
//   after it (animate() without a target).
// The queue holds the calls still in effect: earlier ones (already playing) and then the new ones. A new call
// without ANIMATION_END_NOW or ANIMATION_PARALLEL interrupts the earlier ones and starts from wherever they
// had got to. An empty queue stops the animation.

const PARALLEL = 4, END_NOW = 1;

function readStep(d, o) {
	if (o + 18 > d.length) return null;
	const s = { from: d.readUInt32LE(o), to: d.readUInt32LE(o + 4), time: d.readFloatLE(o + 8), loop: d.readInt32LE(o + 12), easing: d[o + 16], flags: d[o + 17], delay: 0 };
	if (s.from > 0xffffff || s.to > 0xffffff || !(s.time >= 0 && s.time < 1e6) || Math.abs(s.loop) > 1e6) return null;
	o += 18;
	if (s.flags & 0x80) { if (o + 6 > d.length) return null; s.delay = d.readFloatLE(o + 2); o += 6; }
	if (s.flags & PARALLEL) o += 4;
	s.end = o;
	return s;
}

// Steps from offset o; which steps start a call (6-byte tail) is not marked, so take the reading that uses
// every byte
function readSteps(d, o, n) {
	if (n === 0) return o === d.length ? [] : null;
	const s = readStep(d, o);
	if (!s) return null;
	for (const tail of [6, 2]) {
		if (s.end + tail > d.length) continue;
		const rest = readSteps(d, s.end + tail, n - 1);
		if (rest) return [{ ...s, call: tail === 6 ? d.readUInt32LE(s.end) : null }, ...rest];
	}
	return null;
}

function parseAnimate(d) {
	if (d.length < 14) return null;
	const steps = readSteps(d, 14, d[12]);
	if (!steps) return null; // no steps: the atom's animation stops
	// group steps into animate() calls; the first step carries the call's loop, delay and flags. A chained step
	// with ANIMATION_PARALLEL starts a sequence of its own that runs alongside the call it is chained to
	// (sub: true; it starts when that call does). SS13 balloon alerts rise in one and fade in and out in another.
	const calls = [];
	for (const s of steps) {
		const sub = s.call === null && calls.length > 0 && !!(s.flags & PARALLEL);
		if (s.call !== null || !calls.length || sub)
			calls.push({ loop: s.loop, delay: s.delay, parallel: !!(s.flags & PARALLEL), endNow: !!(s.flags & END_NOW), sub, steps: [] });
		calls[calls.length - 1].steps.push({ from: s.from, to: s.to, time: s.time, easing: s.easing });
	}
	// d[11] counts animate() calls with a target; a parallel sequence belongs to the call before it
	let fresh = 0, made = 0;
	for (let i = calls.length - 1; i >= 0 && made < d[11]; i--) { fresh++; if (!calls[i].sub) made++; }
	return { type: d[0], ref: d.readUInt32LE(1), start: d.readFloatLE(7), fresh, calls };
}

module.exports = { parseAnimate };
