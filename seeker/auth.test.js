const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Auth } = require('./auth');
const { verifyCertificate } = require('./byond-auth');

async function fixture(t, verifyByond = async () => 'testplayer', options = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seeker-auth-'));
	let now = Date.now();
	const auth = new Auth({ origin: 'https://station.example', stateFile: path.join(directory, 'sessions.json'), now: () => now, verifyByond, ...options });
	const server = http.createServer((req, res) => auth.handle(req, res, new URL(req.url, 'http://test')).catch(() => { res.writeHead(500); res.end(); }));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		clearInterval(auth.sweep);
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(directory, { recursive: true, force: true });
	});
	const cookies = new Map();
	const jar = () => [...cookies].map(([key, value]) => key + '=' + value).join('; ');
	const request = async (route, data, headers = {}) => {
		const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/${route}`, {
			redirect: 'manual', method: data === undefined ? 'GET' : 'POST',
			headers: { Origin: auth.origin, Cookie: jar(), 'Content-Type': 'application/json', ...headers },
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		for (const entry of response.headers.getSetCookie()) {
			const [key, value] = entry.split(';')[0].split('=');
			if (value) cookies.set(key, value); else cookies.delete(key);
		}
		return { status: response.status, body: response.status === 303 ? null : await response.json(), headers: response.headers };
	};
	return {
		auth, request, jar, port: () => server.address().port,
		advance: ms => { now += ms; },
		getCookie: () => auth.cookieName + '=' + cookies.get(auth.cookieName),
		clearCookies: () => cookies.clear(),
		session: () => auth.session({ headers: { cookie: jar() } }),
		callback(start, cert = 'valid-certificate', headers = {}) {
			const target = new URL(new URL(start.body.url).searchParams.get('url'));
			target.searchParams.set('byondcert', cert);
			return request('byond/callback' + target.search, undefined, {
				Cookie: auth.loginCookie + '=' + cookies.get(auth.loginCookie), Origin: '', ...headers,
			});
		},
	};
}
const successful = result => assert.equal(result.headers.get('location'), '/login.html?byond=success');
const rejected = result => assert.equal(result.headers.get('location'), '/login.html?byond=error');

test('guests have independent, persistent identities and secure opaque cookies', async t => {
	const f = await fixture(t);
	assert.equal((await f.request('session')).body.active, false);
	const login = await f.request('guest', {});
	assert.equal(login.status, 200);
	assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;.*Secure/);
	const first = f.session();
	const restored = new Auth({ origin: f.auth.origin, stateFile: f.auth.stateFile });
	t.after(() => clearInterval(restored.sweep));
	assert.equal(restored.session({ headers: { cookie: f.getCookie() } }).guest, first.guest);
	f.clearCookies();
	await f.request('guest', {});
	assert.notEqual(f.session().guest, first.guest);
});

test('signed tickets are one-use, expire and carry authoritative identity and address', async t => {
	const f = await fixture(t);
	await f.request('guest', {});
	const session = f.session(), ticket = f.auth.issue(session, '203.0.113.7');
	const [version, nonce, signature] = ticket.split(':');
	assert.equal(signature, crypto.createHmac('sha256', f.auth.secret).update(version + ':' + nonce).digest('hex'));
	assert.equal(f.auth.consume(ticket.slice(0, -1) + (ticket.endsWith('0') ? '1' : '0')), null);
	assert.deepEqual(f.auth.consume(ticket), { guest: session.guest, ckey: null, address: '203.0.113.7' });
	assert.equal(f.auth.consume(ticket), null);
	const expired = f.auth.issue(session, '203.0.113.7');
	f.advance(15001);
	assert.equal(f.auth.consume(expired), null);
});

test('logout revokes live sessions and unused tickets', async t => {
	const f = await fixture(t);
	await f.request('guest', {});
	const session = f.session(), ticket = f.auth.issue(session, '203.0.113.7');
	let revoked;
	f.auth.onRevoke = value => { revoked = value; };
	await f.request('logout', {});
	assert.equal(revoked, session);
	assert.equal(f.auth.consume(ticket), null);
	assert.equal((await f.request('session')).body.active, false);
});

test('BYOND login uses the official origin and fixed callback; cross-site return rotates the Strict cookie', async t => {
	let received;
	const f = await fixture(t, async (...args) => { received = args; return 'testplayer'; });
	const start = await f.request('byond/start', {}), originalCookie = f.getCookie();
	const login = new URL(start.body.url), target = new URL(login.searchParams.get('url'));
	assert.equal(login.origin, 'https://secure.byond.com');
	assert.equal(login.pathname, '/login.cgi');
	assert.equal(target.origin, f.auth.origin);
	assert.equal(target.pathname, '/auth/byond/callback');
	assert.match(start.headers.get('set-cookie'), /__Host-seeker-login=.*HttpOnly; SameSite=Lax;.*Secure/);
	successful(await f.callback(start));
	assert.deepEqual(received, ['valid-certificate', f.auth.origin, '127.0.0.1']);
	assert.notEqual(f.getCookie(), originalCookie);
	assert.equal(f.session().ckey, 'testplayer');
	assert.equal(f.session().active, true);
});

test('callback requires both browser binding and state before invoking the verifier', async t => {
	let calls = 0;
	const f = await fixture(t, async () => { calls++; return 'testplayer'; });
	const start = await f.request('byond/start', {});
	rejected(await f.callback(start, undefined, { Cookie: '' }));
	rejected(await f.callback(start, undefined, { Cookie: f.auth.loginCookie + '=' + '0'.repeat(64) }));
	const login = new URL(start.body.url), target = new URL(login.searchParams.get('url'));
	rejected(await f.request('byond/callback?state=' + '0'.repeat(64) + '&byondcert=valid-certificate'));
	rejected(await f.request('byond/callback' + target.search + '&state=extra&byondcert=valid-certificate'));
	assert.equal(calls, 0);
	assert.equal(f.session().active, false);
});

test('callbacks are single-use and cannot accept a caller-provided ckey', async t => {
	let calls = 0;
	const f = await fixture(t, async () => { calls++; return 'testplayer'; });
	const start = await f.request('byond/start', {}), oldCookies = f.jar();
	const target = new URL(new URL(start.body.url).searchParams.get('url'));
	successful(await f.request('byond/callback' + target.search + '&byondcert=valid-certificate&ckey=admin'));
	assert.equal(f.session().ckey, 'testplayer');
	rejected(await f.callback(start, undefined, { Cookie: oldCookies }));
	assert.equal(calls, 1);
});

test('expired logins, rejected certificates and Hub failures fail closed', async t => {
	for (const verify of [async () => null, async () => { throw new Error('Hub unavailable'); }, async () => 'Guest123', async () => 'stm123']) {
		const f = await fixture(t, verify);
		const start = await f.request('byond/start', {});
		rejected(await f.callback(start));
		assert.equal(f.session().active, false);
	}
	const f = await fixture(t);
	const start = await f.request('byond/start', {});
	f.advance(600001);
	rejected(await f.callback(start));
	assert.equal(f.session(), null);
});

test('logout during certificate verification cannot resurrect the session', async t => {
	let release, started;
	const waiting = new Promise(resolve => { started = resolve; });
	const f = await fixture(t, () => { started(); return new Promise(resolve => { release = resolve; }); });
	const start = await f.request('byond/start', {}), result = f.callback(start);
	await waiting;
	await f.request('logout', {});
	release('testplayer');
	rejected(await result);
	assert.equal((await f.request('session')).body.active, false);
	assert.equal(f.auth.certificateChecks, 0);
});

test('starting a new login invalidates an in-flight callback', async t => {
	let release, started;
	const waiting = new Promise(resolve => { started = resolve; });
	const f = await fixture(t, () => { started(); return new Promise(resolve => { release = resolve; }); });
	const start = await f.request('byond/start', {}), result = f.callback(start);
	await waiting;
	await f.request('byond/start', {});
	release('testplayer');
	rejected(await result);
	assert.equal(f.session().active, false);
});

test('only four certificate verifications can run concurrently', async t => {
	const blocked = [];
	const f = await fixture(t, () => new Promise(resolve => blocked.push(resolve)));
	const requests = [];
	for (let i = 0; i < 4; i++) {
		const start = await f.request('byond/start', {});
		requests.push(f.callback(start));
		while (blocked.length <= i) await new Promise(resolve => setTimeout(resolve, 5));
		f.clearCookies();
	}
	const start = await f.request('byond/start', {});
	rejected(await f.callback(start));
	assert.equal(blocked.length, 4);
	blocked.forEach(resolve => resolve(null));
	for (const result of await Promise.all(requests)) rejected(result);
	assert.equal(f.auth.certificateChecks, 0);
});

test('cross-site posts and non-JSON forms cannot start authentication', async t => {
	const f = await fixture(t);
	assert.equal((await f.request('byond/start', {}, { Origin: 'https://evil.example' })).status, 403);
	assert.equal((await f.request('guest', {}, { Origin: '' })).status, 403);
	assert.equal((await f.request('guest', {}, { 'Content-Type': 'text/plain' })).status, 403);
	assert.equal(f.auth.sessions.size, 0);
});

test('oversized requests, malformed certificates and excessive attempts are rejected', async t => {
	let calls = 0;
	const f = await fixture(t, async () => { calls++; return 'testplayer'; });
	const start = await f.request('byond/start', {});
	rejected(await f.callback(start, 'x'.repeat(2049)));
	rejected(await f.callback(start, 'x\nckey=admin'));
	assert.equal(calls, 0);
	assert.equal((await f.request('guest', { text: 'x'.repeat(3000) })).status, 413);
	for (let i = 0; i < 13; i++) await f.request('byond/start', {});
	assert.match((await f.request('byond/start', {})).body.error, /Слишком много/);
});

test('forwarded addresses are trusted only from the local nginx peer', async t => {
	const f = await fixture(t);
	assert.equal(f.auth.address({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.4' } }), '203.0.113.4');
	assert.equal(f.auth.address({ socket: { remoteAddress: '203.0.113.8' }, headers: { 'x-real-ip': '203.0.113.4' } }), '203.0.113.8');
	assert.throws(() => f.auth.address({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': 'unknown' } }));
});

test('pending logins are not persisted and revoked owners cannot mint tickets', async t => {
	const f = await fixture(t);
	await f.request('byond/start', {});
	f.advance(600001);
	assert.equal(f.session(), null);
	await f.request('guest', {});
	const guest = f.session();
	await f.request('byond/start', {});
	assert.equal(fs.readFileSync(f.auth.stateFile, 'utf8').includes('binding'), false);
	f.advance(86400000);
	assert.equal(f.session(), guest);
	await f.request('logout', {});
	assert.throws(() => f.auth.issue(guest, '203.0.113.7'));
});

test('a flooded shared IP cannot prevent an existing user from logging out', async t => {
	const f = await fixture(t);
	await f.request('guest', {});
	for (let i = 0; i < 16; i++) await f.request('byond/start', {});
	assert.equal((await f.request('logout', {})).status, 200);
	assert.equal((await f.request('session')).body.active, false);
});

test('the certificate is accepted whichever separator the Hub appends it with', async t => {
	for (const separator of ['&', ';', '?']) {
		const f = await fixture(t);
		const start = await f.request('byond/start', {});
		const target = new URL(new URL(start.body.url).searchParams.get('url'));
		successful(await f.request('byond/callback' + target.search + separator + 'byondcert=valid-certificate', undefined, {
			Cookie: f.auth.loginCookie + '=' + f.jar().match(new RegExp(f.auth.loginCookie + '=([0-9a-f]+)'))[1], Origin: '',
		}));
		assert.equal(f.session().ckey, 'testplayer');
	}
});

test('one address keeps a bounded number of anonymous sessions without blocking others', async t => {
	const f = await fixture(t);
	for (let i = 0; i < 25; i++) {
		if (i && i % 15 === 0) f.advance(60001);
		f.clearCookies();
		assert.equal((await f.request('guest', {}, { 'X-Real-IP': '203.0.113.9' })).status, 200);
	}
	assert.equal([...f.auth.sessions.values()].filter(value => value.address === '203.0.113.9').length, 20);
	f.clearCookies();
	assert.equal((await f.request('guest', {}, { 'X-Real-IP': '203.0.113.10' })).status, 200);
	assert.equal(f.session().address, '203.0.113.10');
});

test('a full session table evicts the oldest anonymous session and keeps BYOND logins', async t => {
	const f = await fixture(t, undefined, { maxSessions: 3 });
	const revoked = [];
	f.auth.onRevoke = value => revoked.push(value);
	successful(await f.callback(await f.request('byond/start', {}, { 'X-Real-IP': '203.0.113.1' })));
	const player = f.session();
	const guests = [];
	for (const address of ['203.0.113.2', '203.0.113.3', '203.0.113.4']) {
		f.advance(1000);
		f.clearCookies();
		assert.equal((await f.request('guest', {}, { 'X-Real-IP': address })).status, 200);
		guests.push(f.session());
	}
	assert.equal(f.auth.sessions.size, 3);
	assert.ok([...f.auth.sessions.values()].includes(player));
	assert.ok(revoked.includes(guests[0]));
	assert.equal(guests[0].active, false);
});

test('guest login follows the game setting', async t => {
	const f = await fixture(t);
	f.auth.guestsAllowed = async () => false;
	assert.equal((await f.request('guest', {})).status, 403);
	assert.equal(f.auth.sessions.size, 0);
	f.auth.guestsAllowed = async () => true;
	assert.equal((await f.request('guest', {})).status, 200);
});

test('real DreamDaemon CGI rejects a forged certificate', { skip: !process.env.SEEKER_BYOND_RUNTIME }, async () => {
	assert.equal(await verifyCertificate('invalid', 'https://spacestation13new.ru', '203.0.113.42'), null);
});
// fetch() drops Host: a request by another name of the site goes out through http
function byName(f, host, route, data, headers = {}) {
	return new Promise((resolve, reject) => {
		const body = data === undefined ? undefined : JSON.stringify(data);
		const req = http.request({ host: '127.0.0.1', port: f.port(), path: '/auth/' + route, method: body === undefined ? 'GET' : 'POST',
			headers: { Host: host, 'Content-Type': 'application/json', ...headers } }, res => {
			let text = '';
			res.on('data', chunk => { text += chunk; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: res.statusCode === 303 ? null : JSON.parse(text) }));
		});
		req.on('error', reject);
		req.end(body);
	});
}

test('a mirror name has its own Origin and BYOND callback; other names fall back to the main one', async t => {
	let received;
	const f = await fixture(t, async (...args) => { received = args; return 'testplayer'; }, { origin: 'https://station.example, https://ru.station.example' });
	assert.equal(f.auth.origin, 'https://station.example');
	assert.equal(f.auth.originOf({ headers: { host: 'ru.station.example' } }), 'https://ru.station.example');
	assert.equal(f.auth.originOf({ headers: { host: 'evil.example' } }), 'https://station.example');
	const mirror = 'ru.station.example', origin = { Origin: 'https://ru.station.example' };
	assert.equal((await byName(f, 'station.example', 'guest', {}, origin)).status, 403);
	assert.equal((await byName(f, mirror, 'guest', {}, origin)).status, 200);
	const start = await byName(f, mirror, 'byond/start', {}, origin);
	const target = new URL(new URL(start.body.url).searchParams.get('url'));
	assert.equal(target.origin, 'https://ru.station.example');
	const binding = start.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith(f.auth.loginCookie + '='));
	target.searchParams.set('byondcert', 'valid-certificate');
	const back = await byName(f, mirror, 'byond/callback' + target.search, undefined, { Cookie: binding });
	assert.equal(back.headers.location, '/login.html?byond=success');
	assert.deepEqual(received, ['valid-certificate', 'https://ru.station.example', '127.0.0.1']);
});
