# TON Wallet Tracker Bot

Telegram-бот для отслеживания TON кошельков с RU/EN интерфейсом и уведомлениями о TON/Jetton/NFT переводах.

## Возможности
- Меню с кнопками: Добавить, Редактировать, Кошельки, Язык.
- Добавление адреса и имени кошелька.
- Редактирование: переименование, изменение адреса, удаление.
- Уведомления о входящих/исходящих переводах TON, Jetton, NFT.
- Дедупликация событий через БД, устойчивость к перезапускам.
- Опциональная пометка `Buy with Maestro (Pro)` если TonAPI метаданные содержат Maestro.
- Деплой через Docker Compose на Ubuntu 22.04.

## Структура
- `apps/bot` — Telegram бот (Telegraf)
- `apps/watcher` — воркер для опроса TonAPI и отправки уведомлений
- `packages/common` — общие утилиты и i18n
- `prisma` — схема и миграции

## Быстрый старт (Ubuntu 22.04)
1) Клонируйте репозиторий:
```bash
git clone <YOUR_REPO_URL>
cd Tracker
```
2) Создайте `.env` на основе примера:
```bash
cp .env.example .env
nano .env
```
Заполните `BOT_TOKEN`. `TONAPI_KEY` необязателен (но полезен для лимитов).

3) Запустите:
```bash
docker compose up -d --build
```

4) Проверьте логи:
```bash
docker compose logs -f bot
```

## Проверка работы
- Напишите боту `/start` в Telegram.
- Добавьте кошелёк через меню.
- После первого события вы получите уведомление.

## Быстрое устранение проблем
- **Бот не отвечает**: проверьте `BOT_TOKEN` и логи `docker compose logs -f bot`.
- **Нет уведомлений**: убедитесь, что `watcher` работает: `docker compose logs -f watcher`.
- **Ошибки TonAPI**: попробуйте добавить `TONAPI_KEY`.
- **Ошибки миграций**: проверьте доступность Postgres и `DATABASE_URL`.

## Переменные окружения
- `BOT_TOKEN` — токен Telegram бота.
- `DATABASE_URL` — строка подключения Postgres.
- `TONAPI_KEY` — ключ TonAPI (опционально).
- `TONAPI_BASE` — базовый URL TonAPI (по умолчанию https://tonapi.io/v2).
- `POLL_INTERVAL_MS` — интервал опроса в мс (по умолчанию 12000).
- `WEBHOOK_PORT` — порт webhook-сервера watcher (по умолчанию 8080).
- `TONAPI_WEBHOOK_SECRET` — секрет заголовка `X-Tonapi-Secret` для `POST /webhook/tonapi`.

## TonAPI Webhooks (дополнительно к polling)
- Публичный endpoint: `https://tracker.utyashka.fun/webhook/tonapi`.
- Для healthcheck доступен `GET /health`.
- Рекомендуется проксировать публичный HTTPS на локальный `127.0.0.1:8080` (например, cloudflared/Nginx).

## Ссылки
- Адреса: `https://tonviewer.com/<address>`
- Транзакции: `https://tonviewer.com/transaction/<hash>`
