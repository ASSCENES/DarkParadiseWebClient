const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

async function start(t, target, socketPath) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seeker-gateway-review-'));
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const origin = 'http://127.0.0.1:' + port;
	const child = spawn(process.execPath, ['server.js', '--dd', target, '--port', String(port), '--cache', path.join(directory, 'cache')], {
		cwd: __dirname, env: { ...process.env, SEEKER_DEBUG: '', SEEKER_ORIGIN: origin, SEEKER_AUTH_STATE: path.join(directory, 'sessions.json'), SEEKER_AUTH_SOCKET: socketPath || path.join(directory, 'verify.sock') },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let logs = '';
	child.stdout.on('data', data => { logs = (logs + data).slice(-4000); });
	child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
	t.after(async () => {
		if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
		fs.rmSync(directory, { recursive: true, force: true });
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error('Gateway failed: ' + logs);
		try { if ((await fetch(origin + '/auth/session')).ok) break; } catch (_) {}
		await new Promise(resolve => setTimeout(resolve, 20));
		if (attempt === 99) throw new Error('Gateway startup timed out: ' + logs);
	}
	return {
		origin, child,
		async request(route, cookie = '', data, headers = {}) {
			return fetch(origin + route, { redirect: 'manual', method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
		},
		async guest() {
			const response = await this.request('/auth/guest', '', {});
			assert.equal(response.status, 200);
			return response.headers.get('set-cookie').split(';')[0];
		},
		connect(cookie, originHeader = origin) {
			const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: originHeader, Cookie: cookie } });
			socket.on('error', () => {});
			return socket;
		},
	};
}

test('logout racing a delayed WebSocket upgrade cannot open an expired session', { skip: process.platform === 'win32' }, async t => {
	let querySocket, queried;
	const queryReceived = new Promise(resolve => { queried = resolve; });
	const fake = net.createServer(socket => socket.once('data', () => { querySocket = socket; queried(); }));
	await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => fake.close(resolve)));
	const gateway = await start(t, '127.0.0.1:' + fake.address().port);
	const cookie = await gateway.guest();
	const socket = gateway.connect(cookie);
	const result = new Promise((resolve, reject) => {
		socket.on('open', () => { socket.terminate(); reject(new Error('Expired session upgraded')); });
		socket.on('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
	});
	await queryReceived;
	assert.equal((await gateway.request('/auth/logout', cookie, {})).status, 200);
	const body = Buffer.from('\x06{"ready":1,"version":2}\0');
	const header = Buffer.alloc(4); header.writeUInt16BE(0x83); header.writeUInt16BE(body.length, 2);
	querySocket.end(Buffer.concat([header, body]));
	assert.equal(await result, 403);
	assert.equal((await gateway.request('/auth/session')).status, 200);
});

test('sessions stay isolated and hostile WebSocket input only closes its sender', { skip: !process.env.SEEKER_SMOKE_DD || process.platform === 'win32' }, async t => {
	const gateway = await start(t, process.env.SEEKER_SMOKE_DD, process.env.SEEKER_SMOKE_SOCKET);
	const firstCookie = await gateway.guest(), secondCookie = await gateway.guest();
	const open = cookie => new Promise((resolve, reject) => {
		const socket = gateway.connect(cookie);
		let sid, loggedIn = false;
		const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Game login timed out')); }, 10000);
		socket.on('message', raw => {
			const received = JSON.parse(raw);
			for (const message of Array.isArray(received) ? received : [received]) {
				if (message.t === 'session') sid = message.sid;
				if (message.t === 'out' && message.html.includes('PROOF:')) loggedIn = true;
			}
			if (sid && loggedIn) { clearTimeout(timeout); resolve({ socket, sid }); }
		});
		socket.on('unexpected-response', (_, response) => { clearTimeout(timeout); reject(new Error('Upgrade rejected: ' + response.statusCode)); });
	});
	const first = await open(firstCookie), second = await open(secondCookie);
	t.after(() => { first.socket.terminate(); second.socket.terminate(); });
	assert.notEqual(first.sid, second.sid);
	assert.equal((await gateway.request(`/a/${first.sid}/?test=1`, secondCookie)).status, 403);
	assert.equal((await gateway.request(`/a%2f${first.sid}%2f%5b0xc1%5d`, secondCookie)).status, 403);
	assert.equal((await gateway.request(`/a/${first.sid}/?test=1`, firstCookie, undefined, { Origin: 'https://evil.example' })).status, 403);
	assert.equal((await gateway.request(`/a/${first.sid}/?test=1`, firstCookie)).status, 204);
	const firstClosed = once(first.socket, 'close');
	first.socket.send(JSON.stringify({ t: 'verb', name: 'Security payload test', args: Array(20000).fill(0) }));
	assert.equal((await firstClosed)[0], 1008);
	assert.equal(second.socket.readyState, WebSocket.OPEN);
	assert.equal((await gateway.request('/auth/session', secondCookie)).status, 200);
	const secondClosed = once(second.socket, 'close');
	second.socket.send('x'.repeat(70000));
	assert.equal((await secondClosed)[0], 1009);
	assert.equal((await gateway.request('/auth/session', secondCookie)).status, 200);
});
