const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { verifyCertificate } = require('./byond-auth');

const SESSION_MS = 30 * 86400000;
const LOGIN_MS = 10 * 60000;
const TICKET_MS = 15000;
const SESSIONS_PER_ADDRESS = 20;
const random = () => crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookie = (req, name) => String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const callbackParams = url => {
	const params = new Map();
	for (const pair of url.search.slice(1).split(/[&;?]/)) {
		if (!pair) continue;
		const split = pair.indexOf('=');
		let key, value;
		try {
			key = decodeURIComponent(split < 0 ? pair : pair.slice(0, split));
			value = split < 0 ? '' : decodeURIComponent(pair.slice(split + 1));
		} catch (_) { return null; }
		params.set(key, [...(params.get(key) || []), value]);
	}
	return params;
};

class Auth {
	constructor({ origin, stateFile, socketPath, verifyByond = verifyCertificate, now = Date.now, maxSessions = 10000 }) {
		this.maxSessions = maxSessions;
		// one site under several names (a mirror for countries that cut the main one): "a,b", the first is the main one
		this.origins = String(origin).split(',').map(value => new URL(value.trim()).origin);
		this.origin = this.origins[0];
		this.cookieName = this.origin.startsWith('https:') ? '__Host-seeker' : 'seeker';
		this.stateFile = stateFile;
		this.socketPath = socketPath;
		this.verifyByond = verifyByond;
		this.loginCookie = this.cookieName + '-login';
		this.now = now;
		this.certificateChecks = 0;
		this.secretFile = path.join(path.dirname(socketPath || stateFile), 'ticket.key');
		try { fs.writeFileSync(this.secretFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
		catch (error) { if (error.code !== 'EEXIST') throw error; }
		this.secret = fs.readFileSync(this.secretFile);
		if (this.secret.length !== 32) throw new Error('Invalid authentication signing key');
		fs.chmodSync(this.secretFile, 0o600);
		this.sessions = new Map();
		this.tickets = new Map();
		this.attempts = new Map();
		if (fs.existsSync(stateFile)) {
			for (const [key, session] of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
				if (session.expires > now()) this.sessions.set(key, session);
			}
		}
		this.sweep = setInterval(() => {
			for (const [key, value] of this.tickets) if (value.expires <= now()) this.tickets.delete(key);
			for (const [key, value] of this.attempts) if (value.until <= now()) this.attempts.delete(key);
			for (const [key, value] of this.sessions) if (value.expires <= now()) this.sessions.delete(key);
		}, 60000).unref();
	}

	save() {
		const filename = this.stateFile + '.tmp';
		fs.writeFileSync(filename, JSON.stringify([...this.sessions].map(([key, value]) => [key, {
			guest: value.guest, ckey: value.ckey, expires: value.expires, active: value.active, address: value.address,
		}])), { mode: 0o600 });
		fs.renameSync(filename, this.stateFile);
	}

	// the site's name this request came by (its cookies, BYOND callback and Origin are that name's)
	originOf(req) {
		return this.origins.find(value => new URL(value).host === req.headers.host) || this.origin;
	}

	session(req) {
		const id = cookie(req, this.cookieName);
		const session = id && this.sessions.get(crypto.createHash('sha256').update(id).digest('hex'));
		return session && session.expires > this.now() ? session : null;
	}

	revoke(session) {
		session.active = false;
		for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
		this.onRevoke?.(session);
	}

	create(res, address, previous = null) {
		for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
		if (previous) this.revoke(previous);
		const anonymous = [...this.sessions.values()].filter(value => !value.ckey).sort((a, b) => a.expires - b.expires);
		const own = anonymous.filter(value => value.address === address);
		if (own.length >= SESSIONS_PER_ADDRESS) this.revoke(own[0]);
		else if (this.sessions.size >= this.maxSessions) {
			if (!anonymous.length) throw new Error('Слишком много сессий. Попробуйте позже.');
			this.revoke(anonymous[0]);
		}
		const id = random();
		let guest;
		do { guest = 'Guest-' + crypto.randomInt(1, 2 ** 48); } while ([...this.sessions.values()].some(value => value.guest === guest));
		const session = { guest, ckey: null, active: false, expires: this.now() + LOGIN_MS, address };
		this.sessions.set(crypto.createHash('sha256').update(id).digest('hex'), session);
		res.setHeader('Set-Cookie', `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${this.origin.startsWith('https:') ? '; Secure' : ''}`);
		return session;
	}

	address(req) {
		const peer = req.socket.remoteAddress || '';
		const forwarded = req.headers['x-real-ip'];
		const address = /^(127\.|::1$|::ffff:127\.)/.test(peer) && typeof forwarded === 'string' ? forwarded : peer.replace(/^::ffff:/, '');
		if (!net.isIP(address)) throw new Error('Не удалось определить IP подключения.');
		return address;
	}

	limit(req) {
		const key = this.address(req);
		let entry = this.attempts.get(key);
		if (!entry || entry.until <= this.now()) {
			if (this.attempts.size >= 10000) throw new Error('Слишком много запросов. Попробуйте позже.');
			this.attempts.set(key, entry = { count: 0, until: this.now() + 60000 });
		}
		if (++entry.count > 15) throw new Error('Слишком много попыток. Подождите минуту.');
	}

	issue(session, address) {
		if (!session.active || session.expires <= this.now() || ![...this.sessions.values()].includes(session)) throw new Error('Сессия истекла. Войдите снова.');
		if (!net.isIP(address)) throw new Error('Invalid player address');
		if (this.tickets.size >= 10000) throw new Error('Слишком много подключений. Попробуйте позже.');
		const nonce = 'seeker-v2:' + random();
		const token = nonce + ':' + crypto.createHmac('sha256', this.secret).update(nonce).digest('hex');
		this.tickets.set(token, { session, address, expires: this.now() + TICKET_MS });
		return token;
	}

	consume(token) {
		const ticket = this.tickets.get(token);
		this.tickets.delete(token);
		if (!ticket || ticket.expires <= this.now() || !ticket.session.active || ticket.session.expires <= this.now() || ![...this.sessions.values()].includes(ticket.session)) return null;
		return { guest: ticket.session.guest, ckey: ticket.session.ckey, address: ticket.address };
	}

	listen() {
		if (!this.socketPath || process.platform === 'win32') throw new Error('Seeker authentication requires a private Unix socket on Linux.');
		if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
		this.socket = net.createServer(socket => {
			let input = '';
			socket.on('error', () => {});
			socket.setTimeout(1000, () => socket.destroy());
			socket.on('data', chunk => {
				input += chunk.toString('ascii');
				if (input.length > 140) return socket.destroy();
				if (!input.endsWith('\n')) return;
				const ticket = /^seeker-v2:[0-9a-f]{64}:[0-9a-f]{64}\n$/.test(input) && this.consume(input.trim());
				socket.end(ticket ? `OK ${ticket.guest} ${ticket.ckey || '-'} ${ticket.address}\n` : 'NO\n');
			});
		});
		this.socket.listen(this.socketPath, () => fs.chmodSync(this.socketPath, 0o600));
		this.socket.on('error', error => { console.error('Authentication socket unavailable:', error.message); process.exit(1); });
	}

	async handle(req, res, url) {
		if (!url.pathname.startsWith('/auth/')) return false;
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		const reply = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); return true; };
		let session = this.session(req);
		if (url.pathname === '/auth/byond/callback') {
			if (req.method !== 'GET') return reply(405, { error: 'Нужен GET-запрос.' });
			const finish = success => {
				res.writeHead(303, { Location: '/login.html?byond=' + (success ? 'success' : 'error') });
				res.end();
				return true;
			};
			try {
				this.limit(req);
				const params = callbackParams(url);
				const [state] = params?.get('state') || [], [certificate] = params?.get('byondcert') || [];
				const binding = cookie(req, this.loginCookie);
				if (!params || !/^[0-9a-f]{64}$/.test(state || '') || !/^[0-9a-f]{64}$/.test(binding || '') ||
					params.get('state').length !== 1 || params.get('byondcert').length !== 1 ||
					!certificate || certificate.length > 2048 || /[\x00-\x20\x7f]/.test(certificate)) return finish(false);
				session = [...this.sessions.values()].find(value => value.login?.state === state);
				const login = session?.login;
				if (!login || login.used || login.expires <= this.now() || session.expires <= this.now() ||
					!crypto.timingSafeEqual(Buffer.from(login.binding, 'hex'), Buffer.from(hash(binding), 'hex'))) return finish(false);
				if (this.certificateChecks >= 4) return finish(false);
				login.used = true;
				this.certificateChecks++;
				let ckey;
				try { ckey = await this.verifyByond(certificate, this.originOf(req), this.address(req)); }
				finally { this.certificateChecks--; }
				if (!/^[a-z][a-z0-9]{1,31}$/.test(ckey || '') || /^(guest|stm)/.test(ckey) ||
					session.login !== login || login.expires <= this.now() || session.expires <= this.now() ||
					![...this.sessions.values()].includes(session)) return finish(false);
				session = this.create(res, this.address(req), session);
				session.ckey = ckey;
				session.active = true;
				session.expires = this.now() + SESSION_MS;
				this.save();
				res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), `${this.loginCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
				return finish(true);
			} catch (_) { return finish(false); }
		}
		if (url.pathname === '/auth/session' && req.method === 'GET') return reply(200, {
			active: !!session?.active, ckey: session?.ckey || null, guest: session?.active ? session.guest : null,
		});
		if (req.method !== 'POST') return reply(405, { error: 'Нужен POST-запрос.' });
		if (req.headers.origin !== this.originOf(req) || req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(403, { error: 'Недопустимый источник запроса.' });
		try {
			if (url.pathname !== '/auth/logout') this.limit(req);
			let body = '';
			for await (const chunk of req) {
				body += chunk;
				if (Buffer.byteLength(body) > 2048) return reply(413, { error: 'Слишком большой запрос.' });
			}
			const data = JSON.parse(body || '{}');
			if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, { error: 'Нужен объект JSON.' });
			if (url.pathname === '/auth/guest') {
				if (this.guestsAllowed && !await this.guestsAllowed()) return reply(403, { error: 'Гостевой вход сейчас закрыт. Войдите через BYOND.' });
				session = this.create(res, this.address(req), session);
				session.active = true;
				session.expires = this.now() + SESSION_MS;
				this.save();
				return reply(200, { ok: true });
			}
			if (url.pathname === '/auth/byond/start') {
				if (!session) session = this.create(res, this.address(req));
				const binding = random();
				session.login = { state: random(), binding: hash(binding), expires: this.now() + LOGIN_MS };
				const existing = res.getHeader('Set-Cookie');
				res.setHeader('Set-Cookie', [...(existing ? [existing] : []), `${this.loginCookie}=${binding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MS / 1000}; Secure`]);
				const target = new URL('/auth/byond/callback', this.originOf(req));
				target.searchParams.set('state', session.login.state);
				const login = new URL('https://secure.byond.com/login.cgi');
				login.searchParams.set('login', '1');
				login.searchParams.set('url', target.href);
				return reply(200, { url: login.href });
			}
			if (url.pathname === '/auth/logout') {
				if (session) {
					this.revoke(session);
					this.save();
				}
				res.setHeader('Set-Cookie', [
					`${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.origin.startsWith('https:') ? '; Secure' : ''}`,
					`${this.loginCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
				]);
				return reply(200, { ok: true });
			}
			return reply(404, { error: 'Не найдено.' });
		} catch (error) { return reply(400, { error: error.message }); }
	}
}

module.exports = { Auth };
