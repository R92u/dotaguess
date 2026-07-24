# Dota Match Guess — публичный сайт 2.5.1 (готовая сборка)
## Готовая связь с отдельной админкой

В этой сборке административный секрет уже зафиксирован в коде и совпадает с готовой админкой `1.0.1`:

```text
DgFCvKqN8ozA_eD6x7HtPb57G_eC2axQFLa7lnitLTc
```

На Render удалять или задавать `ADMIN_API_SECRET` и `ADMIN_SECRET` не требуется: эта сборка намеренно игнорирует их, чтобы старые переменные не ломали связь.


Это публичная часть игры. В ней **нет админской страницы** и нет формы ввода административного секрета.

Администрирование выполняется отдельным приложением `dota-match-guess-admin`, которое обращается к закрытому API этого сайта сервер-сервер.

## Возможности

- одинаковый набор матчей для всех посетителей на весь московский день;
- от 1 до 10 матчей в день по административной настройке;
- матчи из последних 100 матчей выбранных Dota-игроков;
- live-лидерборд через SSE;
- сохранение в PostgreSQL;
- закрытый административный API для отдельного админ-сайта и Discord-бота;
- публичный маршрут `/admin/` отсутствует.

## Render: существующий сервис `dotaguess`

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Переменные окружения:

```env
NODE_ENV=production
TRUST_PROXY=true
PLAYER_ACCOUNT_IDS=1524768829,1675188627,367813952,390845935
MATCH_POOL_SIZE=100
APP_SECRET=длинная_случайная_строка
ADMIN_API_SECRET=ещё_одна_длинная_случайная_строка
DATABASE_URL=Internal Database URL из Render Postgres
```

`ADMIN_API_SECRET` должен полностью совпадать с `MAIN_SITE_ADMIN_SECRET` отдельного админ-сайта. Для обратной совместимости сервер также понимает старое имя переменной `ADMIN_SECRET`, но лучше перейти на `ADMIN_API_SECRET`.

После деплоя:

- игра: `https://dotaguess.onrender.com/`;
- проверка: `https://dotaguess.onrender.com/api/health`;
- ожидаемая версия: `2.5.1`.

## Закрытые административные маршруты

Их вызывает только сервер отдельной админ-панели или Discord-бот. Авторизация: `Authorization: Bearer <ADMIN_API_SECRET>`.

- `GET /api/admin/state`
- `POST /api/admin/day/reset`
- `POST /api/admin/leaderboard/entry`
- `POST /api/admin/leaderboard/entry/delete`
- `POST /api/admin/leaderboard/clear`

Не размещайте `ADMIN_API_SECRET` в браузерном JavaScript.

## Локальный запуск

```bash
cp .env.example .env
node --env-file=.env server.js
```

```text
http://localhost:3000
```

## Тесты

```bash
npm test
```