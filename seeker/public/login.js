const $ = id => document.getElementById(id);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('seeker-auth') : null;
let loginTimer;
// The SS14 client opens the game as /?embed=ss14&…. That has to survive logging in (also the trip to BYOND's site and
// back), or the game page forgets it is inside SS14 and the keyboard stops working there.
const RETURN = 'seekerReturn';
try { if (new URLSearchParams(location.search).get('embed')) sessionStorage.setItem(RETURN, location.search); } catch (_) {}
function returnQuery() { try { return sessionStorage.getItem(RETURN) || ''; } catch (_) { return ''; } }
const gameAddress = () => '/' + returnQuery();
async function post(route) {
	const response = await fetch('/auth/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
	return result;
}
async function run(button, action) {
	button.disabled = true;
	$('message').textContent = '';
	try { await action(); } catch (error) { $('message').textContent = error.message; }
	finally { button.disabled = false; }
}
async function session() {
	const response = await fetch('/auth/session', { cache: 'no-store' });
	if (!response.ok) throw new Error('Сервис входа недоступен. Обновите страницу.');
	return response.json();
}
function stopLogin() {
	clearInterval(loginTimer);
	loginTimer = null;
	$('byond').disabled = false;
}
async function checkLogin() {
	try {
		if (!(await session()).active) return;
		stopLogin();
		location.replace(gameAddress());
	} catch (_) {}
}
$('byond').onclick = () => {
	// (inside SS14 a popup would be a blank window of its own: the login goes through this same view instead)
	const popup = returnQuery() ? null : window.open('about:blank', '_blank', 'popup,width=620,height=760');
	if (popup) popup.opener = null;
	run($('byond'), async () => {
		try {
			const result = await post('byond/start');
			if (!popup) { location.assign(result.url); return; }
			popup.location.href = result.url;
			$('message').textContent = 'Завершите вход в окне BYOND.';
			const expires = Date.now() + 10 * 60000;
			clearInterval(loginTimer);
			loginTimer = setInterval(() => {
				if (Date.now() >= expires) { stopLogin(); $('message').textContent = 'Время входа истекло. Попробуйте снова.'; }
				else checkLogin();
			}, 2000);
		} catch (error) { popup?.close(); throw error; }
	});
};
$('guest').onclick = () => run($('guest'), async () => { stopLogin(); await post('guest'); location.replace(gameAddress()); });
$('logout').onclick = () => run($('logout'), async () => { stopLogin(); await post('logout'); location.reload(); });
if (channel) channel.onmessage = event => {
	if (event.data === 'success' && loginTimer) checkLogin();
	if (event.data === 'error' && loginTimer) { stopLogin(); $('message').textContent = 'BYOND не подтвердил вход. Попробуйте снова.'; }
};
const result = new URLSearchParams(location.search).get('byond');
if (result === 'success' || result === 'error') {
	history.replaceState(null, '', '/');
	channel?.postMessage(result);
	if (result === 'success') {
		session().then(current => {
			if (!current.active) throw new Error('Не удалось сохранить вход. Попробуйте снова.');
			window.close();
			location.replace(gameAddress());
		}).catch(error => { $('message').textContent = error.message; });
	} else { $('message').textContent = 'BYOND не подтвердил вход или запрос истёк. Попробуйте снова.'; }
}
session().then(current => {
	if (!current.active) return;
	$('choices').hidden = true;
	$('current').hidden = false;
	$('identity').textContent = current.ckey ? 'Вы вошли как ' + current.ckey : 'Гостевая сессия сохранена в этом браузере.';
}).catch(error => { $('message').textContent = error.message; });
async function checkGame() {
	try {
		const response = await fetch('/game-status', { cache: 'no-store' });
		const status = await response.json();
		$('game-status').textContent = status.ready ? '' : 'Сервер перезапускается или обновляется. Вход откроется через пару минут — страницу обновлять не нужно.';
		$('continue').hidden = !status.ready;
		$('guest-choice').hidden = status.guests === false;
		showLive(status.ready && status.world);
	} catch (_) { $('game-status').textContent = 'Не удалось проверить доступность игрового сервера.'; $('continue').hidden = true; showLive(null); }
}
// "● Онлайн · 12 игроков · карта Delta · раунд 01:23" under the title
function showLive(world) {
	const live = $('live'), text = $('live-text');
	live.hidden = false;
	live.classList.toggle('off', !world);
	text.textContent = '';
	if (!world) { text.textContent = 'Сервер недоступен'; return; }
	const n = world.players ?? 0, mod10 = n % 10, mod100 = n % 100;
	const word = mod10 === 1 && mod100 !== 11 ? 'игрок' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'игрока' : 'игроков';
	const bold = value => { const b = document.createElement('b'); b.textContent = value; return b; };
	text.append('Онлайн · ', bold(n + ' ' + word));
	if (world.map) text.append(' · карта ', bold(world.map));
	if (world.roundtime) text.append(' · раунд ', bold(world.roundtime));
}
$('continue').hidden = true;
$('continue').href = gameAddress();
checkGame();
setInterval(checkGame, 15000);