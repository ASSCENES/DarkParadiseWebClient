// One-step launcher: starts Dream Daemon for the configured world (unless it already listens),
// then the seeker gateway, and prints the addresses players can open in a browser.
// usage: node launch.js [config.json]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const cfgFile = path.resolve(process.argv[2] || path.join(__dirname, 'config.json'));
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
// "server": "host:port" joins a server running elsewhere: no Dream Daemon here, and icons and sounds come from
// that server (kept in the cache folder). "dmb" is started here and its .rsc files are read directly. With
// neither, each player enters the server address on the page.
const remote = cfg.server || null;
const dmb = remote || !cfg.dmb ? null : path.resolve(cfg.dmb);
const choose = !remote && !dmb;
const worldDir = dmb && path.dirname(dmb), base = dmb && path.basename(dmb, '.dmb');
const rsc = dmb ? [base + '.rsc', base + '.dyn.rsc'].map(f => path.join(worldDir, f)).filter(f => fs.existsSync(f)) : [];
const ddAddr = choose ? null : remote || '127.0.0.1:' + cfg.ddPort;

const listening = port => new Promise(res => {
	const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); });
	s.on('error', () => res(false));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	if (choose) console.log('Адрес сервера вводится на странице');
	else if (remote) console.log('Сервер: ' + remote + ' (иконки и звуки загружаются с него)');
	else if (await listening(cfg.ddPort)) console.log('Dream Daemon уже слушает порт ' + cfg.ddPort);
	else {
		console.log('Запускаю Dream Daemon: ' + dmb);
		const dd = spawn(path.join(cfg.byondBin, 'dd.exe'), [dmb, String(cfg.ddPort), '-trusted', '-close'], { cwd: worldDir, stdio: ['ignore', 'inherit', 'inherit'] });
		dd.on('exit', code => { console.log('Dream Daemon завершился (' + code + ')'); process.exit(1); });
		process.on('exit', () => dd.kill());
		process.on('SIGINT', () => process.exit(0));
		while (!(await listening(cfg.ddPort))) await sleep(1000);
	}

	if (await listening(cfg.webPort)) {
		console.log('\nПорт ' + cfg.webPort + ' уже занят — вероятно, шлюз уже запущен (откройте http://localhost:' + cfg.webPort + '/).');
		console.log('Чтобы запустить ещё один, закройте старый или поменяйте webPort в ' + path.basename(cfgFile) + '.');
		process.exit(1);
	}

	// The gateway restarts on its own when it exits (e.g. killed to load new code); the round keeps running.
	let gw;
	const startGateway = () => {
		gw = spawn(process.execPath, [path.join(__dirname, 'server.js'), ...(ddAddr ? ['--dd', ddAddr] : []), '--port', String(cfg.webPort), ...rsc.flatMap(f => ['--rsc', f])], { stdio: 'inherit' });
		gw.on('exit', code => { console.log('Шлюз завершился (' + code + '), перезапуск…'); setTimeout(startGateway, 1000); });
	};
	startGateway();
	process.on('exit', () => gw.kill());

	const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
	console.log('\nОткройте в браузере:');
	console.log('  на этом компьютере:  http://localhost:' + cfg.webPort + '/');
	for (const ip of ips) console.log('  в локальной сети:    http://' + ip + ':' + cfg.webPort + '/');
	console.log('Для доступа из интернета пробросьте TCP-порт ' + cfg.webPort + ' на роутере и разрешите его в брандмауэре.\n');
})();
