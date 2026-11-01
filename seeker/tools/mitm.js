// Decrypting relay between DreamSeeker and a world, for protocol research:
// node tools/mitm.js <listen port> <world host:port> [log file]
// Logs every client->server message (and server message types) after the handshake.
const net = require('net');
const fs = require('fs');
const { decrypt } = require('../proto/crypt');
const [listen, target, logFile] = [+process.argv[2], process.argv[3], process.argv[4] || 'mitm.log'];
const [host, port] = target.split(':');
const log = s => fs.appendFileSync(logFile, s + '\n');

net.createServer(client => {
	const server = net.connect(+port, host);
	let R = null, key = null, cbuf = Buffer.alloc(0), sbuf = Buffer.alloc(0), first = true;
	client.on('data', d => {
		server.write(d);
		cbuf = Buffer.concat([cbuf, d]);
		for (;;) {
			if (first) {
				if (cbuf.length < 4) break;
				const len = cbuf.readUInt16BE(2);
				if (cbuf.length < 4 + len) break;
				const p = cbuf.subarray(4, 4 + len);
				R = (p.readUInt32LE(8) + 0x01140204) >>> 0;
				log('C hello ' + p.toString('hex'));
				cbuf = cbuf.subarray(4 + len); first = false; continue;
			}
			if (cbuf.length < 6 || key === null) break;
			const type = cbuf.readUInt16BE(2), len = cbuf.readUInt16BE(4);
			if (cbuf.length < 6 + len) break;
			const { data, ok } = decrypt(cbuf.subarray(6, 6 + len), key);
			log('C ' + type + ' ' + (ok ? '' : 'BAD ') + data.toString('hex') + '  ' + JSON.stringify(data.toString('latin1')));
			cbuf = cbuf.subarray(6 + len);
		}
	});
	server.on('data', d => {
		client.write(d);
		sbuf = Buffer.concat([sbuf, d]);
		for (;;) {
			if (sbuf.length < 4) break;
			let type = sbuf.readUInt16BE(0), len = sbuf.readUInt16BE(2), head = 4;
			if (type === 160 && len === 6) { if (sbuf.length < 10) break; type = sbuf.readUInt16BE(4); len = sbuf.readUInt32BE(6); head = 10; }
			if (sbuf.length < head + len) break;
			const enc = sbuf.subarray(head, head + len);
			sbuf = sbuf.subarray(head + len);
			if (key === null && type === 1) {
				const p = decrypt(enc, R).data;
				let o = 11;
				for (;;) { const x = p.readUInt32LE(o); o += 4; if ((((x + 0x1BD632F) >>> 0) & 0x4008000) === 0) break; }
				key = (R + p.readUInt32LE(o)) >>> 0;
				log('S hello, key ' + key.toString(16));
				continue;
			}
			log('S ' + type + ' (' + len + ')');
		}
	});
	const end = () => { client.destroy(); server.destroy(); };
	client.on('error', end); server.on('error', end); client.on('close', end); server.on('close', end);
}).listen(listen, '127.0.0.1', () => console.log('relay on', listen, '->', target));
