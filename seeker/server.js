// BYOND browser client gateway ("seeker").
// Speaks the native DreamSeeker protocol to Dream Daemon and streams decoded state to browsers over WebSocket.
//
// usage: node server.js --dd 127.0.0.1:51984 --rsc path\to\world.rsc [--rsc world.dyn.rsc] [--port 8080]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { ByondConnection } = require('./proto/byond-conn');
const { MapState } = require('./proto/mapstate');
const { parseObjects, findMobBlock } = require('./proto/objects');
const { parseAnimate } = require('./proto/animate');
const zlib = require('zlib');
const { Rsc, parseRsc } = require('./proto/rsc');
const { crc: resourceCrc, decipher } = require('./proto/rsccrypt');
const { readDmiMeta } = require('./dmi');
const { buildDdmi } = require('./ddmi');
const { decodePng, encodePng } = require('./png');
const { fontFamily, hasGlyph } = require('./font');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const optAll = name => args.flatMap((a, i) => a === '--' + name ? [args[i + 1]] : []);
// --dd host:port ties the gateway to one server; without it each page names its server (?server=host:port)
const fixedServer = opt('dd', null);
// "byond://host:port/" or "host:port" -> "host:port", or null when it is not an address ("?…" after it: see loginTopic)
function serverAddress(text) {
	const m = String(text || '').trim().replace(/^byond:\/\//i, '').replace(/\?.*$/s, '').replace(/\/+$/, '').match(/^([a-z0-9.-]{1,253}):(\d{1,5})$/i);
	return m && +m[2] > 0 && +m[2] < 65536 ? m[1].toLowerCase() + ':' + +m[2] : null;
}
const httpPort = +opt('port', 8080);
const rscFiles = optAll('rsc');

// Type 26 login payload DreamSeeker sends with no BYOND pager running (guest login).
// It starts with the connection topic ("?a=b", NUL-terminated; here empty).
const GUEST_LOGIN = Buffer.from('00007ecc5a2e893573d76d976cb5f6001174096f7f4556aebd6c201f2c2de94284a7660df17f2081cc1a0000000000', 'hex');
// Servers that admit guests only with a single-use ticket from their web gateway, passed in the connection topic
// (byond://host:port?dpweb=<ticket>): Dark Paradise lets Seeker in this way. A fresh ticket for every login.
const GUEST_TICKETS = { '92.63.189.21:7777': 'https://serverhostdarkparadise.ru/webtest/auth/key',
	...JSON.parse(process.env.SEEKER_GUEST_TICKETS || '{}') };
// own: parameters the player gave on the page (byond://host:port?launcher_token=…), "" or "?…"
async function guestTopic(target, own = '') {
	const url = GUEST_TICKETS[target];
	if (!url) return own;
	const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
	if (!r.ok) throw new Error('HTTP ' + r.status);
	const { key } = await r.json();
	if (!/^dpweb-v1:[0-9a-f]{32}$/.test(key || '')) throw new Error('unexpected ticket');
	return (own ? own + '&' : '?') + 'dpweb=' + key;
}
// Connection parameters from the page (the topic of byond://host:port?topic): one line of text, as "?…"
function loginTopic(text) {
	const t = String(text || '').trim().replace(/^\?+/, '');
	return t && t.length <= 2000 && !/[\x00-\x1f]/.test(t) ? '?' + t : '';
}

// ---------- resources ----------
const archives = rscFiles.map(f => ({ file: f, rsc: new Rsc(f), indexedAt: Date.now() }));
const metaCache = new Map();
function dmiMeta(e) {
	let meta = metaCache.get(e.id);
	if (!meta) { try { meta = readDmiMeta(e.data); } catch (err) { meta = { error: String(err) }; } metaCache.set(e.id, meta); }
	return meta;
}

// One frame of an icon resource as a PNG: q has state, dir (BYOND number), frame (from 1) and movement;
// a state the icon lacks falls back to its unnamed state. Plain images come back whole.
const DIR_INDEX = { 2: 0, 1: 1, 4: 2, 8: 3, 6: 4, 10: 5, 5: 6, 9: 7 };
function iconFrame(e, q) {
	const meta = dmiMeta(e);
	if (meta.error || !meta.states) return e.data.readUInt32BE(0) === 0x89504e47 ? e.data : null;
	const name = q.get('state') || '', movement = q.get('movement') === 'true' || q.get('movement') === '1';
	const st = meta.states.find(s => s.name === name && !s.movement === !movement) || meta.states.find(s => s.name === name)
		|| meta.states.find(s => s.name === '') || (name ? null : meta.states[0]);
	if (!st) return null;
	const dir = DIR_INDEX[+q.get('dir') || 2] || 0, frame = Math.max(0, Math.min(st.frames - 1, (+q.get('frame') || 1) - 1));
	const n = st.offset + frame * st.dirs + (dir < st.dirs ? dir : 0);
	let px;
	try { px = decodePng(e.data); } catch (_) { return null; }
	const { width: w, height: h, cols } = meta, sx = (n % cols) * w, sy = Math.floor(n / cols) * h;
	if (sx + w > px.width || sy + h > px.height) return null;
	const out = Buffer.alloc(w * h * 4);
	for (let y = 0; y < h; y++) px.data.copy(out, y * w * 4, ((sy + y) * px.width + sx) * 4, ((sy + y) * px.width + sx + w) * 4);
	return encodePng(w, h, out);
}
function findResource(id) {
	for (const a of archives) { const e = a.rsc.get(id); if (e) return e; }
	// the dynamic archive (*.dyn.rsc) grows while the world runs: reindex it, at most every second (it takes ~10 ms;
	// the main archive never changes, and some ids never turn up: icons the client builds itself)
	for (const a of archives) {
		if (!/\.dyn\.rsc$/i.test(a.file) || Date.now() - a.indexedAt < 1000) continue;
		if (a.rsc.fd !== null) fs.closeSync(a.rsc.fd);
		a.rsc = new Rsc(a.file); a.indexedAt = Date.now();
		const e = a.rsc.get(id); if (e) return e;
	}
	return cachedResource(id);
}

// Resources the server sends (message 60 asks, 159 "resources" brings them), deciphered and kept on disk by
// id: with no --rsc every icon and sound comes from here, with --rsc whatever the archives lack. Ids are the
// files' CRCs, so one cache serves every server.
const CACHE = path.resolve(opt('cache', path.join(__dirname, 'cache')));
fs.mkdirSync(CACHE, { recursive: true });
const hex8 = id => (id >>> 0).toString(16).padStart(8, '0');
const cached = new Map(); // id -> resource type
for (const f of fs.readdirSync(CACHE)) { const m = f.match(/^([0-9a-f]{8})_(\d+)$/); if (m) cached.set(parseInt(m[1], 16) >>> 0, +m[2]); }
function cachedResource(id) {
	if (builtIcons.has(id)) return builtIcons.get(id);
	const type = cached.get(id);
	if (type === 12) return null; // a run-time icon's recipe: built again for the session that lists it
	if (type === undefined) return null;
	try { return { id, type, data: fs.readFileSync(path.join(CACHE, hex8(id) + '_' + type)) }; } catch (_) { return null; }
}
// Transfers already taken apart (by the transfer's crc), so a server that sends its whole .rsc at login
// (preload_rsc) is told we have it the next time
const TRANSFERS = path.join(CACHE, 'transfers.txt');
const doneTransfers = new Set(fs.existsSync(TRANSFERS) ? fs.readFileSync(TRANSFERS, 'utf8').split('\n').filter(Boolean) : []);
const resWaiters = new Map(); // id -> [resolve]
const resFetchers = new Set(); // live sessions' id -> bool (false: that server has not listed the id)
// Icons built from a world's run-time recipes (DDMI) refer to that world's resource list: kept in memory only
const builtIcons = new Map(); // id -> { id, type, data }
function storeResource(id, type, data, persist = true) {
	if (!persist) builtIcons.set(id, { id, type, data });
	else if (!cached.has(id)) {
		fs.writeFileSync(path.join(CACHE, hex8(id) + '_' + type), data);
		cached.set(id, type);
	}
	const list = resWaiters.get(id);
	resWaiters.delete(id);
	for (const done of list || []) done({ id, type, data });
}
// A resource from the archives or the cache, else asked from the server; null after ms without it
function fetchResource(id, ms = 20000) {
	const e = findResource(id);
	if (e) return Promise.resolve(e);
	return new Promise(resolve => {
		let list = resWaiters.get(id);
		if (!list) {
			resWaiters.set(id, list = []);
			let asked = false;
			for (const ask of resFetchers) if ((asked = ask(id))) break;
			if (!asked && process.env.SEEKER_DEBUG_RES) console.log('resource ' + hex8(id) + ' is not listed by any session');
		}
		list.push(resolve);
		setTimeout(() => {
			const l = resWaiters.get(id), i = l ? l.indexOf(resolve) : -1;
			if (i >= 0) { l.splice(i, 1); if (!l.length) resWaiters.delete(id); }
			if (i >= 0 && process.env.SEEKER_DEBUG_RES) console.log('resource ' + hex8(id) + ' did not come (' + resFetchers.size + ' sessions)');
			resolve(null);
		}, ms);
	});
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// Browser windows load their files by name; names are registered per session by message 254.
const sessions = new Map(); // sid -> { assets: Map(name -> rsc id) }
let nextSid = 1;

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	// debugging aid: the page can POST a PNG of the map canvas, saved as $SEEKER_SNAP_DIR/<name>.png
	if (process.env.SEEKER_SNAP_DIR && req.method === 'POST' && url.pathname === '/__snap') {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const name = (url.searchParams.get('name') || 'snap').replace(/[^\w-]/g, '');
		fs.writeFileSync(path.join(process.env.SEEKER_SNAP_DIR, name + '.png'), Buffer.concat(chunks));
		res.writeHead(204); return res.end();
	}
	// debugging aid (local only): what the open pages are drawing, from their own state
	if (url.pathname === '/__dump' && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '')) {
		const live = [...sessions.values()].filter(s => s.dump);
		const out = await Promise.all(live.map(s => new Promise(done => { s.dump(done); setTimeout(() => done(null), 3000); })));
		res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		return res.end(JSON.stringify(out, null, 1));
	}
	// Pages send a Topic by XHR GET "?params" or by navigating to "?params" (DreamSeeker intercepts both);
	// relative to <base> it lands here. 204 keeps a navigating page where it is, as DreamSeeker does.
	const tm = url.pathname.match(/^\/a\/(\d+)\/$/);
	if (tm && url.search.length > 1) {
		const sess = sessions.get(+tm[1]);
		if (sess && sess.topic) sess.topic(url.search);
		res.writeHead(204);
		return res.end();
	}
	// "[0xc000020]?state=s&dir=2&frame=1&movement=false": a world resource by its ref (tgui's DmIcon, from the
	// icon_ref_map asset), drawn as one frame of the icon, as DreamSeeker's browser does
	const rm = decodeURIComponent(url.pathname).match(/^\/a\/(\d+)\/\[0xc([0-9a-f]+)\]$/i);
	if (rm) {
		const sess = sessions.get(+rm[1]);
		const r = sess && sess.resource && sess.resource(parseInt(rm[2], 16));
		const e = r && await fetchResource(r.id);
		const png = e && iconFrame(e, url.searchParams);
		if (!png) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
		res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
		return res.end(png);
	}
	const am = url.pathname.match(/^\/a\/(\d+)\/(.+)$/);
	if (am) {
		const sess = sessions.get(+am[1]);
		const want = decodeURIComponent(am[2]);
		const lookup = () => {
			let name = want;
			if (sess && !sess.files.has(name) && !sess.assets.has(name) && sess.aliases.has(name)) name = sess.aliases.get(name);
			const sent = sess && sess.files.get(name); // files the server pushed with message 159 / browse(file=)
			const id = sess && sess.assets.get(name);
			return sent ? { data: sent } : id !== undefined && fetchResource(id);
		};
		let e = await lookup();
		// tgui may ask for a file before the server's asset/mappings message arrives: give it a moment
		for (let i = 0; !e && sess && i < 10; i++) { await new Promise(r => setTimeout(r, 200)); e = await lookup(); }
		if (!e) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); } // may appear in .dyn.rsc soon
		const ext = path.extname(am[2]).toLowerCase();
		const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
		res.writeHead(200, { 'Content-Type': (types[ext] || 'application/octet-stream') + (/^\.(js|css|html)$/.test(ext) ? '; charset=utf-8' : '') });
		return res.end(e.data);
	}
	// sounds (and any other resource) by .rsc id; the type is sniffed from the file's first bytes
	const sm = url.pathname.match(/^\/res\/([0-9a-f]+)$/);
	if (sm) {
		const e = await fetchResource(parseInt(sm[1], 16) >>> 0);
		if (!e) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
		const head = e.data.toString('latin1', 0, 4);
		const type = head === 'OggS' ? 'audio/ogg' : head === 'RIFF' ? 'audio/wav' : head.startsWith('ID3') || (e.data[0] === 0xff && (e.data[1] & 0xe0) === 0xe0) ? 'audio/mpeg'
			: head === '\0\x01\0\0' || head === 'true' ? 'font/ttf' : head === 'OTTO' ? 'font/otf' : 'application/octet-stream';
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
		return res.end(e.data);
	}
	let m = url.pathname.match(/^\/icon\/([0-9a-f]+)\.(png|json|rgba)$/);
	if (m) {
		const id = parseInt(m[1], 16) >>> 0;
		const e = await fetchResource(id);
		if (!e) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); } // may appear in .dyn.rsc soon
		if (m[2] === 'rgba') { // straight (not premultiplied) pixels: u32 width, u32 height, then RGBA rows
			let px;
			try { px = decodePng(e.data); } catch (err) { res.writeHead(415); return res.end(String(err.message)); }
			const head = Buffer.alloc(8);
			head.writeUInt32LE(px.width, 0); head.writeUInt32LE(px.height, 4);
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
			return res.end(Buffer.concat([head, px.data]));
		}
		if (m[2] === 'png') {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
			return res.end(e.data);
		}
		const meta = dmiMeta(e);
		res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' });
		return res.end(JSON.stringify(meta));
	}
	const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
	if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		// Chrome's preload scanner may fetch a window's script before applying its <base>: find it in a session
		const bare = decodeURIComponent(url.pathname.slice(1));
		if (/^[^/]+$/.test(bare)) for (const s of sessions.values()) {
			const id = s.assets.get(bare), e = s.files.get(bare) ? { data: s.files.get(bare) } : id !== undefined && findResource(id);
			if (!e) continue;
			res.writeHead(200, { 'Content-Type': MIME[path.extname(bare)] || 'application/octet-stream' });
			return res.end(e.data);
		}
		res.writeHead(404); return res.end('not found');
	}
	res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
	fs.createReadStream(file).pipe(res);
});

// ---------- sessions ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
	// Messages decoded from one read of the server's socket (one server tick, usually) go to the page in one
	// frame, so it never draws half a tick: SS13 projectiles step a tile in one message and pull their pixel
	// offset back in the next.
	let outbox = [];
	const flush = () => {
		const batch = outbox; outbox = [];
		if (batch.length && ws.readyState === 1) ws.send(JSON.stringify(batch.length === 1 ? batch[0] : batch));
	};
	const send = obj => {
		outbox.push(obj);
		if (outbox.length === 1) setImmediate(flush);
	};
	const closeWs = (...args) => { flush(); ws.close(...args); };
	const wsQuery = new URL(req.url, 'http://x').searchParams;
	const target = fixedServer || serverAddress(wsQuery.get('server'));
	const ownTopic = loginTopic(wsQuery.get('login') || (String(wsQuery.get('server') || '').match(/\?(.*)$/s) || [])[1]);
	if (!target) { send({ t: 'needServer' }); closeWs(4001, 'no server'); return; }
	const [ddHost, ddPort] = target.split(':');
	send({ t: 'server', addr: target, fixed: !!fixedServer });
	let conn = null;
	let map = new MapState();
	const sid = nextSid++;
	const sess = { server: target, assets: new Map(), windows: new Set(), files: new Map(), aliases: new Map() };
	const transfers = new Map(); // crc -> { name, size, action, chunks }
	// Topics go out at most TOPIC_RATE a second, and the same one again within a second is dropped: SS13 worlds
	// ignore a client's 11th Topic in a second ("слишком много действий за секунду"), and at login the stat
	// panel answers each of several init_verbs with a Send-Tabs per tab, dozens at once. Nothing else is lost,
	// it only waits its turn.
	const TOPIC_RATE = 8;
	const topicQueue = [], topicSent = [];
	let topicTimer = null;
	const pumpTopics = () => {
		topicTimer = null;
		const now = Date.now();
		while (topicSent.length && now - topicSent[0] >= 1000) topicSent.shift();
		while (topicQueue.length && topicSent.length < TOPIC_RATE) {
			if (conn) conn.send(129, Buffer.from(topicQueue.shift() + '\0', 'utf8'));
			else topicQueue.shift();
			topicSent.push(now);
		}
		if (topicQueue.length) topicTimer = setTimeout(pumpTopics, 1000 - (now - topicSent[0]) + 5);
	};
	sess.topic = q => {
		if (topicQueue.includes(q)) return; // the same one still waiting
		topicQueue.push(q);
		if (!topicTimer) pumpTopics();
	};
	sess.resource = i => map.resources[i];
	// Every page logs in with the same guest key, and the server drops the older login, sometimes without saying
	// so (no message 0): that page would reconnect and drop the newer one, over and over, across browsers.
	// The gateway sees all pages, so the newest wins here: older pages are told before their login is taken.
	sess.kick = () => {
		console.log('[' + sid + '] replaced by a newer page');
		send({ t: 'kicked' });
		if (conn) { conn.removeAllListeners(); conn.on('error', () => {}); conn.close(); }
		closeWs(4000, 'replaced');
	};
	for (const other of sessions.values()) if (other.kick && other.server === target) other.kick();
	sess.dump = answer => { sess.dumped = answer; send({ t: 'dump' }); };
	const verbs = new Map(); // lower-case verb name -> id
	const verbDefs = new Map(); // verb id -> { id, name, category, srcSetting, flags, args: [{ types, source }] }
	const me = { ref: null, pos: null };
	const eye = { x: null, y: null }; // client.eye position from message 7
	const mobs = new Map(); // mob ref -> { x, y, app } from message 7
	// Open alert()/input() dialogs by id. Choice lists (63) and resolved picks (57) carry no id: they answer
	// our requests in order, so each request queues a callback.
	const dialogs = new Map();
	const measures = new Map(), measureAnswers = new Map(); // MeasureText ids waiting for the page: timer, answer
	const listWait = [], valueWait = [];
	const screen = []; // client.screen refs in list order (removals come by index)
	const flickKinds = new Map(); // flick key (199) -> atom kind for the following 108

	// Message 11 (u32 mob refs) asks for mob info; the server answers with one message 9 (ref, appearance, u8)
	// per mob. DreamSeeker asks for every mob it sees in updates but has no info for yet. A 9 we did not ask
	// for is the server telling us which mob is ours.
	const knownMobs = new Set(), mobAsked = new Map(), mobWanted = new Set();
	function wantMob(ref) {
		if (ref === undefined || ref === me.ref || knownMobs.has(ref)) return;
		const t = mobAsked.get(ref);
		if (t && Date.now() - t < 5000) return;
		mobWanted.add(ref);
		if (mobWanted.size === 1) setImmediate(() => {
			const refs = [...mobWanted].filter(r => !knownMobs.has(r));
			mobWanted.clear();
			if (!refs.length) return;
			const b = Buffer.alloc(refs.length * 4);
			refs.forEach((r, i) => { b.writeUInt32LE(r, i * 4); mobAsked.set(r, Date.now()); });
			conn.send(11, b);
		});
	}

	// Message 60 (u32 indexes into the resource list of message 14) asks for resources, as DreamSeeker does for
	// files missing from its cache. The server answers with 159 transfers (action load_rsc): one resource comes
	// as a file of its own name whose transfer crc is its id, several as a gzipped .rsc fragment "resources".
	const resIndex = new Map(); // resource id -> index in map.resources
	const resAsked = new Map(); // id -> when asked, in asking order
	let resQueue = [];
	const askResource = id => {
		const i = resIndex.get(id);
		if (i === undefined || !conn) return false;
		const t = resAsked.get(id);
		if (t && Date.now() - t < 15000) return true;
		resAsked.delete(id); resAsked.set(id, Date.now());
		resQueue.push(i);
		if (resQueue.length === 1) setImmediate(() => {
			const b = Buffer.alloc(resQueue.length * 4);
			resQueue.forEach((v, k) => b.writeUInt32LE(v, k * 4));
			resQueue = [];
			conn.send(60, b);
		});
		return true;
	};
	resFetchers.add(askResource);
	// a run-time icon (type 12) comes as a recipe over the world's own resources: built into a DMI here
	const tookResource = (id, type, data) => {
		resAsked.delete(id);
		if (type !== 12) return storeResource(id, type, data);
		buildDdmi(data, async i => {
			const r = map.resources[i], e = r && await fetchResource(r.id);
			if (!e) throw new Error('resource #' + i + ' did not come');
			return e.data;
		}).then(png => storeResource(id, 3, png, false), err => console.log('[' + sid + '] run-time icon ' + hex8(id) + ': ' + err.message));
	};
	// Entries of a "resources" fragment; enciphered ones (type | 0x80) are keyed by their real id, which their
	// header hides: they come in the order asked (or of the list, when the server sends its whole .rsc at
	// login), and the CRC of the result tells a right guess. Returns whether we had asked for them.
	function takeResources(buf) {
		const entries = parseRsc(buf);
		const asked = [...resAsked.keys()], all = map.resources.map(r => r.id);
		let solicited = entries.length > 0, next = 0;
		for (const e of entries) {
			if (!(e.type & 0x80)) { tookResource(e.id, e.type, Buffer.from(e.data)); continue; }
			const guess = list => {
				for (let k = 0; k < list.length; k++) {
					const id = list[(next + k) % list.length];
					if (cached.has(id) && !resWaiters.has(id)) continue;
					const data = decipher(e.data, id);
					if (resourceCrc(data) !== id) continue;
					tookResource(id, e.type & 0x7f, data);
					next = (next + k + 1) % list.length;
					return true;
				}
				return false;
			};
			if (guess(asked)) continue;
			solicited = false;
			next = 0;
			if (!guess(all)) console.log('[' + sid + '] resource ' + e.name + ' (' + e.data.length + ' bytes) matched no listed id');
		}
		return solicited;
	}

	// Message 61 (u32 appearance ids) asks for appearance definitions the client does not have yet.
	const wanted = new Set(), asked = new Map();
	function want(id) {
		if (id === undefined || id === null || id === 0xffff || id === 0xffffffff || map.appearances.has(id)) return;
		const t = asked.get(id);
		if (t && Date.now() - t < 5000) return;
		wanted.add(id);
		if (wanted.size === 1) setImmediate(flushWanted);
	}
	function flushWanted() {
		const ids = [...wanted].filter(id => !map.appearances.has(id));
		wanted.clear();
		for (let i = 0; i < ids.length; i += 200) {
			const chunk = ids.slice(i, i + 200), b = Buffer.alloc(chunk.length * 4);
			chunk.forEach((id, j) => { b.writeUInt32LE(id, j * 4); asked.set(id, Date.now()); });
			conn.send(61, b);
		}
	}

	// Verb call (message 2): u16 2, verb id, u8 src type (1 obj, 2 mob, 3 turf, 8 client), u32 src ref, u8 argc,
	// args as tagged values (00 type ref: an atom, 01 f32, 02 text\0, 06 null)
	function sendVerb(id, srcType, srcRef, args) {
		const idb = Buffer.alloc(map.wideVerbs ? 4 : 2);
		map.wideVerbs ? idb.writeUInt32LE(id) : idb.writeUInt16LE(id);
		const src = Buffer.alloc(5); src[0] = srcType; src.writeUInt32LE(srcRef >>> 0, 1);
		conn.send(2, Buffer.concat([Buffer.from([2, 0]), idb, src, Buffer.from([args.length]), ...args]));
	}
	const atomArg = (type, ref) => { const b = Buffer.alloc(6); b[1] = type; b.writeUInt32LE(ref >>> 0, 2); return b; };
	const textArg = s => Buffer.from('\x02' + s + '\0', 'utf8');
	const NULL_ARG = Buffer.from([6]);

	// Right-click menu of an atom, as DreamSeeker builds it: the atom's own verbs (src = the atom) and our verbs
	// whose only argument takes this kind of atom (src = us, the atom as argument). Hidden and "." verbs are left out.
	const TYPE_BITS = { 1: 0x02, 2: 0x01, 3: 0x20 }; // atom type in commands -> input type mask (obj, mob, turf)
	function atomMenu(atom, app) {
		const shown = def => def && def.name && !def.name.startsWith('.') && !(def.flags & 0x81);
		const items = [], seen = new Set();
		const add = (def, mode) => { if (!shown(def) || seen.has(def.name)) return; seen.add(def.name); items.push({ id: def.id, name: def.name, mode }); };
		const own = app !== undefined && map.appearances.get(app);
		for (const id of (own && own.verbs) || []) add(verbDefs.get(id), 'src');
		const bit = TYPE_BITS[atom.type];
		const mine = [me.app, me.clientApp].map(a => a !== undefined && map.appearances.get(a)).filter(Boolean);
		for (const a of mine) for (const id of a.verbs || []) {
			const def = verbDefs.get(id);
			if (def && def.args.length === 1 && (def.args[0].types & bit)) add(def, 'arg');
		}
		return items.sort((p, q) => p.name.localeCompare(q.name));
	}

	function callVerb(name, args = []) {
		const id = verbs.get(name.toLowerCase());
		if (id === undefined) return false;
		const parts = [Buffer.from([2, 0])];
		const idb = Buffer.alloc(map.wideVerbs ? 4 : 2);
		map.wideVerbs ? idb.writeUInt32LE(id) : idb.writeUInt16LE(id);
		// src: our mob (type 2) for verbs its appearance lists, otherwise the client (type 8)
		const mobApp = me.app !== undefined && map.appearances.get(me.app);
		const src = Buffer.alloc(5);
		if (mobApp && mobApp.verbs && mobApp.verbs.includes(id)) { src[0] = 2; src.writeUInt32LE(me.ref, 1); }
		else { src[0] = 8; src.writeUInt32LE(1, 1); }
		parts.push(idb, src, Buffer.from([args.length]));
		if (process.env.SEEKER_DEBUG) console.log('[' + sid + '] verb', name, id, 'src', src.toString('hex'), 'meApp', me.app, mobApp ? mobApp.verbs.length + ' mob verbs' : 'no mob app');
		for (const a of args) {
			if (typeof a === 'number') { const f = Buffer.alloc(5); f[0] = 1; f.writeFloatLE(a, 1); parts.push(f); } // num: 01 + f32
			else parts.push(Buffer.from([2]), Buffer.from(String(a) + '\0', 'utf8'));                           // text: 02 + str\0
		}
		conn.send(2, Buffer.concat(parts));
		return true;
	}
	sessions.set(sid, sess);
	send({ t: 'session', sid });
	let nines = 0;

	function openConn() {
		const c = conn = new ByondConnection(ddHost, +ddPort);
		let topic = '';
		c.on('ready', info => {
			map.wideVerbs = info.wideVerbs;
			send({ t: 'status', text: 'connected' });
			// the login opens with the connection topic (byond://host:port?topic), as client/New's TopicData
			c.send(26, Buffer.concat([Buffer.from(topic, 'latin1'), GUEST_LOGIN]));
		});
		c.on('message', onMessage);
		c.on('bad', (type, enc) => { if (process.env.SEEKER_DEBUG) console.log('[' + sid + '] BAD', type, enc.length, enc.subarray(0, 16).toString('hex')); });
		const opened = Date.now();
		c.on('close', () => {
			console.log('[' + sid + '] server closed the connection after ' + Math.round((Date.now() - opened) / 1000) + ' s');
			send({ t: 'status', text: 'disconnected' }); closeWs();
		});
		c.on('error', err => { console.log('[' + sid + '] connection error: ' + err.message); send({ t: 'status', text: 'error: ' + err.message }); });
		guestTopic(target, ownTopic).then(t => { topic = t; if (conn === c) c.connect(); }, err => {
			console.log('[' + sid + '] guest ticket: ' + err.message);
			send({ t: 'status', text: 'сервер не выдал билет гостя: ' + err.message }); closeWs();
		});
	}

	function onMessage(type, d) {
		if (process.env.SEEKER_DUMP)
			fs.appendFileSync(process.env.SEEKER_DUMP, JSON.stringify({ sid, t: Date.now(), type, hex: d.toString('hex') }) + '\n');
		if (process.env.SEEKER_DEBUG && ![106, 38, 14].includes(type))
			console.log('[' + sid + '] <<', type, d.length, JSON.stringify(d.subarray(0, 120).toString('utf8').replace(/[\x00-\x1f]/g, '|')));
		try { handle(type, d); } catch (err) {
			send({ t: 'log', text: 'type ' + type + ': ' + err.message });
			if (process.env.SEEKER_ERRORS) fs.appendFileSync(process.env.SEEKER_ERRORS, JSON.stringify({ type, err: err.message, hex: d.toString('hex') }) + '\n');
		}
	}
	openConn();

	function handle(type, d) {
		switch (type) {
			case 0: // the server dropped us (e.g. the same key logged in elsewhere): the browser must not auto-retry
				send({ t: 'kicked', code: d.length >= 2 ? d.readUInt16LE(0) : null });
				break;
			case 9: { // mob info: u32 ref, u32 appearance, u8. Unrequested, it names the mob we control.
				const ref = d.readUInt32LE(0);
				const requested = mobAsked.has(ref);
				mobAsked.delete(ref);
				knownMobs.add(ref);
				if (++nines === 1) {
					mobAsked.set(ref, Date.now()); // DreamSeeker asks once for its own mob too
					conn.send(11, d.subarray(0, 4)); conn.send(13, Buffer.from('7f00', 'hex')); conn.send(25);
				}
				if (!requested && me.ref !== ref) { me.ref = ref; me.pos = null; send({ t: 'me', ref }); }
				if (ref === me.ref) me.app = d.readUInt32LE(4); // our mob's appearance: its verbs list tells mob verbs apart
				break;
			}
			case 14: { // resources the server will refer to by index; ask for those the browser is waiting for
				const from = map.resources.length;
				// DreamSeeker sends 183 once the first resource list is in; sent right after the login, some
				// servers drop the connection
				if (!from) conn.send(183);
				map.handle(type, d);
				for (let i = from; i < map.resources.length; i++) {
					const id = map.resources[i].id;
					resIndex.set(id, i);
					if (resWaiters.has(id) && !findResource(id)) askResource(id);
					// fonts in the world's resources are installed, as DreamSeeker does: maptext names them in CSS
					if (map.resources[i].type === 14) fetchResource(id).then(e => {
						let family = null;
						let cyrillic = false;
						try { family = e && fontFamily(e.data); cyrillic = !!family && hasGlyph(e.data, 0x416); } catch (_) {}
						if (family) send({ t: 'font', family, url: '/res/' + hex8(id), cyrillic });
					});
				}
				break;
			}
			case 17: { // verb definition: id, name\0, desc\0, category\0, u16 src setting (0xff: usr), u8 flags,
				// [flags 0x80: u32], u8 argc, argc × {u32 type mask, u16 source}
				const id = map.wideVerbs ? d.readUInt32LE(0) : d.readUInt16LE(0);
				const [name, , category, o] = cstrings(d, map.wideVerbs ? 4 : 2, 3);
				verbs.set(name.toLowerCase(), id);
				const def = { id, name, category, args: [] };
				try {
					def.srcSetting = d.readUInt16LE(o); def.flags = d[o + 2];
					let p = o + 3 + (def.flags & 0x80 ? 4 : 0);
					for (let n = d[p++]; n > 0; n--, p += 6) def.args.push({ types: d.readUInt32LE(p), source: d.readUInt16LE(p + 4) });
				} catch (_) {}
				verbDefs.set(id, def);
				break;
			}
			case 56: me.clientApp = d.readUInt32LE(0); break; // the client's appearance: its verbs are client verbs
			case 175: { // the skin's macros as .dmf text; SS13 opens the verb menu while Shift holds map.right-click=false
				const text = d.toString('utf8');
				if (/name\s*=\s*"SHIFT"[\s\S]{0,80}right-click=false/.test(text)) send({ t: 'shiftMenu' });
				// the map control's stylesheet: maptext classes (.maptext, .center, .small…) and their fonts
				for (const elem of text.split(/\n(?=\s*elem\s)/)) {
					if (!/\btype\s*=\s*MAP\b/.test(elem)) continue;
					const m = elem.match(/\bstyle\s*=\s*"((?:[^"\\]|\\.)*)"/);
					if (m) send({ t: 'mapstyle', css: m[1].replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n') });
				}
				break;
			}
			case 38: {
				const a = map.handle(type, d);
				const res = map.resources[a.icon];
				a.iconRsc = res ? res.id.toString(16) : null;
				const { verbs: _verbs, ...forBrowser } = a; // the browser does not need verb lists; keep them here
				send({ t: 'app', a: forBrowser });
				for (const id of a.overlays) want(id);
				for (const id of a.underlays) want(id);
				break;
			}
			case 62: map.handle(type, d); send({ t: 'size', maxx: map.maxx, maxy: map.maxy, bufW: map.bufW, bufH: map.bufH, viewInfo: map.viewInfo }); break;
			case 118: { // client.screen as a list: blocks of [u8 op][u16 end offset]; op 1 removes {u32 index, u16 count},
				// op 2 appends and op 3 changes the appearance of {u8 type, u32 ref, u16 serial, u32 appearance}
				const touched = new Map(), before = new Set(screen);
				let o = 0;
				while (o + 3 <= d.length) {
					const op = d[o], end = d.readUInt16LE(o + 1);
					let p = o + 3;
					while (p < end) {
						if (op === 1) { screen.splice(d.readUInt32LE(p), d.readUInt16LE(p + 4)); p += 6; }
						else if (op === 2 || op === 3) {
							const it = { type: d[p], ref: d.readUInt32LE(p + 1), app: d.readUInt32LE(p + 7) };
							if (op === 2) screen.push(it.ref);
							touched.set(it.ref, it); p += 11;
						} else break;
					}
					if (end <= o) break;
					o = end;
				}
				const now = new Set(screen);
				const add = [...touched.values()].filter(it => now.has(it.ref));
				const del = [...before].filter(ref => !now.has(ref));
				send({ t: 'screen', add, del });
				for (const it of add) want(it.app);
				break;
			}
			case 18: case 20: case 97: { // turf windows; 20 scrolls the window as the eye moves
				const before = map.z;
				const changed = [];
				const set = map.turfs.set.bind(map.turfs);
				map.turfs.set = (k, v) => { changed.push([k, v]); return set(k, v); };
				map.handle(type, d);
				map.turfs.set = set;
				send({ t: 'turfs', z: map.z, x0: map.x0, y0: map.y0, bufW: map.bufW, bufH: map.bufH, reset: before !== map.z, cells: changed.map(([k, v]) => { const [x, y] = k.split(',').map(Number); return [x, y, v]; }) });
				for (const [, v] of changed) want(v);
				break;
			}
			case 241: { // turf changes: u16 n, then by column n turf indexes, n appearances, n areas; then maybe
				// u16 m, m × (u32 area, u32 appearance). Each column is run-length coded: u32 0xffffffff, u8 k means
				// the value before it k + 1 more times. index = x + y * maxx + z * maxx * maxy (all 0-based); only
				// the z we show is kept
				const n = d.readUInt16LE(0), plane = map.maxx * map.maxy, cells = [];
				let o = 2;
				const column = () => {
					const out = [];
					while (out.length < n) {
						const v = d.readUInt32LE(o); o += 4;
						if (v === 0xffffffff && out.length) { const k = d[o++] + 1; for (let j = 0; j < k; j++) out.push(out[out.length - 1]); }
						else out.push(v);
					}
					return out.slice(0, n);
				};
				const idxs = column(), appsCol = column();
				for (let i = 0; i < n && plane; i++) {
					const idx = idxs[i], app = appsCol[i];
					const z = Math.floor(idx / plane), x = idx % map.maxx, y = Math.floor((idx % plane) / map.maxx);
					if (z !== map.z) continue;
					map.turfs.set(x + ',' + y, app);
					cells.push([x, y, app]);
					want(app);
				}
				if (cells.length) send({ t: 'turfset', cells });
				break;
			}
			case 51: case 53: { // client.images add (51) / change (53): u32 id, u32 appearance, u8 loc type, u32 loc ref,
				// u16 n, n × vis_contents (u8 type 2 obj / 3 mob, u32 ref); SS13 radial menus are images whose buttons
				// hang in vis_contents
				const items = [];
				for (let o = 0; o + 15 <= d.length;) {
					const it = { id: d.readUInt32LE(o), app: d.readUInt32LE(o + 4), type: d[o + 8], ref: d.readUInt32LE(o + 9), vis: [] };
					let n = d.readUInt16LE(o + 13);
					o += 15;
					while (n-- && o + 5 <= d.length) { it.vis.push({ type: d[o], ref: d.readUInt32LE(o + 1) }); o += 5; }
					items.push(it);
				}
				send({ t: 'images', add: items, del: [] });
				for (const it of items) want(it.app);
				break;
			}
			case 52: { // client.images remove: u32 ids
				const del = [];
				for (let o = 0; o + 4 <= d.length; o += 4) del.push(d.readUInt32LE(o));
				send({ t: 'images', add: [], del });
				break;
			}
			case 109: { // sound: u32 resource (0xffff: sound(null)), u8 repeat, u8 wait, u8 channel, u8 volume (0-255),
				// u8 status, u8 extra groups: 0x01 {u8 pan (0x80 centre), u8, f32 frequency, 3 bytes}, 0x02 {f32 x, y, z,
				// falloff}, 0x40 {f32 offset}
				const file = d.readUInt32LE(0), res = file !== 0xffff && map.resources[file];
				const s = { t: 'sound', rsc: res ? res.id.toString(16) : null, repeat: d[4], wait: d[5], channel: d[6], volume: d[7] / 255, status: d[8] };
				const ext = d.length > 9 ? d[9] : 0;
				let p = 10;
				if (ext & 0x01) { s.pan = (d[p] - 128) / 127; s.frequency = d.readFloatLE(p + 2); p += 9; }
				if (ext & 0x02) { s.x = d.readFloatLE(p); s.y = d.readFloatLE(p + 4); s.z = d.readFloatLE(p + 8); s.falloff = d.readFloatLE(p + 12); p += 16; }
				if (ext & 0x40 && !(ext & 0x3c) && p + 4 <= d.length) s.offset = d.readFloatLE(p); // 0x04-0x20 not seen yet
				send(s);
				break;
			}
			case 55: // u32 world tick (ms; 50 at world.fps 20), u32
				if (d.length >= 4) send({ t: 'tick', ms: d.readUInt32LE(0) });
				break;
			case 240: { // animate(): the atom's whole animation queue
				const a = parseAnimate(d);
				if (!a) { console.log('[' + sid + '] animate not understood: ' + d.toString('hex', 0, 80)); break; }
				send({ t: 'animate', ...a });
				for (const c of a.calls) for (const s of c.steps) { want(s.from); want(s.to); }
				break;
			}
			case 199: // comes before flick(): u8 atom type (2 obj, 3 mob), u32 ref, u16 key, u32
				flickKinds.set(d.readUInt16LE(5), d[0] === 3 ? 'mob' : 'obj');
				break;
			case 108: { // flick(): u8, icon_state \0, u8, u32 ref, u32 icon resource (0: the atom's own), u16 key (as in 199)
				const z = d.indexOf(0, 1);
				const ref = d.readUInt32LE(z + 2), icon = d.readUInt32LE(z + 6), key = d.readUInt16LE(z + 10);
				const res = icon && map.resources[icon];
				send({ t: 'flick', kind: flickKinds.get(key) || 'obj', ref, state: d.toString('utf8', 1, z), iconRsc: res ? res.id.toString(16) : null });
				flickKinds.delete(key);
				break;
			}
			case 216: { // vis_contents: u16 n; per atom u8 type (1 turf: u16 x,y,z + u32 appearance; else u32 ref), u16 k, k × (u8 type, u32 ref)
				const items = [];
				let o = 2, n = d.readUInt16LE(0);
				while (n-- && o < d.length) {
					const it = { type: d[o++] };
					if (it.type === 1) { it.x = d.readUInt16LE(o); it.y = d.readUInt16LE(o + 2); it.z = d.readUInt16LE(o + 4); it.app = d.readUInt32LE(o + 6); o += 10; }
					else { it.ref = d.readUInt32LE(o); o += 4; }
					let k = d.readUInt16LE(o); o += 2;
					it.vis = [];
					while (k--) { it.vis.push({ type: d[o], ref: d.readUInt32LE(o + 1) }); o += 5; }
					items.push(it);
				}
				send({ t: 'vis', items });
				break;
			}
			case 8: {
				const o = parseObjects(d);
				send({ t: 'objs', kind: 'obj', o });
				for (const e of o.appearance) want(e.appearance);
				break;
			}
			case 36: { // object info: u32 ref, u32 appearance
				const ref = d.readUInt32LE(0), app = d.readUInt32LE(4);
				send({ t: 'objs', kind: 'obj', o: { del: [], pos: [], next: [], dir: [], appearance: [{ ref, appearance: app }], step: [] } });
				want(app);
				break;
			}
			case 7: {
				const o = findMobBlock(d, sightHeaderEnd(d));
				if (!o) break;
				const sight = parseSight(d, o.start);
				if (sight) send({ t: 'sight', ...sight });
				// header flags 0x02 / 0x04: u16 x / u16 y of client.eye (then a second u16, same so far); the turf
				// window is centred on it. It moves with our mob, a followed mob, a camera console…
				const f = d[0];
				if (f & 0x02) eye.x = d.readUInt16LE(1);
				if (f & 0x04) eye.y = d.readUInt16LE(f & 0x02 ? 5 : 1);
				send({ t: 'objs', kind: 'mob', o });
				for (const e of o.appearance) want(e.appearance);
				for (const e of o.pos) { mobs.set(e.ref, { ...mobs.get(e.ref), x: e.x, y: e.y }); if (e.ref === me.ref) me.pos = e; wantMob(e.ref); }
				for (const e of o.appearance) { mobs.set(e.ref, { ...mobs.get(e.ref), app: e.appearance }); wantMob(e.ref); if (e.ref === me.ref) me.app = e.appearance; }
				for (const e of o.del) mobs.delete(e.ref);
				// A 9 tells which mob is ours only when we did not ask about that mob; after a change of mob (lobby ->
				// observer, ghosting, body swap) we may already have asked. The eye follows our mob, so a mob standing
				// right at the eye while our old one is not there is the new one.
				if (f & 0x06) {
					const at = r => { const m = mobs.get(r); return m && m.x === eye.x && m.y === eye.y; };
					if (!at(me.ref)) {
						const here = [...mobs.keys()].filter(at);
						if (here.length === 1) { me.ref = here[0]; me.app = mobs.get(here[0]).app; send({ t: 'me', ref: me.ref }); }
					}
					send({ t: 'eye', x: eye.x, y: eye.y });
				}
				break;
			}
			case 254: { // browse_rsc: u32 resource index, file name
				const idx = d.readUInt32LE(0), name = d.toString('utf8', 4, d.indexOf(0, 4));
				const r = map.resources[idx];
				if (r) sess.assets.set(name, r.id);
				break;
			}
			case 132: { // browse(): html \0 params
				const z = d.indexOf(0);
				let html = d.toString('utf8', 0, z < 0 ? d.length : z);
				const params = z < 0 ? '' : d.toString('utf8', z + 1, d.indexOf(0, z + 1));
				const file = (params.match(/(?:^|[;&])file=([^;&]*)/) || [])[1];
				const winParam = (params.match(/(?:^|[;&])window=([^;&]*)/) || [])[1];
				// browse(text, "file=name") stores a file in the client cache; display=0 (or no window) means just that
				if (file) sess.files.set(decodeURIComponent(file), Buffer.from(html, 'utf8'));
				if (file && (!winParam || /(?:^|[;&])display=0/.test(params))) break;
				const win = winParam || 'browser';
				if (!html && winParam) { send({ t: 'browse', win, close: true }); break; } // browse(null, "window=X") closes X
				sess.windows.add(win);
				html = patchHtml(html, win, sid);
				send({ t: 'browse', win, html, params });
				break;
			}
			case 159: onFile(d); break;
			case 167: { // output(data, "control:function")
				const z = d.indexOf(0);
				const data = d.toString('utf8', 0, z);
				send({ t: 'output', data, target: d.toString('utf8', z + 1, d.indexOf(0, z + 1)) });
				// tgui "asset/mappings" maps logical file names to the asset.<md5> names registered by message 254
				if (data.includes('asset%2fmappings') || data.includes('asset/mappings')) {
					try {
						const msg = JSON.parse(decodeURIComponent(data.replace(/\+/g, ' ')));
						for (const [from, to] of Object.entries(msg.payload || {})) sess.aliases.set(from, String(to));
					} catch (_) {}
				}
				break;
			}
			case 168: { // winset(control, params)
				const z = d.indexOf(0);
				send({ t: 'winset', control: d.toString('utf8', 0, z), params: d.toString('utf8', z + 1, d.indexOf(0, z + 1)) });
				break;
			}
			case 169: { // winget / winexists: control \0 params \0 u32 id; reply value \0 u32 id
				const z1 = d.indexOf(0), z2 = d.indexOf(0, z1 + 1);
				const control = d.toString('utf8', 0, z1), params = d.toString('utf8', z1 + 1, z2), id = d.readUInt32LE(z2 + 1);
				const value = winget(control, params);
				if (process.env.SEEKER_DEBUG) console.log('[' + sid + '] winget', JSON.stringify([control, params, id]), '->', JSON.stringify(value));
				const reply = Buffer.alloc(Buffer.byteLength(value) + 5);
				reply.write(value, 0); reply.writeUInt32LE(id, Buffer.byteLength(value) + 1);
				conn.send(169, reply);
				break;
			}
			case 146: { // alert(): u32 id, message \0, title \0, u16 n, n × button \0
				const id = d.readUInt32LE(0);
				const [msg, title, rest] = cstrings(d, 4, 2);
				const n = d.readUInt16LE(rest);
				const buttons = cstrings(d, rest + 2, n).slice(0, n);
				dialogs.set(id, { kind: 'alert' });
				send({ t: 'dialog', id, kind: 'alert', title, msg, buttons });
				break;
			}
			case 98: { // input(): title \0, default \0, message \0, u32 type mask, u16 source (0x4000 "in list"), u32 id
				const [title, def, msg, o] = cstrings(d, 0, 3);
				const types = d.readUInt32LE(o), source = d.readUInt16LE(o + 4), id = d.readUInt32LE(o + 6);
				const base = { id, title, msg, def, canCancel: !!(types & 0x80) };
				if (source & 0x4000) { // choices come from the list: u8 0, u32 id, u32 0 -> 63
					const q = Buffer.alloc(9); q.writeUInt32LE(id, 1); conn.send(100, q);
					listWait.push(choices => { dialogs.set(id, { kind: 'list' }); send({ t: 'dialog', ...base, kind: 'list', choices }); });
				} else if (types & 0x123 && !(types & 0x80c)) { // mob/obj/turf/area: candidate names for the type mask
					const q = Buffer.alloc(5); q.writeUInt32LE(types, 0); conn.send(124, q);
					listWait.push(choices => { dialogs.set(id, { kind: 'atom', types }); send({ t: 'dialog', ...base, kind: 'list', choices }); });
				} else if (types & 0x2080c || types & 0x8000) {
					const kind = types & 0x800 ? 'message' : types & 0x8 ? 'num' : types & 0x20000 ? 'color' : types & 0x8000 ? 'password' : 'text';
					dialogs.set(id, { kind });
					send({ t: 'dialog', ...base, kind });
				} else { // files, icons, sounds: nothing to pick in a browser, so cancel
					dialogs.set(id, { kind: 'text' }); answerDialog(id, null);
				}
				break;
			}
			case 63: { // u16 n, n × name \0
				const n = d.readUInt16LE(0);
				const cb = listWait.shift(); if (cb) cb(cstrings(d, 2, n).slice(0, n));
				break;
			}
			case 57: { // resolved pick: value (u8 type, u32 ref), u32
				const cb = valueWait.shift(); if (cb) cb(d.subarray(0, 5));
				break;
			}
			case 252: { // client.MeasureText(): text\0, style\0, u16 width, u32 id; DreamSeeker answers u16 width,
				// u16 height, u32 id. SS13 runechat waits for it before showing a message over a head. The size is an
				// estimate fitted to DreamSeeker (41 characters in 112 px -> 112x46): ~7 px per character, 15 px a line.
				// The page measures it with the fonts and layout it draws maptext with; without an answer in time the
				// estimate goes.
				const [text, , o] = cstrings(d, 0, 2);
				const width = d.readUInt16LE(o) || 112, id = d.readUInt32LE(o + 2);
				const plain = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, 'x');
				const perLine = Math.max(1, Math.floor(width / 7));
				const lines = plain.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
				const answer = (w, h) => {
					if (!measures.has(id)) return;
					clearTimeout(measures.get(id));
					measures.delete(id);
					const reply = Buffer.alloc(8);
					reply.writeUInt16LE(Math.min(width, Math.max(1, Math.round(w))), 0); reply.writeUInt16LE(Math.max(1, Math.round(h)), 2); reply.writeUInt32LE(id, 4);
					conn.send(252, reply);
				};
				measures.set(id, setTimeout(() => answer(Math.min(width, plain.length * 7), lines * 15 + 1), 300));
				measureAnswers.set(id, answer);
				send({ t: 'measure', id, text, width });
				break;
			}
			case 39: {
				const end = d.indexOf(0);
				send({ t: 'out', html: d.toString('utf8', 0, end < 0 ? d.length : end) });
				break;
			}
			default: // a message type this gateway does not know yet: logged once, to find what is missing
				if (!unknownTypes.has(type)) {
					unknownTypes.add(type);
					console.log('[' + sid + '] unhandled message ' + type + ' (' + d.length + ' bytes): ' + d.toString('hex', 0, 64) + ' ' + JSON.stringify(d.toString('latin1', 0, 64).replace(/[^\x20-\x7e]/g, '.')));
				}
		}
	}
	const unknownTypes = new Set([10, 32, 59, 106, 113, 114, 141, 200, 202, 203, 226, 239]); // seen, not needed

	// File transfer (message 159). Header (seq 0): u32 crc, u32 -1, u32 0, u32 2, u8 1, u32 size, u8 type,
	// name\0, "##action=...;..."\0 [u8 1, u32 gzipped size]. A resource's file has the resource id as crc, and
	// type | 0x80 when it is enciphered. The client answers [crc][-1][01] when it has the file cached, or
	// [crc][-1][00][u32 1] to have it sent; data follows as seq 1..n: [crc][-1][u32 seq][u32 2][u32 offset][bytes].
	function onFile(d) {
		const crc = d.readUInt32LE(0), seq = d.readUInt32LE(8);
		const reply = tail => conn.send(159, Buffer.concat([d.subarray(0, 4), Buffer.from('ffffffff', 'hex'), tail]));
		if (seq === 0) {
			const size = d.readUInt32LE(17);
			const z1 = d.indexOf(0, 22), z2 = d.indexOf(0, z1 + 1);
			const name = d.toString('utf8', 22, z1);
			const action = d.toString('utf8', z1 + 1, z2 < 0 ? d.length : z2);
			// after the action: u8 1, u32 length on the wire when the file comes gzipped
			const gz = z2 > 0 && d[z2 + 1] === 1 && z2 + 6 <= d.length;
			const wire = gz ? d.readUInt32LE(z2 + 2) : size;
			// load_rsc: a resource for the cache, or "resources", an .rsc fragment of several
			const load = /load_rsc/.test(action), rsc = load && name === 'resources';
			// (icons the world builds at run time come as load_rsc with no name: see ddmi.js)
			if ((!name && !load) || size === 0 || (rsc && doneTransfers.has(hex8(crc))) || (load && !rsc && cached.has(crc))) { reply(Buffer.from([1])); return; }
			const have = !rsc && sess.files.get(name);
			if (have && have.crc === crc) { doFileAction(name, have, action); reply(Buffer.from([1])); return; }
			transfers.set(crc, { name, type: d[21], size: wire, gz, rsc, load, action, data: Buffer.alloc(wire), got: 0 });
			reply(Buffer.from([0, 1, 0, 0, 0]));
			return;
		}
		const tr = transfers.get(crc);
		if (!tr) return;
		const offset = d.readUInt32LE(16), chunk = d.subarray(20);
		chunk.copy(tr.data, offset);
		tr.got += chunk.length;
		if (tr.got < tr.size) return;
		transfers.delete(crc);
		let data = tr.data;
		if (tr.gz) try { data = zlib.gunzipSync(data); } catch (err) { console.log('[' + sid + '] transfer ' + tr.name + ': ' + err.message); return; }
		if (tr.rsc) {
			if (!takeResources(data)) { doneTransfers.add(hex8(crc)); fs.appendFileSync(TRANSFERS, hex8(crc) + '\n'); }
			return;
		}
		if (tr.type & 0x80) data = decipher(data, crc);
		if (tr.load && resourceCrc(data) === crc) tookResource(crc, tr.type & 0x7f, data);
		sess.files.set(tr.name, data);
		sess.files.get(tr.name).crc = crc;
		doFileAction(tr.name, data, tr.action);
	}

	// Answers a dialog the way DreamSeeker does. alert(): u32 id, button \0. input() (message 98): u8 kind, value,
	// u32 id, where kind 2 is text \0, 1 is f32, 0 is a resolved value (u8 type, u32 ref; type 0 is null).
	function answerDialog(id, value) {
		const dlg = dialogs.get(id);
		if (!dlg) return;
		dialogs.delete(id);
		const idb = Buffer.alloc(4); idb.writeUInt32LE(id >>> 0);
		const str = s => Buffer.from(String(s) + '\0', 'utf8');
		const reply = (...parts) => conn.send(98, Buffer.concat([...parts, idb]));
		if (dlg.kind === 'alert') { conn.send(146, Buffer.concat([idb, str(value === null ? '' : value)])); return; }
		if (value === null) { reply(Buffer.alloc(6)); return; }
		if (dlg.kind === 'num') { const f = Buffer.alloc(5); f[0] = 1; f.writeFloatLE(Number(value) || 0, 1); reply(f); return; }
		if (dlg.kind === 'list' || dlg.kind === 'atom') {
			// the pick goes back by name and returns as a value (57): lists send name \0, u32 id, u32 0 (99),
			// atoms u32 type mask, name \0 (45)
			if (dlg.kind === 'list') { const t = Buffer.alloc(8); t.writeUInt32LE(id >>> 0); conn.send(99, Buffer.concat([str(value), t])); }
			else { const t = Buffer.alloc(4); t.writeUInt32LE(dlg.types >>> 0); conn.send(45, Buffer.concat([t, str(value)])); }
			valueWait.push(v => reply(Buffer.from([0]), v));
			return;
		}
		reply(Buffer.from([2]), str(value));
	}

	// "##action=browse_file;options=window%3dX" / "##action=output_file;window=X" show an HTML file in a window
	function doFileAction(name, data, action) {
		const p = new URLSearchParams(action.replace(/^#+/, '').replace(/;/g, '&'));
		const act = p.get('action');
		if (act !== 'browse_file' && act !== 'output_file') return;
		if (!/\.html?$/i.test(name)) return;
		const params = act === 'browse_file' ? (p.get('options') || '') : 'window=' + (p.get('window') || 'browser');
		const win = (params.match(/(?:^|[;&])window=([^;&]*)/) || [])[1] || 'browser';
		sess.windows.add(win);
		send({ t: 'browse', win, html: patchHtml(data.toString('utf8'), win, sid), params });
	}

	// Answers winget/winexists the way DreamSeeker would for a client with the default skin.
	function winget(control, params) {
		if (params === '') return sess.windows.has(control) || /browser|output|statbrowser|title/.test(control) ? 'BROWSER' : 'none';
		// several controls at once ("a;b", "size") answer as "a.size=...;b.size=..."
		if (control.includes(';')) return control.split(';').map(c => c + '.' + params + '=' + winget(c, params)).join(';');
		const props = params.split(';');
		const val = p => {
			if (p === 'url') return ddHost + ':' + ddPort;
			if (p === 'dpi') return '1';
			if (p === 'is-visible') return sess.windows.has(control) ? 'true' : 'false';
			if (p === 'size') return '640x480';
			if (p === 'pos') return '0,0';
			if (p === 'is-maximized') return 'false';
			return '';
		};
		return props.length > 1 ? props.map(p => p + '=' + val(p)).join(';') : val(props[0]);
	}

	ws.on('message', raw => {
		let m; try { m = JSON.parse(raw); } catch (_) { return; }
		if (process.env.SEEKER_DEBUG) console.log('[' + sid + '] >>', String(raw).slice(0, 200));
		if (m.t === 'key' && typeof m.key === 'string') {
			// SS13 skins route every key through the keyDown/keyUp verbs; plain worlds use built-in movement
			// DreamSeeker's macro sends "KeyDown [[*]] [[map.mouse-pos]] [[map.size]]": key, mouse x/y, map width/height
			const num = (v, d) => Number.isFinite(+v) ? Math.round(+v) : d;
			const mouse = Array.isArray(m.mouse) ? m.mouse : [], size = Array.isArray(m.size) ? m.size : [];
			const args = [m.key.slice(0, 32), num(mouse[0], 240), num(mouse[1], 240), num(size[0], 480), num(size[1], 480)];
			if (!callVerb(m.down ? 'keyDown' : 'keyUp', args) && m.down && m.dir)
				conn.send(2, Buffer.from([0, 0, m.dir, 0, 0, 0xff, 0xff, 0, 0, 0]));
		} else if (m.t === 'mouse' && Array.isArray(m.cmds)) {
			// Mouse command (message 2): u16 cmd (3 click, 5 up, 6 down), verb id 0xFFFF, src atom, argc 3:
			// location atom, control text, params text. Atoms are (u8 type, u32 ref): 1 obj, 2 mob, 3 turf (x | y << 16).
			const atom = a => a ? [a.type & 0xff, a.ref >>> 0] : [0, 0xffff];
			const [st, sr] = atom(m.src), [lt, lr] = atom(m.loc);
			for (const cmd of m.cmds) {
				if (![3, 5, 6, 8].includes(cmd)) continue;
				const head = Buffer.alloc(map.wideVerbs ? 6 : 4);
				head.writeUInt16LE(cmd, 0);
				map.wideVerbs ? head.writeUInt32LE(0xffff, 2) : head.writeUInt16LE(0xffff, 2);
				const atoms = Buffer.alloc(12);
				atoms[0] = st; atoms.writeUInt32LE(sr, 1); atoms[5] = 3; // argc
				atoms[6] = 0; atoms[7] = lt; atoms.writeUInt32LE(lr, 8);
				conn.send(2, Buffer.concat([head, atoms,
					Buffer.from([2]), Buffer.from(String(m.control || 'mapwindow.map') + '\0', 'utf8'),
					Buffer.from([2]), Buffer.from(String(m.params || '') + '\0', 'utf8')]));
			}
		} else if (m.t === 'command' && typeof m.text === 'string') {
			// DreamSeeker command line: verb name (spaces typed as '-') then "quoted" args, or the rest as one text arg
			const mm = m.text.trim().match(/^(\S+)\s*([\s\S]*)$/);
			if (!mm || mm[1].startsWith('.')) return;
			const args = [];
			if (mm[2].startsWith('"')) for (const q of mm[2].matchAll(/"((?:[^"\\]|\\.)*)"?/g)) args.push(q[1].replace(/\\(.)/g, '$1'));
			else if (mm[2]) args.push(mm[2]);
			if (!callVerb(mm[1], args) && !callVerb(mm[1].replace(/-/g, ' '), args) && !(ALIASES[mm[1].toLowerCase()] || []).some(n => callVerb(n, args)))
				send({ t: 'out', html: '<span class="warning">Неизвестная команда: ' + mm[1].replace(/[<&]/g, '') + '</span>' });
		} else if (m.t === 'raw' && process.env.SEEKER_DEBUG && Number.isInteger(m.type)) {
			conn.send(m.type, Buffer.from(String(m.hex || ''), 'hex')); // debugging aid: send an arbitrary message
		} else if (m.t === 'verb' && typeof m.name === 'string') {
			callVerb(m.name, Array.isArray(m.args) ? m.args : []);
		} else if (m.t === 'topic' && typeof m.href === 'string') {
			sess.topic(m.href.replace(/^byond:\/\//, ''));
		} else if (m.t === 'drag' && m.src) {
			// MouseDrag (0x93) while the button is held, MouseDrop (0x92) on release: u16 7, verb id 0x8B + event
			// code (8 drag, 7 drop; u32 when the world has wide verb ids, as Paradise), a null src (00, u32 0xffff),
			// u8 7, then src, over_object, src_location, over_location (atoms or 06 null), src_control, over_control,
			// params. No MouseUp or Click follows a drop.
			const arg = a => a && Number.isInteger(a.type) && a.type > 0 ? atomArg(a.type, a.ref) : NULL_ARG;
			const head = Buffer.alloc(map.wideVerbs ? 12 : 10);
			head.writeUInt16LE(7, 0);
			let o = map.wideVerbs ? head.writeUInt32LE(m.drop ? 0x92 : 0x93, 2) : head.writeUInt16LE(m.drop ? 0x92 : 0x93, 2);
			head[o] = 0; head.writeUInt32LE(0xffff, o + 1); head[o + 5] = 7;
			conn.send(2, Buffer.concat([head, arg(m.src), arg(m.over), arg(m.srcLoc), arg(m.overLoc),
				textArg(String(m.srcControl || 'mapwindow.map')), textArg(String(m.overControl || 'mapwindow.map')), textArg(String(m.params || ''))]));
		} else if (m.t === 'menu' && Array.isArray(m.atoms)) {
			// everything under the cursor, top first, each with its own verbs (DreamSeeker's map popup)
			const groups = m.atoms.filter(x => x && x.atom && Number.isInteger(x.atom.type)).slice(0, 40)
				.map(x => ({ atom: x.atom, key: x.key, items: atomMenu(x.atom, x.app) })).filter(g => g.items.length);
			send({ t: 'menu', at: m.at, groups });
		} else if (m.t === 'menu' && m.atom && Number.isInteger(m.atom.type)) {
			send({ t: 'menu', at: m.at, groups: [{ atom: m.atom, items: atomMenu(m.atom, m.app) }] });
		} else if (m.t === 'menuPick' && m.atom && verbDefs.has(m.id)) {
			if (m.mode === 'src') sendVerb(m.id, m.atom.type, m.atom.ref, []);
			else if (me.ref !== null) {
				// a client verb (not in our mob's list) runs with the client as src
				const mobApp = me.app !== undefined && map.appearances.get(me.app);
				const onMob = mobApp && mobApp.verbs && mobApp.verbs.includes(m.id);
				sendVerb(m.id, onMob ? 2 : 8, onMob ? me.ref : 1, [atomArg(m.atom.type, m.atom.ref)]);
			}
		} else if (m.t === 'dumped' && sess.dumped) {
			sess.dumped(m.data);
			sess.dumped = null;
		} else if (m.t === 'measured' && measureAnswers.has(m.id)) {
			const answer = measureAnswers.get(m.id);
			measureAnswers.delete(m.id);
			answer(+m.w || 1, +m.h || 1);
		} else if (m.t === 'dialog' && Number.isInteger(m.id)) {
			answerDialog(m.id, m.value === null || m.value === undefined ? null : String(m.value));
		}
	});
	ws.on('close', (code, reason) => {
		console.log('[' + sid + '] browser closed the page socket (' + code + (reason && reason.length ? ' ' + reason : '') + ')');
		resFetchers.delete(askResource);
		conn.removeAllListeners(); conn.on('error', () => {}); conn.close(); sessions.delete(sid);
	});
});

// Usual command names for worlds whose verbs are translated (SS1984: "Сказать", "Эмоция", ...)
const ALIASES = { say: ['Сказать'], me: ['Эмоция'], whisper: ['Шепот'], ooc: ['OOC'], looc: ['LOOC'] };

// Header of message 7 (client/eye update) before the mob sections, as far as it is known (field sizes fitted to
// headers from a test world with set values and from ss1984; the meaning of most fields is not known yet):
//   u8 flags; 0x02: u16 ×2; 0x04: u16 ×2; if any of 0x1e: a 22-byte block;
//   0x08: u16; 0x10: u16; 0x20: u8 sight; 0x40: 9 bytes; 0x80: u8 more flags, then 0x01: u8 see_in_dark,
//   0x02: u8 see_invisible. Returns null unless the parse ends exactly where the mob sections start.
function parseSight(d, end) {
	const f = d[0];
	let o = 1;
	if (f & 0x02) o += 4;
	if (f & 0x04) o += 4;
	if (f & 0x1e) o += 22;
	if (f & 0x08) o += 2;
	if (f & 0x10) o += 2;
	const out = {};
	if (f & 0x20) out.sight = d[o++];
	if (f & 0x40) o += 9;
	if (f & 0x80) {
		const g = d[o++];
		if (g & 0x01) out.seeInDark = d[o++];
		if (g & 0x02) out.seeInvisible = d[o++];
		if (g & ~0x03) return out.seeInvisible === undefined ? null : out; // later fields unknown: trust what came first
	}
	return o === end && Object.keys(out).length ? out : null;
}

// Where the mob block of a type 7 message starts, from its header flags (as parseSight walks them); null when
// the header has fields not known yet.
function sightHeaderEnd(d) {
	const f = d[0];
	let o = 1;
	if (f & 0x02) o += 4;
	if (f & 0x04) o += 4;
	if (f & 0x1e) o += 22;
	if (f & 0x08) o += 2;
	if (f & 0x10) o += 2;
	if (f & 0x20) o++;
	if (f & 0x40) o += 9;
	if (f & 0x80) {
		const g = d[o++];
		if (g & ~0x03) return null;
		if (g & 0x01) o++;
		if (g & 0x02) o++;
	}
	return o < d.length ? o : null;
}

// Reads n zero-terminated UTF-8 strings from offset; returns them followed by the offset after the last one.
function cstrings(d, off, n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		let z = d.indexOf(0, off); if (z < 0) z = d.length;
		out.push(d.toString('utf8', off, z)); off = z + 1;
	}
	out.push(off);
	return out;
}

// Makes a BYOND browser-control page work inside an iframe: tgui only talks to BYOND when it believes it runs on
// 127.0.0.1, and sends everything through window.cef_to_byond when that exists.
function patchHtml(html, win, sid) {
	html = html.replace(/location\.hostname===?"127\.0\.0\.1"/g, 'true');
	// plain pages navigate to byond:// links directly (asset cache confirmations etc.)
	html = html.replace(/(?:window\.)?location(?:\.href)?\s*=\s*("byond:[^"]*"|'byond:[^']*')/g, 'window.cef_to_byond($1)');
	const shim = '<base href="/a/' + sid + '/"><script>(function(){' +
		'var W=' + JSON.stringify(win) + ';' +
		'window.cef_to_byond=function(u){parent.postMessage({seeker:"byond",win:W,url:String(u)},"*")};' +
		// Windows place themselves in screen pixels from window.screenLeft/Top, which inside an iframe are the
		// tab's: the page tells the frame's real place. Sizes are CSS pixels here, so the pixel ratio is 1
		// (tgui would otherwise scale positions and shrink its body by it).
		'try{Object.defineProperty(window,"devicePixelRatio",{get:function(){return 1},configurable:true})}catch(e){}' +
		'[["screenLeft","x"],["screenX","x"],["screenTop","y"],["screenY","y"]].forEach(function(k){' +
		'var d=Object.getOwnPropertyDescriptor(window,k[0])||Object.getOwnPropertyDescriptor(Window.prototype,k[0]);' +
		'try{Object.defineProperty(window,k[0],{get:function(){try{var p=parent.seekerFramePos&&parent.seekerFramePos(W);if(p)return p[k[1]]}catch(e){}' +
		'return d&&d.get?d.get.call(window):0},configurable:true})}catch(e){}});' +
		// "#..." links would resolve against <base> and leave the page: keep them in it
		'document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href");' +
		'if(h.charAt(0)==="#"){e.preventDefault();var t=h.length>1&&document.getElementById(h.slice(1));if(t)t.scrollIntoView();return}' +
		'var b=h.slice(0,6).toLowerCase()==="byond:";if(b||h.charAt(0)==="?"){e.preventDefault();window.cef_to_byond(b?h:"byond://"+h)}},true);' +
		'document.addEventListener("contextmenu",function(e){var t=e.target;if(!(t&&(t.isContentEditable||/^(INPUT|TEXTAREA)$/.test(t.tagName))))e.preventDefault()});' +
		// BYOND 516's per-hub storage; tgui keeps its settings and the chat history there and waits for it
		'if(!window.hubStorage){var P="hub:";window.hubStorage={getItem:function(k){return localStorage.getItem(P+k)},' +
		'setItem:function(k,v){try{localStorage.setItem(P+k,String(v))}catch(e){}},removeItem:function(k){localStorage.removeItem(P+k)},' +
		'clear:function(){Object.keys(localStorage).forEach(function(k){if(k.indexOf(P)===0)localStorage.removeItem(k)})}}}' +
		'})();</script>';
	// first thing after the doctype, so <base> applies to scripts that some pages put before <head>
	return html.replace(/^(\s*<!doctype[^>]*>)?/i, (m) => m + shim);
}

server.listen(httpPort, () => console.log('seeker on http://localhost:' + httpPort + ' -> ' + (fixedServer || 'server chosen on the page') + ', rsc: ' + rscFiles.join(', ')));
