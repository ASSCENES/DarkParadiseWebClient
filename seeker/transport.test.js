const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ByondConnection } = require('./proto/byond-conn');

test('a packet at the protocol limit is sent; oversized input closes only its transport', () => {
	const connection = new ByondConnection('127.0.0.1', 1);
	let writes = 0, closed = false, error;
	connection.ready = true; connection.key = 1; connection.seq = 1;
	connection.sock = { write(data) { writes++; assert.equal(data.readUInt16BE(4), 65535); }, destroy() { closed = true; } };
	connection.on('error', value => { error = value; });
	connection.send(129, Buffer.alloc(65534));
	assert.equal(writes, 1);
	assert.doesNotThrow(() => connection.send(129, Buffer.alloc(65535)));
	assert.equal(closed, true);
	assert.equal(connection.ready, false);
	assert.ok(error instanceof RangeError);
	assert.equal(writes, 1);
});
