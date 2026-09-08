Zenodrop v15

Telegram fixed for Render: webhook is used when TELEGRAM_WEBHOOK_URL or RENDER_EXTERNAL_URL is available. This lets Telegram wake a sleeping Render service. /start is processed from webhook updates.

Render environment variables:
- TELEGRAM_BOT_TOKEN — bot token
- TG_ADMIN_IDS — admin Telegram IDs, comma-separated
- RENDER_EXTERNAL_URL is supplied by Render automatically; alternatively set TELEGRAM_WEBHOOK_URL to https://YOUR-DOMAIN/telegram/webhook
- TELEGRAM_BOT_URL — public bot URL for the site's Telegram top-up button

Do not run another instance with the same bot token. Telegram supports either webhook or getUpdates, not both.
