# Dark Paradise (Seeker) для SS14

Минимальная «игра» на движке RobustToolbox v295.0.2: клиент SS14 подключается к своему серверу SS14 и открывает на
всё окно встроенный браузер CEF со страницей Seeker. Сама игра идёт как обычно: Seeker → Dream Daemon. Сервер SS14
нужен для списка хаба и подключения через лаунчер.

```
SS14 Launcher / Hub -> сервер SS14 (TCP+UDP 1212) -> клиент SS14 (окно)
                                                       CEF: https://<ваш seeker>/?embed=ss14&ss14=<ник>
                                                            WebSocket -> шлюз Seeker -> Dream Daemon
```

## Движок

Движка в репозитории нет. Склонируйте его в эту папку:

```
git clone --recursive https://github.com/space-wizards/RobustToolbox
git -C RobustToolbox checkout v295.0.2
git -C RobustToolbox submodule update --init --recursive
```

Версия должна быть выпущенным тегом: лаунчер скачивает движок по номеру.

## Сборка

Нужен .NET SDK той версии, которую требует движок.

```
dotnet build Content.Server/Content.Server.csproj -c Release
dotnet build Content.Client/Content.Client.csproj -c Release
```

Результат: `bin/Content.Server` и `bin/Content.Client`. Если клиент запущен вручную, он сам подключается к
`localhost:1212`; через лаунчер — к выбранному серверу.

## Что отличается от шаблона RobustToolboxTemplate

| Файл | Что изменено |
|---|---|
| `Content.Shared/GameConfigVars.cs` | Переменная `seeker.url`: адрес страницы Seeker, сервер рассылает её клиентам. |
| `Content.Client/SeekerState.cs` | Вся игра: `WebViewControl` на всё окно с адресом `seeker.url` + `?embed=ss14&ss14=<ник>`. |
| `Content.Client/EntryPoint.cs` | Запускает `SeekerState` вместо шаблонного состояния. |
| `Resources/manifest.yml` | `modules: [Robust.Client.WebView]` (без этого лаунчер не даст CEF) и заголовок окна. |
| `Content.*.csproj` | Подключают `RobustToolbox/Imports/*.props`: движок v295 запрещает прямые ссылки на свои проекты. |

Песочница клиента: `Robust.Client.WebView` разрешён, `new System.Net.DnsEndPoint(...)` запрещён, для подключения
есть `IBaseClient.ConnectToServer(host, port)`, поля `[Dependency]` не должны быть `readonly`.

## Конфиг сервера

`server_config.toml` в `bin/Content.Server` перезаписывается при сборке: держите свою копию и запускайте с
`--config-file` и `--data-dir`.

```toml
[net]
port = 1212                    # открыть наружу и TCP, и UDP
bindto = "::,0.0.0.0"

[status]
enabled = true                 # без него лаунчер не подключится

[game]
hostname = "Dark Paradise (Seeker)"

[seeker]
url = "https://spacestation13new.ru/"

[console]
loginlocal = false             # иначе любой вход с 127.0.0.1 получает полные права

[auth]
mode = 1                       # обязательные аккаунты SS14

[hub]
advertise = true
server_url = "ss14://<домен>:1212"
hub_urls = "https://hub.spacestation14.com/"
```

## Вывод в хаб

1. Откройте порт 1212 по TCP и UDP.
2. Включите `hub.advertise` и заполните `hub.server_url`: сервер анонсируется примерно каждые 2 минуты.
3. Прочитайте правила хаба: https://docs.spacestation14.io/hosts/hub-rules. Эта обёртка запускает BYOND-игру, а не
   контент SS14, поэтому её могут убрать из списка. Решение и согласие с правилами остаются за владельцем сервера.
4. Проверка: SS14 Launcher → Direct Connect → `ss14://<домен>:1212`.

## Что не сделано

- Шлюз и вход не читают `?ss14=<ник>`: параметр легко подделать, доверять ему можно только после проверки (например,
  подписанный одноразовый тикет от сервера SS14).
- Debug-сборка открывает отладочный порт CEF 9222: в Release проверьте, что он закрыт.
- Не проверялись: запуск Release-сборки, упаковка клиента для лаунчера, настоящий лаунчер и хаб, работа за HTTPS-прокси.
