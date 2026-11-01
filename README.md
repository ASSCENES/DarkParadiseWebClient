# DarkParadiseWebClient
Вебклиент для SS13 DarkParadise

Seeker — браузерный клиент BYOND: шлюз на Node.js подключается к Dream Daemon по нативному протоколу
DreamSeeker и показывает игру в браузере.

- `seeker/` — сам клиент: шлюз (`server.js`) и страница (`public/`). Запуск и возможности — в [seeker/README.md](seeker/README.md).
- `docs/PROTOCOL.md` — описание протокола BYOND, разобранного для клиента.
- `webtest/` — маленький тестовый мир BYOND для проверки клиента.
- `darkparadise/` — патч для сервера Dark Paradise: вход гостей Seeker по одноразовому билету.
- `CLAUDE.md` — заметки для разработки (устройство, отладка, уроки).
