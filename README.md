# Dota Match Guess 2.2

Сайт ежедневно в 00:00 МСК выбирает два матча из общего пула **100 последних уникальных матчей** четырёх игроков:

- `1524768829`
- `1675188627`
- `367813952`
- `390845935`

Матчи всех игроков объединяются, сортируются по времени, дубликаты удаляются, после чего используются 100 самых новых.

## Новое в 2.2

- общий пул 100 последних матчей четырёх игроков;
- в каждом из двух матчей отдельно показывается профиль игрока, чей результат нужно угадать;
- защищённый endpoint очистки лидерборда;
- очистка удаляет лидерборд и историю ответов, а открытые страницы сайта получают live-событие и снова разрешают отвечать;
- совместимость с командой Discord-бота `~Dleader`;
- исправлено отображение количества ответов в Discord-лидерборде.

## Render

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Рекомендуемые переменные окружения:

```env
NODE_ENV=production
TRUST_PROXY=true
PLAYER_ACCOUNT_IDS=1524768829,1675188627,367813952,390845935
MATCH_POOL_SIZE=100
APP_SECRET=ваша-длинная-случайная-строка
ADMIN_SECRET=DgFCvKqN8ozA_eD6x7HtPb57G_eC2axQFLa7lnitLTc
DATABASE_URL=Internal Database URL из Render Postgres
```

`ADMIN_SECRET` должен совпадать со значением `DOTA_ADMIN_SECRET` в `app.py` Discord-бота.

После замены файлов выполните **Manual Deploy → Clear build cache & deploy**. Проверка версии:

```text
https://dotaguess.onrender.com/api/health
```

В ответе должна быть версия `2.2.0`, список четырёх account ID и `matchPoolSize: 100`.

## Локальный запуск

```bash
npm install
cp .env.example .env
node --env-file=.env server.js
```

Тесты:

```bash
npm test
```

## API очистки

```http
POST /api/admin/leaderboard/clear
Authorization: Bearer <ADMIN_SECRET>
```

Endpoint полностью очищает участников и ответы, затем обновляет сайт и Discord через live-поток лидерборда.
