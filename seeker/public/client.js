// Seeker browser client: renders the world state streamed by server.js.
'use strict';

const TILE = 32;
const VIEW = 15;               // tiles across the shorter canvas side
const FLOAT_LAYER = -1;

const state = {
	apps: new Map(),          // appearance id -> appearance
	turfs: new Map(),         // "x,y" -> appearance id (current z)
	z: -1, x0: 0, y0: 0, bufW: 0, bufH: 0,
	objs: new Map(),          // "obj:ref" / "mob:ref" -> { x, y, z, dir, app, px, py, next } (x = 0xffff: inside something)
	me: null,
	screen: new Map(),        // client.screen: ref -> { ref, type, app }
	vis: new Map(),           // vis_contents: "turf:x,y" / "obj:ref" -> [{ type, ref }]
	images: new Map(),        // client.images: id -> { id, app, type, ref } (type 1 obj, 2 mob, 7 turf by map index)
	flicks: new Map(),        // "obj:ref" / "mob:ref" -> { state, iconRsc, start }
	anims: new Map(),         // animate(): "obj:ref" / "mob:ref" / "image:id" -> { from, to, start, dur, loop }
	seeInvisible: 0,          // our mob's see_invisible (message 7): atoms with a higher invisibility are not drawn
	mapRightClick: false,     // map control right-click: true sends right clicks to the server, false opens the verb menu
	shiftMenu: false,         // the world's skin opens the verb menu while Shift is held (SS13)
	viewInfo: null,
	tickMs: 50,               // the server's tick (message 55), for glide_size
};

// ---------- connection ----------
const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
// The server comes from the page address (?server=host:port) unless the gateway is tied to one
const pageServer = new URLSearchParams(location.search).get('server');
// Connection parameters (byond://host:port?launcher_token=… in DreamSeeker) go to the login. They may be secrets,
// so they stay out of the page address and its history: kept for this tab only, sent in the socket's URL.
const LOGIN = 'seekerLogin';
let loginParams = '';
try { loginParams = (JSON.parse(sessionStorage.getItem(LOGIN)) || {})[pageServer] || ''; } catch (_) {}
// The gateway's admin token (debug mode): given once as ?admin=<token>, kept in this browser, taken out of the
// address so it does not end up in screenshots or shared links
let adminToken = '';
try {
	const u = new URL(location.href), given = u.searchParams.get('admin');
	if (given !== null) {
		if (given) localStorage.setItem('seekerAdmin', given); else localStorage.removeItem('seekerAdmin');
		u.searchParams.delete('admin');
		history.replaceState(null, '', u.pathname + u.search + u.hash);
	}
	adminToken = localStorage.getItem('seekerAdmin') || '';
} catch (_) {}
const wsArgs = [pageServer && 'server=' + encodeURIComponent(pageServer), loginParams && 'login=' + encodeURIComponent(loginParams), adminToken && 'admin=' + encodeURIComponent(adminToken)].filter(Boolean);
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (wsArgs.length ? '?' + wsArgs.join('&') : ''));
ws.onopen = () => setStatus('рукопожатие…');

// Every tab logs in with the same guest key, and a new login makes the server drop the previous one. Two tabs
// that both auto-reconnect would keep kicking each other, so: tabs of this browser hand over through a
// BroadcastChannel, and a tab dropped by the server waits for the player instead of retrying.
let standDown = false;
// code: the server's message 0 when it dropped us — 3 the same key logged in elsewhere, 1 the world deleted
// the client (a ban, a guest ban, a failed check: its reason, if any, is in the chat); none: another page here
function showElsewhere(code) {
	standDown = true;
	try { ws.close(); } catch (_) {}
	const dropped = code !== undefined && code !== null && code !== 3;
	setStatus(code === 1 ? 'сервер отключил вас: его проверки не пропустили этот вход (гостей, бан…), причина — в чате, если сервер её прислал'
		: dropped ? 'сервер отключил вас (код ' + code + ')'
		: code === 3 ? 'с этим ключом вошли в другом месте (у всех гостей Seeker пока один ключ)' : 'сессия открыта в другом окне');
	if (document.getElementById('takeover')) return;
	const b = document.createElement('button');
	b.id = 'takeover';
	b.textContent = dropped ? 'Подключиться снова' : 'Играть в этом окне';
	b.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;padding:10px 18px;font-size:15px;cursor:pointer';
	b.onclick = () => location.reload();
	document.getElementById('mapwrap').appendChild(b);
}
// Server address form: shown when the gateway leaves the choice to the page; recent addresses are remembered
// in this browser. Opening ?server=… connects (the link can be shared).
const RECENT = 'seekerServers';
function showServerForm(current) {
	standDown = true;
	try { ws.close(); } catch (_) {}
	setStatus('выберите сервер');
	if (document.getElementById('serverform')) return;
	let recent = [];
	try { recent = JSON.parse(localStorage.getItem(RECENT)) || []; } catch (_) {}
	const f = document.createElement('form');
	f.id = 'serverform';
	f.innerHTML = '<h2>Подключение к серверу</h2><label for="srvaddr">Адрес сервера</label>' +
		'<input id="srvaddr" placeholder="byond://адрес:порт" autocomplete="off" spellcheck="false" required>' +
		'<p class="err" hidden>Нужен адрес вида адрес:порт, например byond://192.168.1.10:51984</p>' +
		'<label for="srvlogin">Параметры подключения (необязательно)</label>' +
		'<input id="srvlogin" placeholder="например launcher_token=…" autocomplete="off" spellcheck="false">' +
		'<p class="hint">Как ?… в ссылке byond://адрес:порт?… — сервер получит их при входе (токен лаунчера и т. п.). ' +
		'Хранятся только в этой вкладке.</p>' +
		'<button type="submit">Подключиться</button><div class="recent"></div>';
	const input = f.querySelector('#srvaddr'), login = f.querySelector('#srvlogin');
	const err = f.querySelector('.err'), list = f.querySelector('.recent');
	input.value = current || recent[0] || '';
	login.value = loginParams;
	// a whole link pasted into the address: its ?… part is the parameters
	input.addEventListener('input', () => {
		const q = input.value.indexOf('?');
		if (q < 0) return;
		login.value = input.value.slice(q + 1);
		input.value = input.value.slice(0, q);
	});
	const go = (addr, params) => {
		const m = addr.trim().replace(/^byond:\/\//i, '').replace(/\/+$/, '');
		if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(m)) { err.hidden = false; input.focus(); return; }
		try { localStorage.setItem(RECENT, JSON.stringify([m, ...recent.filter(r => r !== m)].slice(0, 6))); } catch (_) {}
		try {
			const all = JSON.parse(sessionStorage.getItem(LOGIN)) || {};
			const p = params.trim().replace(/^\?+/, '');
			if (p) all[m] = p; else delete all[m];
			sessionStorage.setItem(LOGIN, JSON.stringify(all));
		} catch (_) {}
		location.search = '?server=' + encodeURIComponent(m);
	};
	f.onsubmit = e => { e.preventDefault(); go(input.value, login.value); };
	// opened from the game to switch: going back reconnects to the same server
	if (current) {
		const back = Object.assign(document.createElement('button'), { type: 'button', className: 'cancel', textContent: 'Отмена' });
		back.onclick = () => location.reload();
		f.querySelector('button[type=submit]').after(back);
	}
	if (recent.length) list.append(Object.assign(document.createElement('span'), { textContent: 'Недавние:' }));
	for (const r of recent) {
		const b = Object.assign(document.createElement('button'), { type: 'button', textContent: r });
		b.onclick = () => go(r, r === input.value.trim().replace(/^byond:\/\//i, '') ? login.value : '');
		list.append(b);
	}
	document.getElementById('mapwrap').appendChild(f);
	input.focus();
	input.select();
}
// a page that is not tied to one server gets a button to switch
function offerServerSwitch(addr) {
	if (document.getElementById('serverbtn')) return;
	const b = Object.assign(document.createElement('button'), { id: 'serverbtn', textContent: '⇄ ' + addr, title: 'Сменить сервер' });
	b.onclick = () => showServerForm(addr);
	document.getElementById('mapwrap').appendChild(b);
}

try {
	const bc = new BroadcastChannel('seeker');
	bc.postMessage('opened');
	bc.onmessage = e => { if (e.data === 'opened') showElsewhere(); };
} catch (_) {}

// Gateway restarted or not up yet: retry by reloading the page (the server puts the guest back into its mob).
// Drops in a row wait longer each time (3, 6, 12 … 60 s), so a connection that keeps failing cannot spin;
// a connection that lasted a minute starts over from 3 s.
const openedAt = Date.now();
ws.onclose = () => {
	if (standDown) return;
	let tries = 0;
	try {
		tries = Date.now() - openedAt > 60000 ? 0 : +sessionStorage.getItem('seekerRetries') || 0;
		sessionStorage.setItem('seekerRetries', tries + 1);
	} catch (_) {}
	let left = Math.min(60, 3 * 2 ** tries);
	const tick = () => {
		setStatus('отключено, переподключение через ' + left + ' с');
		if (left-- > 0) return void setTimeout(tick, 1000);
		// reload only once the gateway answers, otherwise the browser's error page would end the retries
		fetch('/', { cache: 'no-store' }).then(r => { if (r.ok) location.reload(); else throw 0; })
			.catch(() => { left = 3; tick(); });
	};
	tick();
};
ws.binaryType = 'arraybuffer';
ws.onmessage = e => {
	if (e.data instanceof ArrayBuffer) return void iconArrived(e.data); // an icon asked for over the socket
	if (pageRec && e.data.length < 2e6) pageRec.push([Math.round(performance.now() - pageRec.t0), 'gw', e.data]);
	const m = JSON.parse(e.data);
	if (Array.isArray(m)) for (const x of m) handle(x); else handle(m); // a batch: one server tick
};

function setStatus(t) { statusEl.textContent = t; }

// ---------- debug mode (the gateway's admins only) ----------
// Players have no lighting switch (it would be a fullbright); admins have it and "⏺ запись": a recording of the
// session for bug reports. The gateway keeps every message to and from the game server; the page keeps what it
// got from the gateway and sent to it, its errors, mouse actions and a state snapshot every few seconds. Stopping
// saves one file with both (the gateway also keeps a copy in its records/ folder).
let debugAllowed = false, pageRec = null, pageRecTimer = null;
function setDebugMode(on) {
	debugAllowed = on;
	document.getElementById('lightbtn').style.display = on ? 'inline-block' : 'none';
	if (!on) state.lighting = true;
	let b = document.getElementById('recbtn');
	if (on && !b) {
		b = Object.assign(document.createElement('button'), { id: 'recbtn', textContent: '⏺ запись', title: 'Записать всё для отладки (только для админов шлюза)' });
		b.onclick = () => (pageRec ? stopRecording() : startRecording());
		document.getElementById('mapwrap').appendChild(b);
	}
	if (b) b.style.display = on ? 'inline-block' : 'none';
}
const sendToGateway = ws.send.bind(ws);
ws.send = data => {
	if (pageRec && typeof data === 'string') pageRec.push([Math.round(performance.now() - pageRec.t0), 'page', data]);
	return sendToGateway(data);
};
for (const level of ['error', 'warn']) {
	const orig = console[level].bind(console);
	console[level] = (...a) => { if (pageRec) pageRec.push([Math.round(performance.now() - pageRec.t0), 'console.' + level, a.map(x => x instanceof Error ? x.stack : String(x)).join(' ')]); orig(...a); };
}
addEventListener('error', e => { if (pageRec) pageRec.push([Math.round(performance.now() - pageRec.t0), 'error', String(e.error && e.error.stack || e.message)]); });
function startRecording() {
	if (!debugAllowed) return;
	pageRec = Object.assign([], { t0: performance.now(), started: new Date().toISOString(), snapshots: [] });
	let n = 0;
	const snap = () => { try { const d = renderDump(); if (n++ % 6) delete d.snapshot; pageRec.snapshots.push([Math.round(performance.now() - pageRec.t0), d]); } catch (err) { pageRec.push([0, 'error', String(err.stack)]); } };
	snap();
	pageRecTimer = setInterval(snap, 5000); // a picture of the map every 30 s
	ws.send(JSON.stringify({ t: 'record', on: true }));
	const b = document.getElementById('recbtn');
	b.textContent = '⏹ стоп'; b.classList.add('on');
}
function stopRecording() {
	clearInterval(pageRecTimer);
	try { pageRec.snapshots.push([Math.round(performance.now() - pageRec.t0), renderDump()]); } catch (_) {}
	ws.send(JSON.stringify({ t: 'record', on: false }));
	const b = document.getElementById('recbtn');
	b.textContent = '… сохраняю'; b.classList.remove('on');
}
function saveRecording(server) {
	const page = pageRec;
	pageRec = null;
	const b = document.getElementById('recbtn');
	if (b) b.textContent = '⏺ запись';
	if (!page) return;
	const file = { seeker: 1, started: page.started, url: location.href, userAgent: navigator.userAgent, screen: [innerWidth, innerHeight, devicePixelRatio],
		page: page.slice(), snapshots: page.snapshots, mouse: typeof mouseLog !== 'undefined' ? mouseLog : null, server };
	const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' })),
		download: 'seeker-record-' + page.started.replace(/[:.]/g, '-') + '.json' });
	document.body.appendChild(a); a.click(); a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60000);
	notice('Запись сохранена: файл ' + a.download + ' (копия у шлюза в папке records)');
}

// The map column takes the width the view needs at the window's height; the side panel (chat) gets the rest.
function fitLayout() {
	const v = state.viewInfo, vw = v && v[2] > 0 ? v[2] : 15, vh = v && v[3] > 0 ? v[3] : 15;
	const w = Math.max(0, Math.min(innerWidth - 360, Math.round(innerHeight * vw / vh)));
	document.documentElement.style.setProperty('--mapw', w + 'px');
}
addEventListener('resize', fitLayout);
// Like DreamSeeker: the right button belongs to the game; the browser's own menu stays only in text fields
const editable = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
addEventListener('contextmenu', e => { if (!editable(e.target)) e.preventDefault(); });
fitLayout();

function handle(m) {
	switch (m.t) {
		case 'status': if (!standDown) setStatus(m.text); break;
		case 'kicked': showElsewhere(m.code); break;
		case 'log': console.warn(m.text); break;
		case 'app': state.apps.set(m.a.id, m.a); break;
		case 'size': Object.assign(state, { viewInfo: m.viewInfo, maxx: m.maxx, maxy: m.maxy }); fitLayout(); break;
		case 'screen':
			for (const ref of m.del) state.screen.delete(ref);
			for (const it of m.add) state.screen.set(it.ref, Object.assign(it, { seen: Date.now() }));
			break;
		case 'me': state.me = 'mob:' + m.ref; break;
		case 'turfs':
			if (m.reset) state.turfs.clear();
			Object.assign(state, { z: m.z, x0: m.x0, y0: m.y0, bufW: m.bufW, bufH: m.bufH });
			for (const [x, y, id] of m.cells) state.turfs.set(x + ',' + y, id);
			break;
		case 'sight':
			if (m.seeInvisible !== undefined) state.seeInvisible = m.seeInvisible;
			if (m.sight !== undefined) state.sight = m.sight; // SEE_MOBS 4, SEE_OBJS 8, SEE_TURFS 16…
			if (m.clientPixel) state.clientPixel = m.clientPixel; // client.pixel_x/y: shifts the view (render.js camera)
			break;
		case 'eye': state.eye = { x: m.x, y: m.y, onMob: m.onMob }; break;
		case 'iconFail': iconFailed(m.id); break;
		case 'turfset': for (const [x, y, id] of m.cells) state.turfs.set(x + ',' + y, id); break;
		case 'images':
			for (const id of m.del) { state.images.delete(id); state.vis.delete('image:' + id); }
			for (const it of m.add) {
				state.images.set(it.id, it);
				if (it.vis.length) state.vis.set('image:' + it.id, it.vis); else state.vis.delete('image:' + it.id);
			}
			break;
		case 'animate': {
			// the atom's queue of animate() calls (render.js plays them); the last m.fresh calls are new. A new
			// call interrupts the playing ones and goes on from where they had got to (as of now), unless it
			// is ANIMATION_PARALLEL (runs alongside) or ANIMATION_END_NOW (starts from its own first state).
			// target 5 is the client itself (its pixel_x/y: render.js camera)
			const key = m.type === 5 ? 'client' : m.type === 3 ? 'mob:' + m.ref : m.type === 2 ? 'obj:' + m.ref : 'image:' + m.ref;
			if (!m.calls.length) { state.anims.delete(key); break; }
			const now = performance.now(), cur = state.anims.get(key);
			const track = (c, start) => ({ start, delay: c.delay * 100, loop: c.loop, steps: c.steps.map(s => ({ from: s.from, to: s.to, dur: Math.max(1, s.time * 100), easing: s.easing })) });
			// animate() without a target comes as a message of its own with no new call (fresh 0): its steps go
			// on the end of the playing sequence, or, with ANIMATION_PARALLEL, start a sequence alongside it from
			// that sequence's start (SS13 balloon alerts: rise in one, fade in and out in the other)
			if (cur && m.fresh === 0) {
				for (const c of m.calls) {
					const last = cur.tracks[cur.tracks.length - 1];
					if (c.parallel || c.sub || !last) { const t = track(c, last ? (last.parent ?? last.start) : now); t.parent = last ? (last.parent ?? last.start) : now; cur.tracks.push(t); }
					else last.steps.push(...track(c, 0).steps);
				}
				break;
			}
			const old = m.calls.slice(0, m.calls.length - m.fresh), fresh = m.calls.slice(m.calls.length - m.fresh);
			// the earlier calls as they were already playing, one after another from the queue's start
			// (a parallel sequence chained to a call, c.sub, starts with that call)
			let tracks = cur ? cur.tracks : [], at = now + m.start * 100, prevStart = at;
			if (!cur) for (const c of old) {
				const t = track(c, c.sub ? prevStart : at);
				tracks.push(t);
				if (!c.sub) { prevStart = at; at += t.delay + t.steps.reduce((n, s) => n + s.dur, 0); t.start = prevStart; }
			}
			for (const c of fresh) {
				const t = track(c, now);
				if (!c.parallel && !c.sub) {
					// where the interrupted animation had got to becomes the new one's starting state
					if (!c.endNow && tracks.length) t.from = animatedProps(tracks, now);
					tracks = [];
				}
				tracks.push(t);
			}
			state.anims.set(key, { tracks, image: key.startsWith('image:') ? m.ref : null });
			break;
		}
		case 'flick': state.flicks.set(m.kind + ':' + m.ref, { state: m.state, iconRsc: m.iconRsc, start: performance.now() }); break;
		case 'objs': applyObjects(m.kind, m.o); break;
		case 'vis': // vis_contents per atom: "turf:x,y" or "obj:ref"/"mob:ref" -> [{type, ref}]
			for (const it of m.items) {
				const key = it.type === 1 ? 'turf:' + it.x + ',' + it.y : (it.type === 3 ? 'mob:' : 'obj:') + it.ref;
				if (it.vis.length) state.vis.set(key, it.vis); else state.vis.delete(key);
			}
			break;
		case 'session': state.sid = m.sid; break;
		case 'debug': setDebugMode(!!m.allowed); break;
		case 'recorded': saveRecording(m.data); break;
		case 'mapstyle': setMapStyle(m.css); break;
		case 'dump': { // debugging aid: the gateway's /__dump asks what this page draws
			let data;
			try { data = renderDump(); } catch (err) { data = { error: String(err && err.stack || err) }; }
			ws.send(JSON.stringify({ t: 'dumped', data }));
			break;
		}
		case 'measure': { // client.MeasureText(): the size the text takes as maptext here, for the server to lay out
			let r = { w: 0, h: 0 };
			try { r = layoutMaptext(m.text, m.width || 112); } catch (_) {}
			ws.send(JSON.stringify({ t: 'measured', id: m.id, w: Math.max(1, r.w), h: Math.max(1, r.h) }));
			break;
		}
		case 'font': addFont(m.family, m.url, m.cyrillic); break;
		case 'tick': if (m.ms > 0 && m.ms < 1000) state.tickMs = m.ms; break;
		case 'needServer': showServerForm(pageServer); break;
		case 'server': if (!m.fixed) offerServerSwitch(m.addr); break;
		case 'reset': { // the gateway logged in again to refresh the map; the server resends map, objects and HUD.
			// Keep showing what we have meanwhile; objects the server does not send again are dropped afterwards.
			const at = state.resetAt = Date.now();
			state.images.clear(); state.flicks.clear(); // the new login gets its own client.images
			setTimeout(() => {
				for (const [k, o] of state.objs) if ((o.seen || 0) < at) state.objs.delete(k);
				for (const [k, it] of state.screen) if (it.seen < at) state.screen.delete(k);
			}, 2500);
			break;
		}
		case 'out': addOutput(m.html); break;
		case 'browse': m.close ? closeWindow(m.win) : openWindow(m.win, m.html, m.params); break;
		case 'output': windowOutput(m.target, m.data); break;
		case 'winset': applyWinset(m.control, m.params); break;
		case 'dialog': openDialog(m); break;
		case 'menu': showMenu(m); break;
		case 'sound': playSound(m); break;
		case 'shiftMenu': state.shiftMenu = true; break;
	}
	if (m.t === 'reset') for (const box of document.querySelectorAll('.dlg')) box.remove(); // the old login's dialogs are gone
}

// ---------- sound ----------
// sound() as DreamSeeker plays it: per channel (0 = any free one), volume, repeat, pan/frequency, a position
// relative to the listener (x right, z up the screen) fading past falloff, offset. A null file stops the
// channel (channel 0: every sound). Browsers only start audio after the player clicks or presses a key.
const audio = { ctx: null, buffers: new Map(), channels: new Map(), master: null };
function audioContext() {
	if (!audio.ctx) {
		try { audio.ctx = new AudioContext(); } catch (_) { return null; }
		audio.master = audio.ctx.createGain();
		audio.master.gain.value = soundOn() ? 1 : 0;
		audio.master.connect(audio.ctx.destination);
	}
	return audio.ctx;
}
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { const c = audioContext(); if (c && c.state === 'suspended') c.resume(); });
const soundBtn = document.getElementById('soundbtn');
const soundOn = () => { try { return localStorage.getItem('seekerVolume') !== '0'; } catch (_) { return true; } };
soundBtn.classList.toggle('off', !soundOn());
soundBtn.addEventListener('click', () => {
	const on = !soundOn();
	try { localStorage.setItem('seekerVolume', on ? '1' : '0'); } catch (_) {}
	soundBtn.classList.toggle('off', !on);
	if (audioContext()) audio.master.gain.value = on ? 1 : 0;
});

function soundBuffer(rsc) {
	let p = audio.buffers.get(rsc);
	if (!p) {
		p = fetch('/res/' + rsc).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(b => audio.ctx.decodeAudioData(b));
		p.catch(() => setTimeout(() => audio.buffers.delete(rsc), 3000)); // may show up in .dyn.rsc later
		audio.buffers.set(rsc, p);
	}
	return p;
}

function stopChannel(ch) {
	const playing = audio.channels.get(ch);
	if (playing) { try { playing.src.stop(); } catch (_) {} audio.channels.delete(ch); }
}

function soundGain(m) {
	let g = m.volume;
	const pos = m.x !== undefined && (m.x || m.y || m.z);
	if (pos) { const d = Math.hypot(m.x, m.y, m.z), f = Math.max(m.falloff || 1, 0.1); if (d > f) g *= f / d; }
	return g;
}

async function playSound(m) {
	const ctx = audioContext();
	if (!ctx) return;
	const SOUND_UPDATE = 16, SOUND_MUTE = 1, SOUND_PAUSED = 2;
	if (!m.rsc) { // sound(null)
		if (m.channel) stopChannel(m.channel); else for (const ch of [...audio.channels.keys()]) stopChannel(ch);
		return;
	}
	const current = m.channel && audio.channels.get(m.channel);
	if (current && m.status & SOUND_UPDATE) { // change a playing sound in place
		current.gain.gain.value = m.status & (SOUND_MUTE | SOUND_PAUSED) ? 0 : soundGain(m);
		return;
	}
	let buf;
	try { buf = await soundBuffer(m.rsc); } catch (_) { return; }
	if (m.channel) stopChannel(m.channel);
	const src = ctx.createBufferSource();
	src.buffer = buf;
	src.loop = !!m.repeat;
	const f = m.frequency || 0;
	if (f && Math.abs(f) <= 100) src.playbackRate.value = Math.abs(f); // bigger values are Hz in BYOND; left as is
	const gain = ctx.createGain();
	gain.gain.value = m.status & SOUND_MUTE ? 0 : soundGain(m);
	const pan = ctx.createStereoPanner();
	pan.pan.value = Math.max(-1, Math.min(1, m.x !== undefined && m.x ? m.x / 7 : m.pan || 0));
	src.connect(gain).connect(pan).connect(audio.master);
	const ch = m.channel || 'any:' + Math.random();
	audio.channels.set(ch, { src, gain });
	src.onended = () => { if (audio.channels.get(ch)?.src === src) audio.channels.delete(ch); };
	src.start(0, m.offset || 0);
}

// ---------- alert() / input() ----------
function openDialog(m) {
	const box = document.createElement('div');
	box.className = 'win dlg';
	box.innerHTML = '<div class="bar"><span></span></div><form><p></p><div class="field"></div><div class="btns"></div></form>';
	box.querySelector('span').textContent = m.title || 'Сообщение';
	box.querySelector('p').textContent = m.msg || '';
	const form = box.querySelector('form'), field = box.querySelector('.field'), btns = box.querySelector('.btns');
	const done = value => { ws.send(JSON.stringify({ t: 'dialog', id: m.id, value })); box.remove(); };
	const button = (text, onclick, primary) => {
		const b = document.createElement('button');
		b.type = primary ? 'submit' : 'button'; b.textContent = text;
		if (!primary) b.onclick = onclick;
		btns.appendChild(b);
		return b;
	};
	let input = null;
	if (m.kind === 'alert') {
		const named = m.buttons.filter(Boolean); // alert() always sends three buttons; unused ones are empty
		const list = named.length ? named : ['OK'];
		list.forEach((t, i) => { const b = button(t, () => done(t), false); if (i === 0) input = b; });
	} else {
		if (m.kind === 'list') {
			input = document.createElement('select');
			input.size = Math.min(12, Math.max(4, m.choices.length));
			for (const c of m.choices) input.add(new Option(c, c, false, c === m.def));
			if (input.selectedIndex < 0) input.selectedIndex = 0;
			input.ondblclick = () => form.requestSubmit();
		} else if (m.kind === 'message') {
			input = document.createElement('textarea'); input.rows = 6; input.value = m.def;
		} else {
			input = document.createElement('input');
			input.type = { num: 'number', color: 'color', password: 'password' }[m.kind] || 'text';
			if (m.kind === 'num') input.step = 'any';
			input.value = m.kind === 'color' && !/^#[0-9a-f]{6}$/i.test(m.def) ? '#ffffff' : m.def;
		}
		field.appendChild(input);
		button('OK', null, true);
		if (m.canCancel) button('Отмена', () => done(null), false);
		form.onsubmit = e => { e.preventDefault(); done(m.kind === 'list' && input.selectedIndex < 0 ? null : input.value); };
	}
	if (m.kind === 'alert') form.onsubmit = e => e.preventDefault();
	document.body.appendChild(box);
	const n = document.querySelectorAll('.dlg').length - 1;
	box.style.left = Math.max(8, (innerWidth - box.offsetWidth) / 2 + n * 24) + 'px';
	box.style.top = Math.max(8, (innerHeight - box.offsetHeight) / 3 + n * 24) + 'px';
	dragBy(box.querySelector('.bar'), box);
	if (input) input.focus();
}

// ---------- browser windows (browse(), tgui) ----------
// Fixed controls of the default SS13 skin get fixed places; everything else floats.
const FIXED = { title_browser: 'title', statbrowser: 'statpane', browseroutput: 'chatpane' };
const windows = new Map(); // name -> { frame, box? }
const MAP_OVERLAYS = new Set(['escape_menu']); // skin: mapwindow.escape_menu, a browser over the whole map

function windowFor(name, params = '') {
	name = name.replace(/\.browser$/, '');
	let w = windows.get(name);
	if (w) return w;
	if (FIXED[name]) {
		w = { frame: document.getElementById(FIXED[name]) };
	} else if (MAP_OVERLAYS.has(name)) { // browsers the SS13 skin lays over the map (escape menu)
		const frame = document.createElement('iframe');
		forwardFrameKeys(frame);
		frame.className = 'mapoverlay';
		frame.title = name;
		document.getElementById('mapwrap').appendChild(frame);
		w = { frame };
	} else {
		const box = document.createElement('div');
		// tgui draws its own title bar and moves/closes the window itself (winset pos, browse(null))
		box.className = name.startsWith('tgui') ? 'win bare' : 'win';
		const size = (params.match(/(?:^|;)size=(\d+)x(\d+)/) || []).slice(1).map(Number);
		const [bw, bh] = size.length ? size : [480, 560];
		// centred, each further open window a little lower and to the right, always on the page
		const open = [...windows.values()].filter(o => o.box && o.box.style.display !== 'none').length;
		Object.assign(box.style, { width: bw + 'px', height: bh + 'px',
			left: Math.max(0, Math.min((innerWidth - bw) / 2 + open * 24, innerWidth - bw)) + 'px',
			top: Math.max(0, Math.min((innerHeight - bh) / 2 + open * 24, innerHeight - bh)) + 'px' });
		box.innerHTML = '<div class="bar"><span></span><button title="Закрыть">✕</button></div>';
		box.querySelector('span').textContent = name;
		const frame = document.createElement('iframe');
		forwardFrameKeys(frame);
		box.appendChild(frame);
		document.body.appendChild(box);
		box.querySelector('button').onclick = () => { box.style.display = 'none'; };
		dragBy(box.querySelector('.bar'), box);
		trackFrameOrigin(frame);
		w = { name, frame, box, inPage: frame };
	}
	windows.set(name, w);
	return w;
}

// ---------- windows of their own ----------
// Floating windows (tgui, browse() popups) open as browser windows of their own when the "⧉ окна" button is on:
// the world moves and sizes them as DreamSeeker would. Browsers open a popup only shortly after a click or a key
// (most windows open from one) or always, once popups are allowed for the site; a blocked one stays on the page.
// A closed popup takes its page with it: it comes back from its HTML (tgui asks for a full update when ready).
const POPUPS = 'seekerPopups';
let popupsOn = (() => { try { return localStorage.getItem(POPUPS) !== '0'; } catch (_) { return true; } })();
const popBtn = document.getElementById('popbtn');
popBtn.classList.toggle('off', !popupsOn);
popBtn.addEventListener('click', () => {
	popupsOn = !popupsOn;
	try { localStorage.setItem(POPUPS, popupsOn ? '1' : '0'); } catch (_) {}
	popBtn.classList.toggle('off', !popupsOn);
	for (const w of windows.values()) {
		if (!w.own || !isShown(w)) continue;
		if (popupsOn && !livePopup(w)) { hostIn(w, openPopup(w)); }
		else if (!popupsOn && livePopup(w)) { dropPopup(w); hostIn(w, null); }
	}
});
const livePopup = w => !!(w.popup && !w.popup.closed);
let popupHintAt = 0;
function openPopup(w) {
	const box = w.box, bw = parseInt(box.style.width) || 480, bh = (parseInt(box.style.height) || 560) - (box.classList.contains('bare') ? 0 : 24);
	const o = pageOrigin(), r = box.getBoundingClientRect();
	const at = r.width ? { x: o.x + r.left, y: o.y + r.top } : { x: o.x + (innerWidth - bw) / 2, y: o.y + (innerHeight - bh) / 2 };
	let p = null;
	try { p = window.open('', 'seeker-' + w.name, `popup,width=${bw},height=${bh},left=${Math.round(at.x)},top=${Math.round(at.y)}`); } catch (_) {}
	if (!p) {
		if (Date.now() - popupHintAt > 30000) { popupHintAt = Date.now(); notice('Браузер не дал открыть отдельное окно — разрешите всплывающие окна для этого сайта (значок в адресной строке)'); }
		return null;
	}
	p.document.open();
	p.document.write('<!doctype html><meta charset="utf-8"><title></title><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}iframe{display:block;border:0;width:100%;height:100%}</style>');
	p.document.close();
	p.document.title = w.box.querySelector('span').textContent;
	const frame = p.document.createElement('iframe');
	forwardFrameKeys(frame);
	trackFrameOrigin(frame, p);
	p.document.body.appendChild(frame);
	p.seekerFramePos = window.seekerFramePos;
	p.addEventListener('message', onFrameMessage);
	p.addEventListener('pagehide', () => { if (w.popup === p && !w.closing) popupClosed(w); });
	frame.addEventListener('load', () => { try { if (frame.contentDocument.title) p.document.title = frame.contentDocument.title; } catch (_) {} });
	return { p, frame };
}
// Puts the window's page into a popup ({p, frame}) or, with null, back into its box on the page.
function hostIn(w, pop) {
	if (pop) {
		w.popup = pop.p; w.frame = pop.frame;
		w.box.style.display = 'none';
		w.inPage.srcdoc = '';
	} else {
		w.popup = null; w.frame = w.inPage;
		w.box.style.display = 'flex';
	}
	if (w.html != null) w.frame.srcdoc = w.html;
	w.dead = false;
}
function dropPopup(w) {
	const p = w.popup;
	w.closing = true;
	try { p.close(); } catch (_) {}
	w.closing = false;
	w.popup = null; w.frame = w.inPage; w.dead = true;
}
// The player closed a popup: tgui windows are told, as their own close button does
function popupClosed(w) {
	w.popup = null; w.frame = w.inPage; w.dead = true;
	if (w.name.startsWith('tgui-window')) ws.send(JSON.stringify({ t: 'topic', href: '?type=close&tgui=1&window_id=' + encodeURIComponent(w.name) }));
}
addEventListener('pagehide', () => { for (const w of windows.values()) if (livePopup(w)) { w.closing = true; w.popup.close(); } });

// Where pages are on the screen. Windows place themselves in screen pixels (tgui reads window.screenLeft/Top and
// sends winset pos), so a page inside an iframe is told its real place: the browser's own screenLeft is the
// tab's. The viewport's screen origin is learnt from mouse events (screenX - clientX), estimated until then.
let learntOrigin = null;
for (const type of ['pointermove', 'pointerdown']) addEventListener(type, e => { learntOrigin = { x: e.screenX - e.clientX, y: e.screenY - e.clientY }; }, true);
function pageOrigin() {
	return learntOrigin || { x: window.screenX + (outerWidth - innerWidth) / 2, y: window.screenY + outerHeight - innerHeight };
}
function trackFrameOrigin(frame, popup) {
	frame.addEventListener('load', () => {
		let doc;
		try { doc = frame.contentDocument; } catch (_) { return; }
		if (!doc) return;
		// pointerdown comes before the mousedown that starts a window drag, so the drag starts from the right place
		const learn = e => {
			const ox = e.screenX - e.clientX, oy = e.screenY - e.clientY;
			if (popup) popup.seekerChrome = { x: ox - popup.screenX, y: oy - popup.screenY };
			else { const r = frame.getBoundingClientRect(); learntOrigin = { x: ox - r.left, y: oy - r.top }; }
		};
		doc.addEventListener('pointermove', learn, true);
		doc.addEventListener('pointerdown', learn, true);
	});
}
function framePos(w) {
	if (livePopup(w)) {
		const p = w.popup, c = p.seekerChrome || { x: (p.outerWidth - p.innerWidth) / 2, y: p.outerHeight - p.innerHeight };
		return { x: p.screenX + c.x, y: p.screenY + c.y };
	}
	const o = pageOrigin(), r = w.frame.getBoundingClientRect();
	return { x: o.x + r.left, y: o.y + r.top };
}
window.seekerFramePos = name => { const w = windows.get(String(name).replace(/\.browser$/, '')); return w ? framePos(w) : null; };
function moveWindow(w, x, y) {
	if (livePopup(w)) {
		const p = w.popup, c = p.seekerChrome || { x: (p.outerWidth - p.innerWidth) / 2, y: p.outerHeight - p.innerHeight };
		try { p.moveTo(Math.round(x - c.x), Math.round(y - c.y)); } catch (_) {}
		return;
	}
	if (!w.box) return;
	const o = pageOrigin(), fr = w.frame.getBoundingClientRect(), br = w.box.getBoundingClientRect();
	const left = x - o.x - (fr.left - br.left), top = y - o.y - (fr.top - br.top);
	// keep the whole window on the page (its own title bar must stay reachable); a hidden window has no layout
	// size, so its set size counts
	const bw = w.box.offsetWidth || parseInt(w.box.style.width) || 0, bh = w.box.offsetHeight || parseInt(w.box.style.height) || 0;
	if (w.name === 'tgui_say' && isShown(w)) w.placed = true; // the player dragged the say box: it stays there
	Object.assign(w.box.style, {
		left: Math.max(0, Math.min(left, innerWidth - bw)) + 'px',
		top: Math.max(0, Math.min(top, innerHeight - bh)) + 'px',
	});
}
function sizeWindow(w, x, y) {
	if (!w.box) return;
	// the size is the page's; our title bar comes on top of it
	Object.assign(w.box.style, { width: x + 'px', height: y + (w.box.classList.contains('bare') ? 0 : w.box.querySelector('.bar').offsetHeight || 24) + 'px' });
	if (livePopup(w)) { const p = w.popup; try { p.resizeTo(x + p.outerWidth - p.innerWidth, y + p.outerHeight - p.innerHeight); } catch (_) {} }
}

let noticeTimer = 0;
function notice(text) {
	let el = document.getElementById('notice');
	if (!el) { el = Object.assign(document.createElement('div'), { id: 'notice' }); document.body.appendChild(el); el.onclick = () => { el.style.display = 'none'; }; }
	el.textContent = text; el.style.display = 'block';
	clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.style.display = 'none'; }, 10000);
}

const isShown = w => livePopup(w) || (w.box || w.frame).style.display !== 'none';
// The say box (tgui-say, key T): over the map, low and centred, until the player drags it elsewhere; typing goes
// straight into it. DreamSeeker places it from the skin, in screen pixels of a desktop window.
function openSayBox(w) {
	if (!w.placed) {
		const m = document.getElementById('mapwrap').getBoundingClientRect(), bw = parseInt(w.box.style.width) || 270, bh = parseInt(w.box.style.height) || 30;
		Object.assign(w.box.style, { left: Math.round(m.left + (m.width - bw) / 2) + 'px', top: Math.round(m.bottom - bh - 72) + 'px' });
	}
	const focusInput = () => {
		try {
			w.frame.focus();
			const input = w.frame.contentDocument.querySelector('textarea, input');
			if (input) { input.focus(); return true; }
		} catch (_) {}
		return false;
	};
	if (!focusInput()) setTimeout(focusInput, 50);
}
function showWindow(w, on) {
	if (on && w.name === 'tgui_say' && w.box) { w.box.style.display = 'flex'; openSayBox(w); return; }
	if (w.own && w.box) {
		if (on) {
			if (!livePopup(w) && popupsOn) { const pop = openPopup(w); if (pop) return void hostIn(w, pop); }
			if (w.dead) hostIn(w, null); else w.box.style.display = 'flex';
			if (livePopup(w)) w.box.style.display = 'none';
		} else {
			if (livePopup(w)) dropPopup(w);
			w.box.style.display = 'none';
		}
		return;
	}
	(w.box || w.frame).style.display = on ? (w.box ? 'flex' : 'block') : 'none';
}

function openWindow(name, html, params) {
	const w = windowFor(name, params);
	w.html = html;
	// Skin elements (tooltips, escape menu, asset cache, say box) stay hidden until a winset shows them;
	// fixed panes, tgui windows and /datum/browser popups (they pass a size) are shown.
	const bare = name.replace(/\.browser$/, '');
	const show = bare !== 'browseroutput' && (!!FIXED[bare] || bare.startsWith('tgui-window') || /(?:^|[;&])(size|can_close)=/.test(params));
	if (w.box && show) w.own = true; // a window of its own (not a skin element): may get a browser window
	if (w.own && show && !livePopup(w) && popupsOn) { const pop = openPopup(w); if (pop) { hostIn(w, pop); return; } }
	w.frame.srcdoc = html;
	w.dead = false;
	showWindow(w, show);
	if (bare === 'browseroutput') useChatPanel(w.frame);
}

// The world's own chat (tgui chat panel) replaces the plain output once it shows messages; worlds without it,
// or a panel that never gets going, keep the plain output (which ss1984 sends alongside).
// On the very first start (empty storage) tgui's chat never picks a page and stays blank; it saves its
// state about 10 s later, so a panel that is still blank then is reloaded once and comes up from that state.
function useChatPanel(frame) {
	let started = Date.now(), reloaded = false;
	const check = () => {
		let ready = false;
		try { const chat = frame.contentDocument.querySelector('.Chat'); ready = !!(chat && chat.children.length); } catch (_) {}
		if (ready) { frame.style.display = 'block'; outEl.style.display = 'none'; return; }
		const saved = (() => { try { return Object.keys(localStorage).some(k => /^hub:.*chat-state$/.test(k)); } catch (_) { return false; } })();
		if (!reloaded && saved && Date.now() - started > 12000) { reloaded = true; started = Date.now(); frame.srcdoc = frame.srcdoc; }
		if (Date.now() - started < 30000) setTimeout(check, 500);
	};
	setTimeout(check, 500);
}

function closeWindow(name) {
	const w = windows.get(name.replace(/\.browser$/, ''));
	if (!w || !w.box) return; // fixed panes stay
	showWindow(w, false);
	w.frame.srcdoc = '';
	w.html = null;
}

// output(data, "window:function") calls a JS function inside the window with the decoded params
function windowOutput(target, data) {
	const [ctl, fn] = target.split(':');
	const w = controlWindow(ctl);
	if (!w) return;
	const args = data === '' ? [] : data.split('&').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
	// a tgui window whose popup was closed is opened again for a UI (its "update"); the fresh page asks for the
	// whole state itself once ready, so this message is not needed
	if (w.dead && w.html != null) {
		let type = '';
		try { type = JSON.parse(args[0]).type; } catch (_) {}
		if (type === 'update') showWindow(w, true);
		return;
	}
	const call = () => {
		const f = fn && w.frame.contentWindow && w.frame.contentWindow[fn];
		if (typeof f !== 'function') return false;
		try { f.apply(w.frame.contentWindow, args); } catch (err) { console.warn(target, err); }
	};
	if (call() === false) setTimeout(call, 300); // page may still be loading
}

// Splits "a=1;b=\"x;y\"" into [key, value] pairs; quoted values may hold ';' and \" escapes.
function winsetPairs(params) {
	const out = [];
	let i = 0;
	while (i < params.length) {
		const eq = params.indexOf('=', i);
		if (eq < 0) break;
		const key = params.slice(i, eq).trim();
		let val = '', j = eq + 1;
		if (params[j] === '"') {
			for (j++; j < params.length && params[j] !== '"'; j++) val += params[j] === '\\' && j + 1 < params.length ? params[++j].replace('n', '\n') : params[j];
			j = params.indexOf(';', j); if (j < 0) j = params.length;
		} else {
			j = params.indexOf(';', eq); if (j < 0) j = params.length;
			try { val = decodeURIComponent(params.slice(eq + 1, j).replace(/\+/g, ' ')); } catch (_) { val = params.slice(eq + 1, j); }
		}
		if (key) out.push([key, val]);
		i = j + 1;
	}
	return out;
}

// Skin control names: "tgui_say.browser" and "mapwindow.escape_menu" are the windows "tgui_say", "escape_menu".
const controlWindow = ctl => windows.get(ctl.replace(/\.browser$/, '')) || windows.get(ctl.replace(/\.browser$/, '').split('.').pop());

// Client commands as skins and macros run them: ".output control:fn data", ".winset \"params\"" (with the
// "cond?then:else" form), anything else goes to the server like a typed command.
function runCommand(text) {
	for (const line of text.split('\n')) {
		const cmd = line.trim();
		if (!cmd) continue;
		let m;
		if ((m = cmd.match(/^\.output\s+(\S+)\s*([\s\S]*)$/))) windowOutput(m[1], m[2]);
		else if ((m = cmd.match(/^\.winset\s+"?([\s\S]*?)"?$/))) {
			const c = m[1].match(/^([\w.\-]+)=([^?]*)\?([^:]*)(?::(.*))?$/);
			if (!c) { applyWinset('', m[1]); continue; }
			const dot = c[1].lastIndexOf('.'), w = controlWindow(c[1].slice(0, dot)), prop = c[1].slice(dot + 1);
			const cur = prop === 'is-visible' ? String(!!w && isShown(w)) : '';
			const branch = cur === c[2] ? c[3] : c[4];
			if (branch) applyWinset('', branch);
		} else if (!cmd.startsWith('.')) ws.send(JSON.stringify({ t: 'command', text: cmd }));
	}
}

// Key macros the server defines at runtime (winset parent=default;name=Escape;command=...); "Any" is keyDown.
const macros = new Map();

// winset(control, "prop=value;other.prop=value"): an empty control means every property names its element.
function applyWinset(control, params) {
	const pairs = winsetPairs(params);
	const parent = pairs.find(([k]) => k === 'parent'), name = pairs.find(([k]) => k === 'name');
	if (parent && name) { // a new macro or element
		const command = pairs.find(([k]) => k === 'command');
		if (parent[1] === 'default' && command) macros.set(name[1], command[1]);
		return;
	}
	const byCtl = new Map();
	for (let [key, val] of pairs) {
		if (key === 'command' && !control) { runCommand(val); continue; }
		let ctl = control;
		if (!ctl || key.includes('.')) { const dot = key.lastIndexOf('.'); ctl = key.slice(0, dot); key = key.slice(dot + 1); }
		if (!byCtl.has(ctl)) byCtl.set(ctl, {});
		byCtl.get(ctl)[key] = val;
	}
	for (const [ctl, p] of byCtl) {
		// the map control ("mapwindow.map", ":map"): right-click=true hands right clicks to the server
		if (/(^|[.:])map$/.test(ctl) && 'right-click' in p) state.mapRightClick = p['right-click'] === 'true';
		// focus back to the map (the say box does this as it closes): keys are the game's again
		if (/(^|[.:])map$/.test(ctl) && p.focus === 'true') { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); window.focus(); }
		if (ctl === 'input') { // the command line; classic (non-hotkey) mode puts typed letters there
			if ('text' in p) cmdInput.value = p.text;
			if (p.focus === 'true') cmdInput.focus();
			continue;
		}
		const w = controlWindow(ctl);
		if (!w) continue;
		// the size first: a window shown by the same winset is placed with it
		if (w.box && p.size) { const [x, y] = p.size.split('x').map(Number); if (x && y) sizeWindow(w, x, y); }
		if ('is-visible' in p && (p['is-visible'] === 'true') !== isShown(w)) showWindow(w, p['is-visible'] === 'true');
		if (p.focus === 'true' && w.box) { if (!isShown(w)) showWindow(w, true); if (livePopup(w)) w.popup.focus(); w.frame.focus(); }
		// pos is in screen pixels (pages compute it from window.screenLeft/Top, which they are told: framePos)
		if (w.box && p.pos) {
			const [x, y] = p.pos.split(/[,x]/).map(Number);
			if (Number.isFinite(x) && Number.isFinite(y)) moveWindow(w, x, y);
		}
	}
}

// Messages from the injected cef_to_byond shim (popups pass on those of their pages)
window.addEventListener('message', onFrameMessage);
function onFrameMessage(e) {
	const m = e.data;
	if (!m || m.seeker !== 'byond') return;
	const url = m.url.replace(/^byond:\/\//i, '');
	const q = url.indexOf('?');
	const verb = q < 0 ? url : url.slice(0, q);
	const params = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
	if (verb === '') { ws.send(JSON.stringify({ t: 'topic', href: url })); return; }
	if (verb === 'winget') {
		const cb = params.get('callback');
		const props = (params.get('property') || '*').split(',');
		const win = windows.get((params.get('id') || '').replace(/\.browser$/, '').replace(/^:/, ''));
		const out = {};
		// 516's webview answers typed values: size and pos as {x, y} (screen pixels for pos, as winset takes it)
		const r = win && win.frame.getBoundingClientRect(), at = win && framePos(win);
		for (const p of props) out[p] = p === 'is-visible' ? !!(win && isShown(win))
			: p === 'size' ? (r ? { x: Math.round(r.width), y: Math.round(r.height) } : { x: 640, y: 480 })
			: p === 'pos' ? (at ? { x: Math.round(at.x), y: Math.round(at.y) } : { x: 0, y: 0 })
			: '';
		const src = windows.get(m.win);
		if (cb && src) try { src.frame.contentWindow.eval(cb)(out); } catch (_) {}
		return;
	}
	if (verb === 'winset') {
		// Byond.winset(id, props) / Byond.command(text) from tgui pages
		const rest = [...params].filter(([k]) => k !== 'id').map(([k, v]) => k + '=' + encodeURIComponent(v)).join(';');
		applyWinset(params.get('id') || '', rest);
		return;
	}
}

function dragBy(handle, box) {
	handle.addEventListener('pointerdown', e => {
		if (e.target.tagName === 'BUTTON') return;
		const sx = e.clientX - box.offsetLeft, sy = e.clientY - box.offsetTop;
		const move = ev => { box.style.left = ev.clientX - sx + 'px'; box.style.top = ev.clientY - sy + 'px'; };
		const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
		addEventListener('pointermove', move); addEventListener('pointerup', up);
	});
}

// How far (in tiles) an atom is still drawn from its tile while it slides there after a step.
function glideTiles(ob, now) {
	const g = ob.glide;
	if (!g) return [0, 0];
	const k = (now - g.start) / g.dur;
	if (k >= 1) { ob.glide = null; return [0, 0]; }
	return [(g.fx - ob.x) * (1 - k), (g.fy - ob.y) * (1 - k)];
}

function applyObjects(kind, o) {
	const get = ref => {
		const k = kind + ':' + ref;
		let ob = state.objs.get(k);
		if (!ob) state.objs.set(k, ob = { x: 0xffff, y: 0xffff, z: -1, dir: null, app: null, px: 0, py: 0, next: 0xffff });
		ob.seen = Date.now();
		ob.leaving = 0;
		return ob;
	};
	// The server drops objects as they leave its view, while our view still slides after our mob: an object
	// dropped at the edge of the view stays (leaving) until the view has passed it (render.js drops it then).
	// One removed inside the view is gone at once.
	const eye = state.eye && state.eye.x != null ? state.eye : null, reach = Math.floor(Math.min(...viewSize()) / 2);
	for (const e of o.del) {
		const k = kind + ':' + e.ref, ob = state.objs.get(k);
		if (ob && eye && ob.x !== 0xffff && Math.max(Math.abs(ob.x - eye.x), Math.abs(ob.y - eye.y)) >= reach) { ob.leaving = performance.now(); continue; }
		state.objs.delete(k);
	}
	const newApp = new Map(o.appearance.map(e => [e.ref, e.appearance]));
	for (const e of o.pos) {
		const ob = get(e.ref), now = performance.now();
		// a step to a neighbouring tile slides there (glide) from wherever the last slide had got to. As in
		// BYOND (and OpenDream's AtomGlideSystem) it goes glide_size pixels per server tick; with glide_size 0
		// (automatic) it lasts as long as the time between the atom's last steps, so walking looks continuous.
		// Jumps and teleports are instant.
		const step = ob.z === e.z && ob.x !== 0xffff && e.x !== 0xffff && Math.abs(e.x - ob.x) <= 1 && Math.abs(e.y - ob.y) <= 1 && (e.x !== ob.x || e.y !== ob.y);
		if (step) {
			const [ox, oy] = glideTiles(ob, now), since = now - (ob.movedAt || 0);
			// at most one tile behind: moving faster than the slide (a flying ghost) would leave the view further
			// and further behind its mob, and the world past the drawn area would show black
			const fx = Math.max(e.x - 1, Math.min(e.x + 1, ob.x + ox)), fy = Math.max(e.y - 1, Math.min(e.y + 1, ob.y + oy)), a = state.apps.get(newApp.get(e.ref) ?? ob.app), gs = a && a.glide_size;
			const dur = gs > 0 ? Math.max(Math.abs(e.x - fx), Math.abs(e.y - fy)) * TILE / gs * state.tickMs
				: since < 600 ? Math.min(Math.max(since, 80), 400) : 200;
			// pix: the pixel offset it was last drawn with; render.js evens the slide out against the new one
			ob.glide = { fx, fy, start: now, dur: Math.min(dur, 1000), pix: ob.lastPix && now - ob.lastPixAt < 500 ? ob.lastPix : null };
		} else ob.glide = null;
		if (e.x !== ob.x || e.y !== ob.y) ob.movedAt = now;
		Object.assign(ob, { x: e.x, y: e.y, z: e.z });
	}
	for (const e of o.next) get(e.ref).next = e.next; // the next object on the same turf
	for (const e of o.dir) get(e.ref).dir = e.dir;
	for (const e of o.appearance) {
		const ob = get(e.ref);
		if (ob.app !== e.appearance) ob.appAt = performance.now(); // animations that play a set number of times start here
		ob.app = e.appearance;
	}
	// the object's pixel_x, pixel_y, pixel_w, pixel_z (i16 each); w/z shift it like x/y (SS13 parallax layers use them)
	const i16 = v => (v << 16) >> 16;
	for (const e of o.step) { const ob = get(e.ref); ob.px = i16(e.v[0]) + i16(e.v[2] || 0); ob.py = i16(e.v[1]) + i16(e.v[3] || 0); }
	for (const e of o.vis || []) {
		const key = kind + ':' + e.ref;
		if (e.items.length) state.vis.set(key, e.items.map(v => ({ type: v.t, ref: v.ref }))); else state.vis.delete(key);
	}
	for (const e of o.del) state.vis.delete(kind + ':' + e.ref);
}

// Output: HTML from the server; byond:// links become Topic calls.
function addOutput(html) {
	// ss1984's notice for a broken tgui chat; this client shows plain output on purpose, so it does not apply
	if (html.includes('Failed to load fancy chat')) return;
	const div = document.createElement('div');
	div.innerHTML = html.replace(/\n$/, '');
	// chat icons reference browser assets by bare file name
	for (const img of div.querySelectorAll('img[src]')) {
		const src = img.getAttribute('src');
		if (!/^([a-z]+:|\/)/i.test(src)) img.src = '/a/' + state.sid + '/' + src;
	}
	const stick = outEl.scrollTop + outEl.clientHeight >= outEl.scrollHeight - 4;
	outEl.appendChild(div);
	while (outEl.childNodes.length > 500) outEl.removeChild(outEl.firstChild);
	if (stick) outEl.scrollTop = outEl.scrollHeight;
}
outEl.addEventListener('click', e => {
	const a = e.target.closest('a');
	if (!a) return;
	const href = a.getAttribute('href') || '';
	if (href.startsWith('byond://') || href.startsWith('?')) { e.preventDefault(); ws.send(JSON.stringify({ t: 'topic', href })); }
});
// Command line like DreamSeeker's input bar: 'say "hi"' runs a verb, byond://?... sends a Topic.
const cmdInput = document.getElementById('topic');
document.getElementById('cmd').addEventListener('submit', e => {
	e.preventDefault();
	const text = cmdInput.value.trim();
	cmdInput.value = '';
	cmdInput.blur();
	if (!text) return;
	if (text.startsWith('?') || text.toLowerCase().startsWith('byond://')) ws.send(JSON.stringify({ t: 'topic', href: text }));
	else ws.send(JSON.stringify({ t: 'command', text }));
});
document.addEventListener('keydown', e => {
	const typing = e.target.closest && e.target.closest('input, textarea');
	if (e.code === 'Enter' && !typing) { e.preventDefault(); cmdInput.focus(); }
	else if (e.code === 'Escape' && e.target === cmdInput) { cmdInput.value = ''; cmdInput.blur(); }
});

// ---------- input ----------
// Keys go to the server by BYOND key name (keyDown/keyUp verbs); dir is the fallback for built-in movement.
const DIRS = { ArrowUp: 1, ArrowDown: 2, ArrowRight: 4, ArrowLeft: 8, KeyW: 1, KeyS: 2, KeyD: 4, KeyA: 8 };
// BYOND's key names (what the skin's "Any" macro passes to keyDown): the navigation block as directions, the
// numeric keypad by its own names, punctuation as itself
const BYOND_KEYS = { ArrowUp: 'North', ArrowDown: 'South', ArrowRight: 'East', ArrowLeft: 'West', Home: 'Northwest', End: 'Southwest',
	PageUp: 'Northeast', PageDown: 'Southeast', Insert: 'Insert', Delete: 'Delete', Space: 'Space', Escape: 'Escape', Tab: 'Tab', Backspace: 'Back',
	ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', Pause: 'Pause', ContextMenu: 'Apps',
	NumpadMultiply: 'Multiply', NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadDivide: 'Divide', NumpadDecimal: 'Decimal',
	Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
function byondKey(e) {
	if (BYOND_KEYS[e.code]) return BYOND_KEYS[e.code];
	if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
	if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
	if (/^Numpad\d$/.test(e.code)) return e.code;
	if (/^F\d+$/.test(e.code)) return e.code;
	return null;
}
// The pointer over the map (page pixels from its top-left) and the map's size: keyDown gets them like
// DreamSeeker's [[map.mouse-pos]] [[map.size]], SS13 finds the tile under the pointer from them
const mapEl = document.getElementById('map');
let mouseAt = null;
mapEl.addEventListener('mousemove', e => { const r = mapEl.getBoundingClientRect(); mouseAt = [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; });
mapEl.addEventListener('mouseleave', () => { mouseAt = null; });
const held = new Set();
function gameKey(e, type) {
	if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) || e.target.isContentEditable) return;
	const key = byondKey(e);
	if (!key) return;
	const down = type === 'keydown';
	if (down && held.has(key)) { e.preventDefault(); return; } // no auto-repeat: the server repeats held keys itself
	down ? held.add(key) : held.delete(key);
	e.preventDefault();
	const macro = macros.get(down ? key : key + ' UP'); // "Any+UP" arrives url-decoded
	if (macro) runCommand(macro);
	const r = mapEl.getBoundingClientRect(), at = mouseAt || [Math.round(r.width / 2), Math.round(r.height / 2)];
	ws.send(JSON.stringify({ t: 'key', key, down, dir: DIRS[e.code], mouse: at, size: [Math.round(r.width), Math.round(r.height)] }));
}
for (const type of ['keydown', 'keyup']) document.addEventListener(type, e => gameKey(e, type));
// Windows (tgui, browse()) are documents of their own and their keys do not reach this page: game keys typed
// there are passed on (text fields keep theirs; Escape stays with the window, which closes itself with it)
function forwardFrameKeys(frame) {
	frame.addEventListener('load', () => {
		let doc;
		try { doc = frame.contentDocument; } catch (_) { return; }
		if (!doc) return;
		for (const type of ['keydown', 'keyup']) doc.addEventListener(type, e => { if (e.code !== 'Escape') gameKey(e, type); });
	});
}
for (const id of ['statpane', 'chatpane', 'title']) { const f = document.getElementById(id); if (f) forwardFrameKeys(f); }
window.addEventListener('blur', () => { for (const key of held) ws.send(JSON.stringify({ t: 'key', key, down: false })); held.clear(); });
// Ctrl+W is the browser's, and pages cannot take it: with Ctrl held in the game, ask before the tab closes
window.addEventListener('beforeunload', e => { if (held.has('Ctrl')) { e.preventDefault(); e.returnValue = ''; } });

// ---------- icons ----------
const icons = new Map(); // rsc id -> { meta, img, bmp, ready }
const iconFails = new Map(); // rsc id -> failed loads in a row
// Icons come over the page socket (ws "icon" -> one binary frame: u32 head length, JSON { id, meta }, PNG):
// any number at once, where HTTP would queue them behind the browser's few connections to the site. Before the
// socket is open they come over HTTP as before.
function getIcon(rsc) {
	let ic = icons.get(rsc);
	if (ic) return ic.ready ? ic : null;
	ic = { ready: false };
	icons.set(rsc, ic);
	if (ws.readyState === 1) { ws.send(JSON.stringify({ t: 'icon', id: rsc })); return null; }
	Promise.all([
		fetch('/icon/' + rsc + '.json').then(r => r.ok ? r.json() : null),
		new Promise(res => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = '/icon/' + rsc + '.png'; }),
	]).then(([meta, img]) => (meta && img && !meta.error ? iconReady(rsc, meta, img) : iconFailed(rsc)));
	return null;
}
function iconReady(rsc, meta, img) {
	const ic = icons.get(rsc);
	if (!ic) return;
	meta.byName = new Map(meta.states.map(s => [s.name, s]));
	Object.assign(ic, { meta, img, ready: true });
}
// icons made at runtime reach the server a little after their first use: ask again later (backing off: some
// never come)
function iconFailed(rsc) {
	const n = (iconFails.get(rsc) || 0) + 1;
	iconFails.set(rsc, n);
	setTimeout(() => icons.delete(rsc), n <= 10 ? 2000 : 30000);
}
function iconArrived(buf) {
	const len = new DataView(buf).getUint32(0, true);
	const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
	const img = new Image();
	img.onload = () => iconReady(head.id, head.meta, img);
	img.onerror = () => iconFailed(head.id);
	// (an object URL per icon: its src also keys the tint and light caches)
	img.src = URL.createObjectURL(new Blob([new Uint8Array(buf, 4 + len)], { type: 'image/png' }));
}

const DIR8 = { 2: 0, 1: 1, 4: 2, 8: 3, 6: 4, 10: 5, 5: 6, 9: 7 };
const DIR4 = { 2: 0, 1: 1, 4: 2, 8: 3, 6: 2, 10: 3, 5: 2, 9: 3 };
// Frame of an icon state at time t (ms). DMI "rewind" plays the frames forward then back; "loop = n" plays the
// animation n times counted from `since` (when the atom got this appearance) and then holds the last frame.
// once: play one time from t = 0 (flick); the result has done set once it is over.
function frameRect(ic, iconState, dir, t, once = false, since = 0) {
	const meta = ic.meta;
	// like BYOND: a missing state falls back to the unnamed one, and with no unnamed state nothing is drawn
	const st = meta.byName.get(iconState) ?? meta.byName.get('');
	if (!st) return null;
	const di = st.dirs >= 8 ? (DIR8[dir] ?? 0) : st.dirs >= 4 ? (DIR4[dir] ?? 0) : 0;
	let frame = 0, done = false;
	if (st.frames > 1 || once) {
		if (!st.seq) { // frame order and delays, worked out once per state
			st.seq = Array.from({ length: st.frames }, (_, i) => i);
			if (st.rewind) for (let i = st.frames - 2; i > 0; i--) st.seq.push(i);
			st.delays = st.seq.map(i => st.delay[i] || 1);
			st.total = st.delays.reduce((a, b) => a + b, 0);
		}
		const { seq, delays, total } = st;
		const runs = once ? 1 : st.loop > 0 ? st.loop : 0;
		let tt = Math.floor((runs && !once ? t - since : t) / 100);
		if (runs && tt >= total * runs) { done = true; tt = total - 1; } // hold the last frame
		tt %= total;
		let k = 0;
		while (tt >= delays[k]) tt -= delays[k++];
		frame = seq[k];
	}
	const idx = st.offset + frame * st.dirs + Math.min(di, st.dirs - 1);
	// (a plain image has no columns in its description: older gateways leave cols out)
	const cols = meta.cols || 1;
	return { sx: (idx % cols) * meta.width, sy: Math.floor(idx / cols) * meta.height, w: meta.width, h: meta.height, done };
}

// color: [r, g, b, a] multiply; cached per frame
const tintCache = new Map();
function tinted(ic, rect, color) {
	const key = ic.img.src + rect.sx + ',' + rect.sy + ',' + color;
	let c = tintCache.get(key);
	if (c) return c;
	c = document.createElement('canvas');
	c.width = rect.w; c.height = rect.h;
	const g = c.getContext('2d');
	g.drawImage(ic.bmp || ic.img, rect.sx, rect.sy, rect.w, rect.h, 0, 0, rect.w, rect.h);
	const [r, gg, b] = color;
	if (r !== 255 || gg !== 255 || b !== 255) {
		g.globalCompositeOperation = 'multiply';
		g.fillStyle = `rgb(${r},${gg},${b})`;
		g.fillRect(0, 0, rect.w, rect.h);
		g.globalCompositeOperation = 'destination-in';
		g.drawImage(ic.bmp || ic.img, rect.sx, rect.sy, rect.w, rect.h, 0, 0, rect.w, rect.h);
	}
	if (tintCache.size > 4000) tintCache.clear();
	tintCache.set(key, c);
	return c;
}

const WHITE = [255, 255, 255, 255];
function colorOf(a) {
	if (a.color === undefined || a.color === null) return WHITE;
	if (a._rgba) return a._rgba; // appearances never change, so the colour is worked out once
	const v = a.color >>> 0;
	return (a._rgba = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
}

