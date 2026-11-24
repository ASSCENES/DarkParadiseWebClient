const net = require('node:net');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { ByondConnection } = require('./proto/byond-conn');
const { gameReady } = require('./game-status');

async function main() {
	const target = process.env.SEEKER_SMOKE_DD, socketPath = process.env.SEEKER_SMOKE_SOCKET;
	if (!target || !socketPath) throw new Error('Use an isolated test world and socket directory.');
	if (fs.existsSync(socketPath)) throw new Error('Test socket is already in use.');
	let accepted = 0;
	const blackhole = net.createServer(socket => { accepted++; socket.on('error', () => {}); socket.setTimeout(1000, () => socket.destroy()); });
	await new Promise(resolve => blackhole.listen(socketPath, resolve));
	try {
		for (let attempt = 0; attempt < 8; attempt++) await new Promise((resolve, reject) => {
			const [host, port] = target.split(':');
			const connection = new ByondConnection(host, +port);
			const timeout = setTimeout(() => { connection.close(); reject(new Error('Forged ticket blocked the game loop')); }, 2000);
			connection.on('error', reject);
			connection.on('ready', () => connection.send(26, Buffer.from('seeker-v2:' + String(attempt).padStart(64, '0') + ':' + '0'.repeat(64) + '\0')));
			connection.on('message', (type, data) => {
				if (type !== 0) return;
				clearTimeout(timeout);
				assert.equal(data.readUInt16LE(0), 9);
				connection.close(); resolve();
			});
			connection.connect();
		});
		assert.equal(accepted, 0, 'Invalid signatures reached the blocking socket');
		assert.equal(await gameReady(target), true);
		console.log('PASS: forged signatures are rejected before IPC; an unresponsive authority cannot stall forged logins.');
	} finally { await new Promise(resolve => blackhole.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
