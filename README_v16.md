Zenodrop v16 — two independent Telegram bots

1) BOT ЗАЯВОК + АДМИН:
TELEGRAM_BOT_TOKEN
TG_ADMIN_IDS
TELEGRAM_WEBHOOK_URL (optional; Render uses /telegram/admin-webhook automatically)

2) BOT ПОПОЛНЕНИЙ:
TELEGRAM_PAYMENT_BOT_TOKEN
TELEGRAM_PAYMENT_BOT_URL
TELEGRAM_PAYMENT_WEBHOOK_URL (optional; Render uses /telegram/payment-webhook automatically)

The two bots use separate Telegram tokens and separate webhook endpoints. The admin bot handles withdrawals/admin commands. The payment bot only handles /start, /deposit and /pay and does not receive admin callbacks.

IMPORTANT: set TELEGRAM_PAYMENT_BOT_TOKEN to the token of the SECOND bot. Do not put the same token in both variables.
