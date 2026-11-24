const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Auth } = require('./auth');
const { ByondConnection } = require('./proto/byond-conn');

const gameSocket = process.env.SEEKER_SMOKE_GAME_SOCKET || '/tmp/seeker-test/verify.sock';
const fixture = `
/world
\thub = ""
\tmob = /mob
\tturf = /turf
\tmaxx = 5
\tmaxy = 5
/world/New()
\tvar/result = call_ext("./libseekerauth.so", "initialize")(${JSON.stringify(gameSocket)})
\tif(result != "ok")
\t\tdel(world)
\treturn ..()
/world/IsBanned(key, address, computer_id, type)
\tworld.log << "SMOKE BAN [key] [address] [computer_id]"
\tif(key == "blocked")
\t\treturn list("desc" = "BANNED")
\tif(address == "203.0.113.66" || computer_id == "99991")
\t\treturn list("desc" = "BANNED ADDRESS OR CID")
/world/Topic(topic, address, master, key)
\treturn json_encode(list("ready" = 1, "version" = 2))
/client
\tvar/account_ckey
/client/verb/security_payload_test()
\tset name = "Security payload test"
\treturn
/client/New(topic)
\tvar/list/connection_params = params2list(topic)
\tif(!connection_params["seeker"])
\t\treturn null
\tvar/wrong_proof = "x[copytext(connection_params["seeker"], 2)]"
\tif(call_ext("./libseekerauth.so", "identity")(key, address, computer_id, wrong_proof))
\t\treturn null
\tvar/list/identity = params2list(call_ext("./libseekerauth.so", "identity")(key, address, computer_id, connection_params["seeker"]))
\tworld.log << "SMOKE NEW [key] [address] [computer_id]"
\tif(!identity["guest"])
\t\treturn null
\tif(call_ext("./libseekerauth.so", "identity")(key, address, computer_id, connection_params["seeker"]))
\t\treturn null
\taccount_ckey = identity["ckey"] || ckey
\tif(world.IsBanned(identity["ckey"] || key, address, computer_id, connection))
\t\treturn null
\treturn ..()
/mob/Login()
\t. = ..()
\tloc = locate(3, 3, 1)
\tsrc << "PROOF:[key]|[client.account_ckey]|[client.address]|[client.computer_id]"
\tworld.log << "SMOKE MOB [key]"
`;

async function main() {
	if (process.argv[2] === '--fixture') { fs.writeFileSync(process.argv[3], fixture); return; }
	const target = process.env.SEEKER_SMOKE_DD;
	const socketPath = process.env.SEEKER_SMOKE_SOCKET;
	if (!target || !socketPath) throw new Error('Set SEEKER_SMOKE_DD and SEEKER_SMOKE_SOCKET to an isolated test world.');
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seeker-smoke-'));
	const auth = new Auth({ origin: 'https://test.example', stateFile: path.join(directory, 'state.json'), socketPath });
	const connections = [];
	auth.listen();
	await new Promise(resolve => auth.socket.once('listening', resolve));
	const make = (ckey, address = '203.0.113.42', guest) => {
		const session = auth.create({ setHeader() {} });
		session.active = true;
		session.ckey = ckey;
		if (guest) session.guest = guest;
		return { session, token: auth.issue(session, address) };
	};
	const connect = (token, expectProof = true) => new Promise((resolve, reject) => {
		const [host, port] = target.split(':');
		const connection = new ByondConnection(host, +port);
		connections.push(connection);
		const timeout = setTimeout(() => reject(new Error('Test login timed out')), 10000);
		connection.on('ready', () => connection.send(26, Buffer.from(token + '\0')));
		connection.on('error', reject);
		connection.on('message', (type, data) => {
			if (process.env.SEEKER_SMOKE_DEBUG) console.log(type, data.length, type === 39 ? data.toString('utf8') : '');
			if (type === 14) {
				connection.send(183);
			}
			if (type === 0) {
				clearTimeout(timeout);
				if (expectProof) reject(new Error('Unexpected rejection: ' + data.toString('hex')));
				else resolve(null);
			}
			if (type === 39) {
				const proof = data.toString('utf8').match(/PROOF:([^<\0\r\n]+)/)?.[1];
				if (proof) { clearTimeout(timeout); resolve(proof.split('|')); }
			}
		});
		connection.connect();
	});
	try {
		const first = make(null), second = make(null), verified = make('testplayer');
		const a = await connect(first.token);
		const b = await connect(second.token);
		const registered = await connect(verified.token);
		assert.equal(a[0], first.session.guest);
		assert.equal(b[0], second.session.guest);
		assert.notEqual(a[0], b[0]);
		assert.notEqual(a[3], b[3]);
		assert.equal(a[2], '203.0.113.42');
		assert.equal(registered[1], 'testplayer');
		assert.equal(connections[0].sock.destroyed, false);
		assert.equal(connections[1].sock.destroyed, false);
		await connect(first.token, false);
		await connect('seeker-v2:' + '0'.repeat(64) + ':' + '0'.repeat(64), false);
		await connect(make('blocked').token, false);
		await connect(make(null, '203.0.113.66').token, false);
		await connect(make(null, '203.0.113.42', 'Guest-99991').token, false);
		console.log('PASS: concurrent guests, distinct CIDs, real IP, verified account, proof binding, replay/forgery and account/IP/CID bans');
	} finally {
		for (const connection of connections) connection.close();
		clearInterval(auth.sweep);
		await new Promise(resolve => auth.socket.close(resolve));
		fs.rmSync(directory, { recursive: true, force: true });
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
