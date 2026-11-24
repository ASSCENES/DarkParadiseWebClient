const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

async function verifyCertificate(certificate, origin, address) {
	const runtime = process.env.SEEKER_BYOND_RUNTIME;
	if (!runtime) throw new Error('BYOND authentication is not configured');
	const site = new URL(origin);
	const { stdout } = await runFile(path.join(runtime, 'ld-linux.so.2'), [
		'--library-path', runtime, path.join(runtime, 'DreamDaemon'),
		path.join(__dirname, 'byond-auth.dmb'), '-CGI', '-quiet', '-ultrasafe',
	], {
		cwd: runtime, timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 16384,
		env: {
			...process.env, LD_LIBRARY_PATH: runtime, GATEWAY_INTERFACE: 'CGI/1.1',
			REQUEST_METHOD: 'GET', SERVER_PROTOCOL: 'HTTP/1.1', SERVER_NAME: site.hostname,
			SERVER_PORT: site.port || '443', HTTPS: 'on', HTTP_HOST: site.host,
			SCRIPT_NAME: '/auth/byond/callback', REMOTE_ADDR: address,
			QUERY_STRING: new URLSearchParams({ byondcert: certificate }).toString(),
		},
	});
	const separator = stdout.match(/\r?\n\r?\n/);
	if (!separator || !/^Content-Type: application\/json\s*$/im.test(stdout.slice(0, separator.index))) return null;
	try {
		const identity = JSON.parse(stdout.slice(separator.index + separator[0].length));
		return /^[a-z][a-z0-9]{1,31}$/.test(identity.ckey) && !/^(guest|stm)/.test(identity.ckey) ? identity.ckey : null;
	} catch (_) { return null; }
}

module.exports = { verifyCertificate };
