const net = require('node:net');

const offline = { ready: false, guests: null };

// One world Topic ("?query" over the BYOND port): the JSON it answers with, or null
function topic(target, query) {
	const [host, port] = target.split(':');
	return new Promise(resolve => {
		let buffer = Buffer.alloc(0), completed = false;
		const socket = net.connect(+port, host);
		const finish = data => {
			if (completed) return;
			completed = true;
			socket.destroy();
			resolve(data);
		};
		socket.setTimeout(2000, () => finish(null));
		socket.on('error', () => finish(null));
		socket.on('close', () => finish(null));
		socket.on('connect', () => {
			const text = Buffer.from(query + '\0');
			const packet = Buffer.alloc(9 + text.length);
			packet.writeUInt16BE(0x83, 0);
			packet.writeUInt16BE(5 + text.length, 2);
			text.copy(packet, 9);
			socket.write(packet);
		});
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > 65536) return finish(null);
			if (buffer.length < 5 || buffer.length < 4 + buffer.readUInt16BE(2)) return;
			try {
				if (buffer.readUInt16BE(0) !== 0x83 || buffer[4] !== 6) return finish(null);
				const end = buffer.indexOf(0, 5);
				finish(JSON.parse(buffer.toString('utf8', 5, end === -1 ? buffer.length : end)));
			} catch (_) { finish(null); }
		});
	});
}

// Paradise locks an address out of world Topic for a minute after 5 requests less than 0.5 s apart, and every
// request while locked out renews it: Topics to a target go one at a time, 2 s apart, and after an empty answer
// (locked out, or no such handler) nothing is asked for 65 s
const TOPIC_GAP = 2000, QUIET_AFTER_NULL = 65000;
const lines = new Map(); // target -> { last, chain, quietUntil }
function spacedTopic(target, query) {
	let line = lines.get(target);
	if (!line) lines.set(target, line = { last: 0, chain: Promise.resolve(), quietUntil: 0 });
	const run = line.chain.then(async () => {
		if (Date.now() < line.quietUntil) return null;
		const wait = line.last + TOPIC_GAP - Date.now();
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
		const data = await topic(target, query);
		line.last = Date.now();
		if (data === null) line.quietUntil = line.last + QUIET_AFTER_NULL;
		return data;
	});
	line.chain = run.catch(() => {});
	return run;
}

// Answers kept 15 s per query and target, one request in flight at a time
const cache = new Map();
function cached(target, key, ask) {
	let entry = cache.get(key);
	if (!entry) cache.set(key, entry = {});
	if (entry.target === target && Date.now() - entry.at < 15000) return Promise.resolve(entry.value);
	if (entry.pending) return entry.pending;
	entry.pending = ask().then(value => {
		Object.assign(entry, { target, at: Date.now(), value });
		return value;
	}).finally(() => { entry.pending = null; });
	return entry.pending;
}

function gameStatus(target) {
	return cached(target, 'seeker_auth', () => spacedTopic(target, 'seeker_auth=1').then(data => {
		const ready = data?.ready === 1 && data.version === 2;
		return ready ? { ready, guests: 'guests' in data ? data.guests === 1 : null } : offline;
	}));
}
const gameReady = target => gameStatus(target).then(status => status.ready);

// What the landing page shows: players online, the map and how long the round runs
function worldStatus(target) {
	return cached(target, 'status', () => spacedTopic(target, 'status').then(data => data && {
		players: Number.isInteger(data.players) ? data.players : null,
		map: typeof data.map_name === 'string' ? data.map_name.slice(0, 64) : null,
		roundtime: typeof data.roundtime === 'string' ? data.roundtime.slice(0, 16) : null,
	}));
}
module.exports = { gameReady, gameStatus, worldStatus };
