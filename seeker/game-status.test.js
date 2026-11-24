const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { gameStatus } = require('./game-status');

for (const [label, data, expected] of [
	['updated game', { ready: 1, version: 2 }, { ready: true, guests: null }],
	['guests allowed', { ready: 1, version: 2, guests: 1 }, { ready: true, guests: true }],
	['guests closed', { ready: 1, version: 2, guests: 0 }, { ready: true, guests: false }],
	['disabled adapter', { ready: 0, version: 2, guests: 0 }, { ready: false, guests: null }],
	['old adapter', { ready: 1, version: 1 }, { ready: false, guests: null }],
	['unknown protocol', { ready: 1, version: 3 }, { ready: false, guests: null }],
	['old game', null, { ready: false, guests: null }],
]) {
	test(label, async t => {
		const server = net.createServer(socket => socket.once('data', request => {
			assert.equal(request.readUInt16BE(0), 0x83);
			assert.equal(request.subarray(9).toString(), 'seeker_auth=1\0');
			const body = Buffer.from('\x06' + JSON.stringify(data) + '\0');
			const header = Buffer.alloc(4);
			header.writeUInt16BE(0x83, 0); header.writeUInt16BE(body.length, 2);
			socket.write(header.subarray(0, 2));
			setImmediate(() => socket.end(Buffer.concat([header.subarray(2), body])));
		}));
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		t.after(() => new Promise(resolve => server.close(resolve)));
		assert.deepEqual(await gameStatus('127.0.0.1:' + server.address().port), expected);
	});
}

test('Topics to one server go out at least 2 s apart, so its spam filter never locks the gateway out', async t => {
	const { worldStatus } = require('./game-status');
	const arrivals = [];
	const server = net.createServer(socket => socket.once('data', request => {
		arrivals.push(Date.now());
		const ask = request.subarray(9).toString();
		const data = ask.startsWith('seeker_auth') ? { ready: 1, version: 2 } : { players: 3, map_name: 'Delta', roundtime: '00:10' };
		const body = Buffer.from('\x06' + JSON.stringify(data) + '\0');
		const header = Buffer.alloc(4);
		header.writeUInt16BE(0x83, 0); header.writeUInt16BE(body.length, 2);
		socket.end(Buffer.concat([header, body]));
	}));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	const target = '127.0.0.1:' + server.address().port;
	const [status, world] = await Promise.all([gameStatus(target), worldStatus(target)]);
	assert.deepEqual(status, { ready: true, guests: null });
	assert.deepEqual(world, { players: 3, map: 'Delta', roundtime: '00:10' });
	assert.equal(arrivals.length, 2);
	assert.ok(arrivals[1] - arrivals[0] >= 1900, 'second Topic came ' + (arrivals[1] - arrivals[0]) + ' ms after the first');
});
