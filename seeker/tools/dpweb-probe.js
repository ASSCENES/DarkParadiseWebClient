// Probe of a "dpweb" ticket login (Dark Paradise's web gateway): logs what the server sends.
// node tools/dpweb-probe.js https://serverhostdarkparadise.ru/webtest
const WebSocket = require('ws');
const base = (process.argv[2] || 'https://serverhostdarkparadise.ru/webtest').replace(/\/$/, '');
const origin = new URL(base).origin;

(async () => {
	const r = await fetch(base + '/auth/key', { headers: { Referer: base + '/', Origin: origin }, cache: 'no-store' });
	const { key } = await r.json();
	console.log('ticket', key);
	const ws = new WebSocket(base.replace(/^http/, 'ws') + '/', { headers: { Origin: origin } });
	ws.binaryType = 'nodebuffer';
	const msg = (type, ...parts) => Buffer.concat([Buffer.from([type >> 8, type & 255]), ...parts]);
	const cstr = s => Buffer.from(s + '\0', 'latin1');
	const seen = {};
	ws.on('open', () => console.log('open'));
	ws.on('message', d => {
		const type = d.readUInt16BE(0), p = d.subarray(2);
		seen[type] = (seen[type] || 0) + 1;
		if (seen[type] <= 2) console.log('<<', type, p.length, p.subarray(0, 48).toString('hex'), JSON.stringify(p.subarray(0, 60).toString('latin1')));
		if (type === 1) ws.send(msg(1, Buffer.from([0]), cstr(new URL(base).hostname), cstr('')));
		if (type === 26 && !p.length) ws.send(msg(26, cstr(key)));
		if (type === 225 && !p[0]) ws.send(msg(225, Buffer.from([1])));
	});
	ws.on('close', (c, why) => { console.log('close', c, String(why), JSON.stringify(seen)); process.exit(0); });
	ws.on('error', e => console.log('error', e.message));
	setTimeout(() => { console.log('seen', JSON.stringify(seen)); ws.close(); }, 25000);
})();
