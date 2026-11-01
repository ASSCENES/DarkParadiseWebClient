// Where does a native login carry the connection topic (byond://host:port?topic)? Logs in to a test world
// that prints "TOPIC=[...]" and tries one login payload layout: node tools/topic-probe.js <variant>
const { ByondConnection } = require('../proto/byond-conn');
const GUEST = Buffer.from('00007ecc5a2e893573d76d976cb5f6001174096f7f4556aebd6c201f2c2de94284a7660df17f2081cc1a0000000000', 'hex');
const topic = 'dpweb=abc123&x=1';
const t = Buffer.from(topic, 'latin1');
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const variants = {
	plain: GUEST,
	// the leading u16 0 as the topic's length
	head: Buffer.concat([u16(t.length), t, GUEST.subarray(2)]),
	// one of the trailing zero fields
	tail2: Buffer.concat([GUEST.subarray(0, GUEST.length - 5), u16(t.length), t, GUEST.subarray(GUEST.length - 3)]),
	tail4: Buffer.concat([GUEST.subarray(0, GUEST.length - 3), u16(t.length), t, GUEST.subarray(GUEST.length - 1)]),
	tail5: Buffer.concat([GUEST.subarray(0, GUEST.length - 2), u16(t.length), t]),
	end: Buffer.concat([GUEST, u16(t.length), t]),
};
const v = process.argv[2] || 'plain';
const c = new ByondConnection('127.0.0.1', 51985);
c.on('ready', () => c.send(26, variants[v]));
c.on('message', (type, d) => {
	if (type === 14) c.send(183);
	const s = d.toString('latin1'), i = s.indexOf('TOPIC=');
	if (type === 0) { console.log(v, 'kicked', d.toString('hex')); process.exit(0); }
	if (i >= 0) { console.log(v, '->', JSON.stringify(s.slice(i, i + 60))); process.exit(0); }
});
c.on('close', () => { console.log(v, 'closed'); process.exit(0); });
c.connect();
setTimeout(() => { console.log(v, 'timeout'); process.exit(0); }, 12000);
