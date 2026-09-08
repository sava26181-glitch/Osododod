# Zenodrop CS2.SH v11

Обновление:
- Telegram-бот переведен на webhook при наличии `RENDER_EXTERNAL_URL`; это исправляет работу бота на Render Free, где сервис может засыпать после 15 минут без входящего трафика. Render автоматически задает `RENDER_EXTERNAL_URL` для web service.
- Если webhook недоступен, сервер автоматически использует long polling.
- При старте бот проверяет `getMe`, настраивает команды и удаляет конфликтующий webhook перед fallback на polling.
- Промокоды стали нормальными и читаемыми: `WELCOME10`, `ZENODROP15`, `DROP20` плюс временный код вида `ZEN15`/`ZEN20`.
- Промокод API теперь передает срок действия и статус временного кода.
- Добавлен `/api/admin/promo` для создания промокодов из web-admin.
- Вкладка пополнения полностью переработана: крупнее окно, вкладки, поля, суммы и кнопки.
- Из вкладки пополнения убраны эмодзи.
- Баннер-картинка из вкладки кейсов удален; вместо него аккуратный текстовый блок с промокодами и таймером.
- Удален `promo-banner.jpeg`.

## Render

Обязательные переменные:
- `CS2SH_API_KEY`
- `STEAM_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TG_ADMIN_IDS`

Для кнопки Telegram на сайте:
- `TELEGRAM_BOT_URL=https://t.me/ВАШ_БОТ`

`TELEGRAM_WEBHOOK_URL` можно не задавать: на Render сервер автоматически использует `RENDER_EXTERNAL_URL/telegram/webhook`.

### v15 changes
- Zenopay Telegram bot uses webhook automatically on Render (`RENDER_EXTERNAL_URL` -> `/telegram/webhook`), so `/start` can wake the Render service instead of relying on polling.
- Webhook requests are protected with Telegram `secret_token` derived from the bot token.
- If no public Render URL is available, the bot falls back to long polling.
- Case payout odds now scale down for expensive cases; the higher the case price, the lower the probability of break-even/positive payouts and large multipliers.
