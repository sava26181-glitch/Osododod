const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

const KEY = (
    process.env.CS2SH_API_KEY ||
    process.env.CS2_API_KEY ||
    process.env.CS2SH_KEY ||
    ''
).trim();

// Steam Web API key
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();

if (!KEY) {
    console.error(
        'ERROR: Set CS2SH_API_KEY in Render Environment Variables'
    );
    process.exit(1);
}

const html = fs.readFileSync(
    path.join(__dirname, 'Zenodrop_CS2SH_400.html')
);

// ===============================
// SESSIONS
// ===============================

const sessions = new Map();


// ===============================
// ZENODROP ACCOUNT / TELEGRAM STORE
// ===============================

const DATA_FILE = path.join(
    __dirname,
    'zenodrop_data.json'
);

const TG_TOKEN = (
    process.env.TELEGRAM_BOT_TOKEN || ''
).trim();

const PAY_TG_TOKEN = (
    process.env.TELEGRAM_PAYMENT_BOT_TOKEN || ''
).trim();

const TG_ADMIN_IDS = String(
    process.env.TG_ADMIN_IDS || ''
)
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

const TG_BOT_URL = (
    process.env.TELEGRAM_BOT_URL ||
    ''
).trim();

const PAY_TG_BOT_URL = (
    process.env.TELEGRAM_PAYMENT_BOT_URL ||
    'https://t.me/ZenodropPayBot'
).trim();

const TG_WEBHOOK_URL = (
    process.env.TELEGRAM_WEBHOOK_URL ||
    (
        (process.env.RENDER_EXTERNAL_URL || '').trim()
            ? (
                process.env.RENDER_EXTERNAL_URL
                    .trim()
                    .replace(/\/$/, '') +
                '/telegram/admin-webhook'
            )
            : ''
    )
).trim();

const PAY_TG_WEBHOOK_URL = (
    process.env.TELEGRAM_PAYMENT_WEBHOOK_URL ||
    (
        (process.env.RENDER_EXTERNAL_URL || '').trim()
            ? (
                process.env.RENDER_EXTERNAL_URL
                    .trim()
                    .replace(/\/$/, '') +
                '/telegram/payment-webhook'
            )
            : ''
    )
).trim();


// ===============================
// STORE
// ===============================

function defaultStore() {
    return {
        users: {},
        links: {},
        withdrawals: [],
        promos: [],
        stats: {
            totalDeposited: 0,
            totalWithdrawals: 0,
            casesOpened: 0,
            upgradesTotal: 0
        }
    };
}

function loadStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return defaultStore();
        }

        const raw = fs.readFileSync(
            DATA_FILE,
            'utf8'
        );

        const data = JSON.parse(raw);

        return {
            ...defaultStore(),
            ...data,
            users: data.users || {},
            links: data.links || {},
            withdrawals:
                Array.isArray(data.withdrawals)
                    ? data.withdrawals
                    : [],
            promos:
                Array.isArray(data.promos)
                    ? data.promos
                    : [],
            stats: {
                ...defaultStore().stats,
                ...(data.stats || {})
            }
        };
    } catch (e) {
        console.error(
            'Store load error:',
            e.message
        );

        return defaultStore();
    }
}

const data = loadStore();

function saveStore() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            'utf8'
        );
    } catch (e) {
        console.error(
            'Store save error:',
            e.message
        );
    }
}


// ===============================
// ZENODROP ID
// ===============================

function makeZenodropId() {
    let id = '';

    do {
        id =
            'ZN-' +
            String(
                crypto.randomInt(
                    10000000,
                    100000000
                )
            );
    } while (
        Object.values(data.users)
            .some(
                u =>
                    u &&
                    u.zenoId === id
            )
    );

    return id;
}

function ensureZenodropId(user) {
    if (
        !user.zenoId ||
        !/^ZN-\d{8}$/.test(
            String(user.zenoId)
        )
    ) {
        user.zenoId =
            makeZenodropId();
    }

    return user.zenoId;
}

function findUserByZenodropId(zenoId) {
    const id = String(
        zenoId || ''
    )
        .trim()
        .toUpperCase();

    if (!id) {
        return null;
    }

    return (
        Object.values(data.users)
            .find(
                u =>
                    String(
                        u?.zenoId || ''
                    ).toUpperCase() === id
            ) ||
        null
    );
}


// ===============================
// USER
// ===============================

function ensureUser(steamid) {
    const id = String(
        steamid || ''
    ).trim();

    if (!id) {
        return null;
    }

    if (!data.users[id]) {
        data.users[id] = {
            steamid: id,
            username: 'Unknown',
            avatar: '',
            zenoId: makeZenodropId(),
            tgId: null,
            balance: 0,
            inventory: [],
            bestDrop: {
                name: '--',
                value: 0,
                img: ''
            },
            stats: {
                upgradesTotal: 0,
                casesOpened: 0,
                totalDeposited: 0
            }
        };

        saveStore();
    }

    const user = data.users[id];

    ensureZenodropId(user);

    if (!Array.isArray(user.inventory)) {
        user.inventory = [];
    }

    if (!user.stats) {
        user.stats = {};
    }

    if (
        typeof user.stats.upgradesTotal !==
        'number'
    ) {
        user.stats.upgradesTotal = 0;
    }

    if (
        typeof user.stats.casesOpened !==
        'number'
    ) {
        user.stats.casesOpened = 0;
    }

    if (
        typeof user.stats.totalDeposited !==
        'number'
    ) {
        user.stats.totalDeposited = 0;
    }

    if (!user.bestDrop) {
        user.bestDrop = {
            name: '--',
            value: 0,
            img: ''
        };
    }

    if (
        typeof user.balance !==
        'number'
    ) {
        user.balance = Number(
            user.balance || 0
        );
    }

    return user;
}


// ===============================
// TELEGRAM LINK
// ===============================

function findSteamByTelegram(chatId) {
    const id = String(
        chatId || ''
    );

    return (
        data.links[id] ||
        Object.values(data.users)
            .find(
                u =>
                    String(
                        u?.tgId || ''
                    ) === id
            )
            ?.steamid ||
        null
    );
}

function linkTelegramToUser(
    chatId,
    steamid
) {
    const tgId = String(
        chatId || ''
    );

    const steam = String(
        steamid || ''
    );

    if (!tgId || !steam) {
        return false;
    }

    const user = ensureUser(
        steam
    );

    if (!user) {
        return false;
    }

    user.tgId = tgId;
    data.links[tgId] = steam;

    saveStore();

    return true;
}


// ===============================
// TELEGRAM API
// ===============================

async function tgWithToken(
    token,
    label,
    method,
    body = {}
) {
    if (!token) {
        console.error(
            `Telegram ${label}: token is not set`
        );

        return null;
    }

    try {
        const r = await fetch(
            `https://api.telegram.org/bot${token}/${method}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/json'
                },
                body: JSON.stringify(
                    body
                )
            }
        );

        const json = await r.json();

        if (!json?.ok) {
            console.error(
                `Telegram ${label} API`,
                method,
                json?.description ||
                    'unknown error'
            );
        }

        return json;
    } catch (e) {
        console.error(
            `Telegram ${label}`,
            method,
            e.message
        );

        return null;
    }
}

async function tg(
    method,
    body = {}
) {
    return tgWithToken(
        TG_TOKEN,
        'admin',
        method,
        body
    );
}

async function tgPay(
    method,
    body = {}
) {
    return tgWithToken(
        PAY_TG_TOKEN,
        'payment',
        method,
        body
    );
}


// ===============================
// TELEGRAM HELPERS
// ===============================

function isTgAdmin(id) {
    return TG_ADMIN_IDS.includes(
        String(id)
    );
}

function telegramSecret(token) {
    if (!token) {
        return '';
    }

    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex')
        .slice(0, 32);
}


// ===============================
// PAYMENT MENU
// ===============================

async function sendPaymentMenu(
    chatId
) {
    return tgPay(
        'sendMessage',
        {
            chat_id: chatId,

            text:
                '<b>Zenodrop — Пополнение</b>\n\n' +
                'Выберите действие:',

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text:
                                '💰 Пополнить',
                            callback_data:
                                'pay:topup'
                        },
                        {
                            text:
                                '👤 Профиль',
                            callback_data:
                                'pay:profile'
                        }
                    ],
                    [
                        {
                            text:
                                '🧪 Тест +100 ₽',
                            callback_data:
                                'pay:test:100'
                        },
                        {
                            text:
                                '🧪 Тест +500 ₽',
                            callback_data:
                                'pay:test:500'
                        }
                    ],
                    [
                        {
                            text:
                                '🧪 Тест +1000 ₽',
                            callback_data:
                                'pay:test:1000'
                        }
                    ],
                    [
                        {
                            text:
                                '🌐 Открыть Zenodrop',
                            url:
                                'https://osododod.onrender.com/'
                        }
                    ]
                ]
            }
        }
    );
}


// ===============================
// PAYMENT TELEGRAM UPDATE
// ===============================

async function processPaymentTelegramUpdate(
    u
) {
    if (!u) {
        return;
    }

    // ===========================
    // CALLBACK
    // ===========================

    if (u.callback_query) {
        const q =
            u.callback_query;

        const chatId =
            String(
                q.from?.id ||
                q.message?.chat?.id ||
                ''
            );

        const d =
            String(
                q.data || ''
            );

        if (d === 'pay:menu') {
            return sendPaymentMenu(
                chatId
            );
        }

        if (d === 'pay:profile') {
            const steam =
                findSteamByTelegram(
                    chatId
                );

            const user =
                steam
                    ? ensureUser(steam)
                    : null;

            if (!user) {
                return tgPay(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            '❌ Аккаунт не привязан.\n\n' +
                            'Откройте Telegram через кнопку «Пополнить → Telegram» на сайте Zenodrop.'
                    }
                );
            }

            return tgPay(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        '<b>Профиль Zenodrop</b>\n\n' +
                        `🆔 Zenodrop ID: <code>${user.zenoId}</code>\n` +
                        `🎮 Steam ID: <code>${user.steamid}</code>\n` +
                        `💰 Баланс: <b>${Number(user.balance || 0).toFixed(2)} ₽</b>`,

                    parse_mode:
                        'HTML',

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text:
                                        '💰 Пополнить',
                                    callback_data:
                                        'pay:topup'
                                }
                            ],
                            [
                                {
                                    text:
                                        '⬅️ Меню',
                                    callback_data:
                                        'pay:menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        // ===========================
        // TEST TOPUP
        // ===========================

        if (
            d.startsWith(
                'pay:test:'
            )
        ) {
            const amount =
                Number(
                    d.split(':')[2]
                );

            const steam =
                findSteamByTelegram(
                    chatId
                );

            const user =
                steam
                    ? ensureUser(steam)
                    : null;

            if (
                !user ||
                !Number.isFinite(
                    amount
                ) ||
                amount <= 0 ||
                amount > 10000
            ) {
                return tgPay(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            '❌ Сначала привяжите аккаунт через сайт Zenodrop.'
                    }
                );
            }

            user.balance =
                Number(
                    user.balance || 0
                ) + amount;

            user.stats =
                user.stats || {};

            user.stats.totalDeposited =
                Number(
                    user.stats
                        .totalDeposited ||
                    0
                ) + amount;

            user.lastTestTopup = {
                amount,
                createdAt:
                    Date.now(),
                telegramId:
                    chatId
            };

            data.stats =
                data.stats || {};

            data.stats.totalDeposited =
                Number(
                    data.stats
                        .totalDeposited ||
                    0
                ) + amount;

            saveStore();

            return tgPay(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        '✅ <b>Тестовое пополнение</b>\n\n' +
                        `Зачислено: <b>+${amount.toFixed(2)} ₽</b>\n` +
                        `Баланс: <b>${Number(user.balance).toFixed(2)} ₽</b>`,

                    parse_mode:
                        'HTML',

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text:
                                        '💰 Пополнить ещё',
                                    callback_data:
                                        'pay:topup'
                                }
                            ],
                            [
                                {
                                    text:
                                        '👤 Профиль',
                                    callback_data:
                                        'pay:profile'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        if (d === 'pay:topup') {
            return tgPay(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        '<b>Пополнение Zenodrop</b>\n\n' +
                        'Выберите способ пополнения:',

                    parse_mode:
                        'HTML',

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text:
                                        '🧪 Тест +100 ₽',
                                    callback_data:
                                        'pay:test:100'
                                },
                                {
                                    text:
                                        '🧪 Тест +500 ₽',
                                    callback_data:
                                        'pay:test:500'
                                }
                            ],
                            [
                                {
                                    text:
                                        '🧪 Тест +1000 ₽',
                                    callback_data:
                                        'pay:test:1000'
                                }
                            ],
                            [
                                {
                                    text:
                                        '⬅️ Меню',
                                    callback_data:
                                        'pay:menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        return;
    }


    // ===========================
    // MESSAGE
    // ===========================

    if (u.message) {
        const msg =
            u.message;

        const chatId =
            String(
                msg.chat?.id || ''
            );

        const text =
            String(
                msg.text || ''
            ).trim();

        if (!chatId) {
            return;
        }

        // =========================
        // START
        // =========================

        if (
            text === '/start' ||
            text.startsWith(
                '/start '
            )
        ) {
            const payload =
                text
                    .slice(
                        6
                    )
                    .trim();

            if (
                payload.startsWith(
                    'deposit_'
                )
            ) {
                const zenoId =
                    payload
                        .slice(
                            'deposit_'.length
                        )
                        .trim();

                const user =
                    findUserByZenodropId(
                        zenoId
                    );

                if (user) {
                    linkTelegramToUser(
                        chatId,
                        user.steamid
                    );

                    await tgPay(
                        'sendMessage',
                        {
                            chat_id:
                                chatId,

                            text:
                                '✅ <b>Аккаунт привязан</b>\n\n' +
                                `🆔 Zenodrop ID: <code>${user.zenoId}</code>\n` +
                                `💰 Баланс: <b>${Number(user.balance || 0).toFixed(2)} ₽</b>\n\n` +
                                'Теперь вы можете пользоваться пополнением через Telegram.',

                            parse_mode:
                                'HTML'
                        }
                    );
                } else {
                    await tgPay(
                        'sendMessage',
                        {
                            chat_id:
                                chatId,

                            text:
                                '❌ Zenodrop ID не найден.\n\n' +
                                'Откройте Telegram через кнопку пополнения на сайте.'
                        }
                    );
                }
            }

            return sendPaymentMenu(
                chatId
            );
        }


        // =========================
        // DEPOSIT
        // =========================

        if (
            text === '/deposit' ||
            text === '/pay'
        ) {
            return sendPaymentMenu(
                chatId
            );
        }


        // =========================
        // ID
        // =========================

        if (text === '/id') {
            const steam =
                findSteamByTelegram(
                    chatId
                );

            const user =
                steam
                    ? ensureUser(steam)
                    : null;

            if (!user) {
                return tgPay(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            '❌ Аккаунт не привязан.'
                    }
                );
            }

            return tgPay(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        `🆔 Ваш Zenodrop ID: <code>${user.zenoId}</code>`,

                    parse_mode:
                        'HTML'
                }
            );
        }


        // =========================
        // BALANCE
        // =========================

        if (
            text === '/balance'
        ) {
            const steam =
                findSteamByTelegram(
                    chatId
                );

            const user =
                steam
                    ? ensureUser(steam)
                    : null;

            if (!user) {
                return tgPay(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            '❌ Аккаунт не привязан.'
                    }
                );
            }

            return tgPay(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        `💰 Баланс: <b>${Number(user.balance || 0).toFixed(2)} ₽</b>`,

                    parse_mode:
                        'HTML'
                }
            );
        }


        // =========================
        // UNKNOWN COMMAND
        // =========================

        return sendPaymentMenu(
            chatId
        );
    }
}


// ===============================
// ADMIN TELEGRAM UPDATE
// ===============================

async function processAdminTelegramUpdate(
    u
) {
    if (!u) {
        return;
    }

    if (u.callback_query) {
        const q =
            u.callback_query;

        const id =
            String(
                q.from?.id || ''
            );

        if (!isTgAdmin(id)) {
            await tg(
                'answerCallbackQuery',
                {
                    callback_query_id:
                        q.id,

                    text:
                        'Нет доступа',

                    show_alert:
                        true
                }
            );

            return;
        }

        const d =
            String(
                q.data || ''
            );

        if (
            d.startsWith(
                'withdraw:approve:'
            )
        ) {
            const wid =
                d.split(':')[2];

            const w =
                data.withdrawals
                    .find(
                        x =>
                            String(
                                x.id
                            ) ===
                            String(
                                wid
                            )
                    );

            if (!w) {
                await tg(
                    'answerCallbackQuery',
                    {
                        callback_query_id:
                            q.id,

                        text:
                            'Заявка не найдена',

                        show_alert:
                            true
                    }
                );

                return;
            }

            w.status =
                'approved';

            w.approvedAt =
                Date.now();

            data.stats =
                data.stats || {};

            data.stats.totalWithdrawals =
                Number(
                    data.stats
                        .totalWithdrawals ||
                    0
                ) + Number(
                    w.value || 0
                );

            saveStore();

            await tg(
                'answerCallbackQuery',
                {
                    callback_query_id:
                        q.id,

                    text:
                        'Заявка подтверждена'
                }
            );

            return;
        }


        if (
            d.startsWith(
                'withdraw:reject:'
            )
        ) {
            const wid =
                d.split(':')[2];

            const w =
                data.withdrawals
                    .find(
                        x =>
                            String(
                                x.id
                            ) ===
                            String(
                                wid
                            )
                    );

            if (!w) {
                await tg(
                    'answerCallbackQuery',
                    {
                        callback_query_id:
                            q.id,

                        text:
                            'Заявка не найдена',

                        show_alert:
                            true
                    }
                );

                return;
            }

            w.status =
                'rejected';

            w.rejectedAt =
                Date.now();

            const user =
                ensureUser(
                    w.steamid
                );

            if (user) {
                user.balance =
                    Number(
                        user.balance ||
                        0
                    ) +
                    Number(
                        w.refund ||
                        0
                    );
            }

            saveStore();

            await tg(
                'answerCallbackQuery',
                {
                    callback_query_id:
                        q.id,

                    text:
                        'Заявка отклонена'
                }
            );

            return;
        }
    }


    if (u.message) {
        const msg =
            u.message;

        const chatId =
            String(
                msg.chat?.id || ''
            );

        if (!isTgAdmin(chatId)) {
            return;
        }

        const text =
            String(
                msg.text || ''
            ).trim();

        if (
            text === '/start' ||
            text === '/help'
        ) {
            return tg(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        '<b>Zenodrop Admin</b>\n\n' +
                        '/stats — статистика\n' +
                        '/users — пользователи\n' +
                        '/withdrawals — заявки\n' +
                        '/help — помощь',

                    parse_mode:
                        'HTML'
                }
            );
        }


        if (
            text === '/stats'
        ) {
            const users =
                Object.values(
                    data.users
                );

            const balance =
                users.reduce(
                    (sum, u) =>
                        sum +
                        Number(
                            u.balance ||
                            0
                        ),
                    0
                );

            return tg(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        '<b>Статистика Zenodrop</b>\n\n' +
                        `👤 Пользователей: <b>${users.length}</b>\n` +
                        `💰 Общий баланс: <b>${balance.toFixed(2)} ₽</b>\n` +
                        `📦 Кейсов открыто: <b>${Number(data.stats?.casesOpened || 0)}</b>\n` +
                        `⬆️ Апгрейдов: <b>${Number(data.stats?.upgradesTotal || 0)}</b>\n` +
                        `💳 Введено: <b>${Number(data.stats?.totalDeposited || 0).toFixed(2)} ₽</b>`,
                    parse_mode:
                        'HTML'
                }
            );
        }


        if (
            text === '/users'
        ) {
            const users =
                Object.values(
                    data.users
                );

            let out =
                '<b>Пользователи</b>\n\n';

            users
                .slice(
                    -20
                )
                .forEach(
                    u => {
                        out +=
                            `🆔 <code>${u.zenoId || '--'}</code>\n` +
                            `🎮 ${u.username || 'Unknown'}\n` +
                            `💰 ${Number(u.balance || 0).toFixed(2)} ₽\n\n`;
                    }
                );

            return tg(
                'sendMessage',
                {
                    chat_id:
                        chatId,

                    text:
                        out,

                    parse_mode:
                        'HTML'
                }
            );
        }


        if (
            text ===
            '/withdrawals'
        ) {
            const list =
                data.withdrawals
                    .slice(
                        -20
                    )
                    .reverse();

            if (!list.length) {
                return tg(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            'Заявок на вывод нет.'
                    }
                );
            }

            for (
                const w of list
            ) {
                const keyboard =
                    [];

                if (
                    w.status ===
                    'pending'
                ) {
                    keyboard.push(
                        [
                            {
                                text:
                                    '✅ Подтвердить',
                                callback_data:
                                    `withdraw:approve:${w.id}`
                            },
                            {
                                text:
                                    '❌ Отклонить',
                                callback_data:
                                    `withdraw:reject:${w.id}`
                            }
                        ]
                    );
                }

                await tg(
                    'sendMessage',
                    {
                        chat_id:
                            chatId,

                        text:
                            '<b>Заявка на вывод</b>\n\n' +
                            `ID: <code>${w.id}</code>\n` +
                            `Steam: <code>${w.steamid}</code>\n` +
                            `Предмет: ${w.name || '--'}\n` +
                            `Стоимость: <b>${Number(w.value || 0).toFixed(2)} ₽</b>\n` +
                            `Статус: <b>${w.status}</b>`,

                        parse_mode:
                            'HTML',

                        reply_markup:
                            keyboard.length
                                ? {
                                    inline_keyboard:
                                        keyboard
                                }
                                : undefined
                    }
                );
            }

            return;
        }
    }
}


// ===============================
// ADMIN TELEGRAM START
// ===============================

async function telegramStart() {
    if (!TG_TOKEN) {
        console.log(
            'Admin Telegram disabled: TELEGRAM_BOT_TOKEN is missing'
        );

        return;
    }

    try {
        const me =
            await tg(
                'getMe',
                {}
            );

        console.log(
            'Admin Telegram bot:',
            '@' +
                (
                    me?.result
                        ?.username ||
                    'unknown'
                )
        );

        await tg(
            'setMyCommands',
            {
                commands: [
                    {
                        command:
                            'start',
                        description:
                            'Открыть меню'
                    },
                    {
                        command:
                            'stats',
                        description:
                            'Статистика'
                    },
                    {
                        command:
                            'withdrawals',
                        description:
                            'Заявки'
                    }
                ]
            }
        );

        if (
            TG_WEBHOOK_URL
        ) {
            const secret =
                telegramSecret(
                    TG_TOKEN
                );

            const r =
                await tg(
                    'setWebhook',
                    {
                        url:
                            TG_WEBHOOK_URL,

                        secret_token:
                            secret,

                        allowed_updates: [
                            'message',
                            'callback_query'
                        ],

                        drop_pending_updates:
                            false
                    }
                );

            if (r?.ok) {
                console.log(
                    'Admin Telegram webhook enabled:',
                    TG_WEBHOOK_URL
                );
            } else {
                console.error(
                    'Admin Telegram setWebhook failed:',
                    r?.description ||
                        'unknown error'
                );
            }
        } else {
            console.error(
                'Admin Telegram webhook URL is missing'
            );
        }
    } catch (e) {
        console.error(
            'Admin Telegram init:',
            e.message
        );
    }
}


// ===============================
// PAYMENT TELEGRAM START
// ===============================

async function paymentTelegramStart() {
    if (!PAY_TG_TOKEN) {
        console.log(
            'Payment Telegram disabled: TELEGRAM_PAYMENT_BOT_TOKEN is missing'
        );

        return;
    }

    try {
        const me =
            await tgPay(
                'getMe',
                {}
            );

        if (!me?.ok) {
            console.error(
                'Payment Telegram getMe failed:',
                me?.description ||
                    'unknown error'
            );

            return;
        }

        console.log(
            'Payment Telegram bot:',
            '@' +
                (
                    me.result
                        ?.username ||
                    'unknown'
                )
        );

        await tgPay(
            'setMyCommands',
            {
                commands: [
                    {
                        command:
                            'start',
                        description:
                            'Открыть меню Zenodrop'
                    },
                    {
                        command:
                            'deposit',
                        description:
                            'Пополнить баланс'
                    },
                    {
                        command:
                            'id',
                        description:
                            'Показать Zenodrop ID'
                    },
                    {
                        command:
                            'balance',
                        description:
                            'Показать баланс'
                    }
                ]
            }
        );

        if (
            !PAY_TG_WEBHOOK_URL
        ) {
            console.error(
                'Payment Telegram: webhook URL is missing. Set TELEGRAM_PAYMENT_WEBHOOK_URL or RENDER_EXTERNAL_URL.'
            );

            return;
        }

        const secret =
            telegramSecret(
                PAY_TG_TOKEN
            );

        const r =
            await tgPay(
                'setWebhook',
                {
                    url:
                        PAY_TG_WEBHOOK_URL,

                    secret_token:
                        secret,

                    allowed_updates: [
                        'message',
                        'callback_query'
                    ],

                    drop_pending_updates:
                        false,

                    max_connections:
                        40
                }
            );

        if (r?.ok) {
            console.log(
                'Payment Telegram webhook enabled:',
                PAY_TG_WEBHOOK_URL
            );
        } else {
            console.error(
                'Payment Telegram setWebhook failed:',
                r?.description ||
                    'unknown error'
            );
        }

        const info =
            await tgPay(
                'getWebhookInfo',
                {}
            );

        if (info?.ok) {
            console.log(
                'Payment Telegram webhook info:',
                JSON.stringify({
                    url:
                        info.result?.url ||
                        '',

                    pending_update_count:
                        info.result
                            ?.pending_update_count ||
                        0,

                    last_error_date:
                        info.result
                            ?.last_error_date ||
                        null,

                    last_error_message:
                        info.result
                            ?.last_error_message ||
                        null,

                    allowed_updates:
                        info.result
                            ?.allowed_updates ||
                        []
                })
            );
        }
    } catch (e) {
        console.error(
            'Payment Telegram initialization error:',
            e.message
        );
    }
}


// ===============================
// COOKIES
// ===============================

function parseCookies(req) {
    const list = {};

    const rc =
        req.headers.cookie;

    if (!rc) {
        return list;
    }

    rc.split(';')
        .forEach(
            cookie => {
                const parts =
                    cookie.split('=');

                const key =
                    parts
                        .shift()
                        .trim();

                const value =
                    decodeURI(
                        parts.join('=')
                    );

                list[key] =
                    value;
            }
        );

    return list;
}


// ===============================
// JSON BODY
// ===============================

function readJson(req) {
    return new Promise(
        (resolve, reject) => {
            let body = '';

            req.on(
                'data',
                chunk => {
                    body += chunk;

                    if (
                        body.length >
                        10 * 1024 * 1024
                    ) {
                        reject(
                            new Error(
                                'Request body too large'
                            )
                        );

                        req.destroy();
                    }
                }
            );

            req.on(
                'end',
                () => {
                    try {
                        resolve(
                            JSON.parse(
                                body ||
                                '{}'
                            )
                        );
                    } catch (e) {
                        reject(e);
                    }
                }
            );

            req.on(
                'error',
                reject
            );
        }
    );
}


// ===============================
// HTTP SERVER
// ===============================

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            const urlObj =
                new URL(
                    req.url,
                    `http://${req.headers.host}`
                );

            const pathname =
                urlObj.pathname;


            // ===========================
            // TELEGRAM PAYMENT WEBHOOK
            // ===========================

            if (
                pathname ===
                    '/telegram/payment-webhook' &&
                req.method ===
                    'POST'
            ) {
                let update =
                    null;

                try {
                    update =
                        await readJson(
                            req
                        );
                } catch (e) {
                    res.writeHead(
                        400,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            ok:
                                false,

                            error:
                                'invalid_json'
                        })
                    );

                    return;
                }


                // =======================
                // WEBHOOK SECRET
                // =======================

                const expectedSecret =
                    PAY_TG_TOKEN
                        ? telegramSecret(
                            PAY_TG_TOKEN
                        )
                        : '';

                const receivedSecret =
                    String(
                        req.headers[
                            'x-telegram-bot-api-secret-token'
                        ] || ''
                    );

                if (
                    expectedSecret &&
                    receivedSecret !==
                        expectedSecret
                ) {
                    console.error(
                        'Payment Telegram webhook: invalid secret'
                    );

                    res.writeHead(
                        403,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            ok:
                                false,

                            error:
                                'forbidden'
                        })
                    );

                    return;
                }


                // =======================
                // CALLBACK QUERY
                // =======================

                if (
                    update &&
                    update.callback_query
                ) {
                    const q =
                        update.callback_query;

                    const callbackId =
                        String(
                            q.id || ''
                        );

                    const callbackData =
                        String(
                            q.data || ''
                        );

                    let text = '';

                    if (
                        callbackData.startsWith(
                            'pay:test:'
                        )
                    ) {
                        const amount =
                            Number(
                                callbackData
                                    .split(
                                        ':'
                                    )[2]
                            );

                        if (
                            Number.isFinite(
                                amount
                            ) &&
                            amount > 0
                        ) {
                            text =
                                `Обрабатываем +${amount} ₽…`;
                        } else {
                            text =
                                'Обрабатываем…';
                        }
                    }


                    // Telegram webhook может
                    // получить Bot API method
                    // прямо в HTTP response.
                    //
                    // Это мгновенно закрывает
                    // spinner callback-кнопки.

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            method:
                                'answerCallbackQuery',

                            callback_query_id:
                                callbackId,

                            text,

                            show_alert:
                                false,

                            cache_time:
                                0
                        })
                    );


                    // Основная обработка
                    // после мгновенного ответа.

                    Promise
                        .resolve(
                            processPaymentTelegramUpdate(
                                update
                            )
                        )
                        .catch(
                            e => {
                                console.error(
                                    'Payment Telegram callback processing:',
                                    e.message
                                );
                            }
                        );

                    return;
                }


                // =======================
                // NORMAL MESSAGE
                // =======================

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                res.end(
                    JSON.stringify({
                        ok:
                            true
                    })
                );

                Promise
                    .resolve(
                        processPaymentTelegramUpdate(
                            update
                        )
                    )
                    .catch(
                        e => {
                            console.error(
                                'Payment Telegram webhook processing:',
                                e.message
                            );
                        }
                    );

                return;
            }


            // ===========================
            // TELEGRAM ADMIN WEBHOOK
            // ===========================

            if (
                (
                    pathname ===
                        '/telegram/admin-webhook' ||
                    pathname ===
                        '/telegram/webhook'
                ) &&
                req.method ===
                    'POST'
            ) {
                let update =
                    null;

                try {
                    update =
                        await readJson(
                            req
                        );
                } catch (e) {
                    res.writeHead(
                        400,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            ok:
                                false
                        })
                    );

                    return;
                }

                const expectedSecret =
                    TG_TOKEN
                        ? telegramSecret(
                            TG_TOKEN
                        )
                        : '';

                const receivedSecret =
                    String(
                        req.headers[
                            'x-telegram-bot-api-secret-token'
                        ] || ''
                    );

                if (
                    expectedSecret &&
                    receivedSecret !==
                        expectedSecret
                ) {
                    res.writeHead(
                        403,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            ok:
                                false,

                            error:
                                'forbidden'
                        })
                    );

                    return;
                }

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                res.end(
                    JSON.stringify({
                        ok:
                            true
                    })
                );

                Promise
                    .resolve(
                        processAdminTelegramUpdate(
                            update
                        )
                    )
                    .catch(
                        e => {
                            console.error(
                                'Admin Telegram webhook:',
                                e.message
                            );
                        }
                    );

                return;
            }


            // ===========================
            // SESSION
            // ===========================

            const cookies =
                parseCookies(
                    req
                );

            let sessionUser =
                null;

            if (
                cookies.session_id &&
                sessions.has(
                    cookies.session_id
                )
            ) {
                sessionUser =
                    sessions.get(
                        cookies.session_id
                    );
            }


            // ===========================
            // STEAM LOGIN
            // ===========================

            if (
                pathname ===
                    '/auth/steam'
            ) {
                const proto =
                    req.headers[
                        'x-forwarded-proto'
                    ] ||
                    'http';

                const realm =
                    `${proto}://${req.headers.host}`;

                const returnTo =
                    `${realm}/auth/steam/return`;

                const params =
                    new URLSearchParams({
                        'openid.ns':
                            'http://specs.openid.net/auth/2.0',

                        'openid.mode':
                            'checkid_setup',

                        'openid.return_to':
                            returnTo,

                        'openid.realm':
                            realm,

                        'openid.identity':
                            'http://specs.openid.net/auth/2.0/identifier_select',

                        'openid.claimed_id':
                            'http://specs.openid.net/auth/2.0/identifier_select'
                    });

                res.writeHead(
                    302,
                    {
                        Location:
                            `https://steamcommunity.com/openid/login?${params.toString()}`
                    }
                );

                return res.end();
            }


            // ===========================
            // STEAM RETURN
            // ===========================

            if (
                pathname ===
                    '/auth/steam/return'
            ) {
                try {
                    const params =
                        new URLSearchParams();

                    params.append(
                        'openid.ns',
                        'http://specs.openid.net/auth/2.0'
                    );

                    params.append(
                        'openid.mode',
                        'check_authentication'
                    );

                    urlObj.searchParams.forEach(
                        (
                            value,
                            key
                        ) => {
                            if (
                                key !==
                                'openid.mode'
                            ) {
                                params.append(
                                    key,
                                    value
                                );
                            }
                        }
                    );

                    const verification =
                        await fetch(
                            'https://steamcommunity.com/openid/login',
                            {
                                method:
                                    'POST',

                                headers: {
                                    'Content-Type':
                                        'application/x-www-form-urlencoded'
                                },

                                body:
                                    params.toString()
                            }
                        );

                    const verificationText =
                        await verification.text();

                    if (
                        verificationText.includes(
                            'is_valid:true'
                        )
                    ) {
                        const claimedId =
                            urlObj
                                .searchParams
                                .get(
                                    'openid.claimed_id'
                                );

                        const match =
                            claimedId
                                ? claimedId.match(
                                    /\/id\/([0-9]{17})/
                                )
                                : null;

                        const steamId =
                            match
                                ? match[1]
                                : null;

                        if (
                            steamId
                        ) {
                            let user =
                                ensureUser(
                                    steamId
                                );

                            const playerRes =
                                await fetch(
                                    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`
                                );

                            const playerData =
                                await playerRes.json();

                            const player =
                                playerData
                                    .response
                                    ?.players
                                    ?.[0] ||
                                {};

                            user.username =
                                player.personaname ||
                                'Unknown';

                            user.avatar =
                                player.avatarfull ||
                                player.avatarmedium ||
                                player.avatar ||
                                '';

                            ensureZenodropId(
                                user
                            );

                            saveStore();

                            const userData = {
                                steamid:
                                    steamId,

                                username:
                                    user.username,

                                avatar:
                                    user.avatar
                            };

                            const sessionId =
                                crypto
                                    .randomBytes(
                                        16
                                    )
                                    .toString(
                                        'hex'
                                    );

                            sessions.set(
                                sessionId,
                                userData
                            );

                            res.writeHead(
                                302,
                                {
                                    Location:
                                        '/',

                                    'Set-Cookie':
                                        `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
                                }
                            );

                            return res.end();
                        }
                    }
                } catch (e) {
                    console.error(
                        'Steam Auth Error:',
                        e
                    );
                }

                res.writeHead(
                    302,
                    {
                        Location:
                            '/'
                    }
                );

                return res.end();
            }


            // ===========================
            // CURRENT USER
            // ===========================

            if (
                pathname ===
                    '/api/current-user' &&
                req.method ===
                    'GET'
            ) {
                let result =
                    sessionUser;

                if (
                    result?.steamid
                ) {
                    const user =
                        ensureUser(
                            result.steamid
                        );

                    result = {
                        ...result,

                        zenoId:
                            user.zenoId,

                        balance:
                            Number(
                                user.balance ||
                                0
                            ),

                        stats:
                            user.stats,

                        inventory:
                            user.inventory,

                        bestDrop:
                            user.bestDrop
                    };
                }

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json',

                        'Cache-Control':
                            'no-store'
                    }
                );

                return res.end(
                    JSON.stringify(
                        result ||
                        null
                    )
                );
            }


            // ===========================
            // CONFIG
            // ===========================

            if (
                pathname ===
                    '/api/config' &&
                req.method ===
                    'GET'
            ) {
                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json',

                        'Cache-Control':
                            'no-store'
                    }
                );

                return res.end(
                    JSON.stringify({
                        telegramBotUrl:
                            TG_BOT_URL ||
                            null,

                        paymentTelegramBotUrl:
                            PAY_TG_BOT_URL ||
                            'https://t.me/ZenodropPayBot'
                    })
                );
            }


            // ===========================
            // ACCOUNT SYNC
            // ===========================

            if (
                pathname ===
                    '/api/account/sync' &&
                req.method ===
                    'POST'
            ) {
                try {
                    const body =
                        await readJson(
                            req
                        );

                    const steamid =
                        String(
                            body.steamid ||
                            sessionUser
                                ?.steamid ||
                            ''
                        ).trim();

                    if (!steamid) {
                        res.writeHead(
                            400,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({
                                error:
                                    'steamid_required'
                            })
                        );
                    }

                    const user =
                        ensureUser(
                            steamid
                        );

                    if (
                        body.username
                    ) {
                        user.username =
                            String(
                                body.username
                            );
                    }

                    if (
                        body.avatar
                    ) {
                        user.avatar =
                            String(
                                body.avatar
                            );
                    }

                    /*
                     * Баланс намеренно не принимаем
                     * от клиента.
                     */
                    if (
                        body.stats &&
                        typeof body.stats ===
                            'object'
                    ) {
                        user.stats = {
                            ...user.stats,
                            upgradesTotal:
                                Number(
                                    body.stats
                                        .upgradesTotal ||
                                    user.stats
                                        .upgradesTotal ||
                                    0
                                ),

                            casesOpened:
                                Number(
                                    body.stats
                                        .casesOpened ||
                                    user.stats
                                        .casesOpened ||
                                    0
                                )
                        };
                    }

                    ensureZenodropId(
                        user
                    );

                    saveStore();

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            ok:
                                true,

                            user
                        })
                    );
                } catch (e) {
                    res.writeHead(
                        400,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            error:
                                e.message
                        })
                    );
                }
            }


            // ===========================
            // LOGOUT
            // ===========================

            if (
                pathname ===
                    '/auth/logout'
            ) {
                if (
                    cookies.session_id
                ) {
                    sessions.delete(
                        cookies.session_id
                    );
                }

                res.writeHead(
                    302,
                    {
                        Location:
                            '/',

                        'Set-Cookie':
                            'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
                    }
                );

                return res.end();
            }


            // ===========================
            // MAIN HTML
            // ===========================

            if (
                pathname === '/' &&
                req.method === 'GET'
            ) {
                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'text/html; charset=utf-8'
                    }
                );

                return res.end(
                    html
                );
            }


            // ===========================
            // USD → RUB
            // ===========================

            if (
                pathname ===
                    '/api/usd-rub' &&
                req.method ===
                    'GET'
            ) {
                try {
                    const r =
                        await fetch(
                            'https://kurs-rublya.ru/api/v1/rates/USD/',
                            {
                                headers: {
                                    Accept:
                                        'application/json'
                                }
                            }
                        );

                    const text =
                        await r.text();

                    if (
                        !r.ok
                    ) {
                        res.writeHead(
                            r.status,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            text
                        );
                    }

                    const d =
                        JSON.parse(
                            text
                        );

                    const rate =
                        Number(
                            d.ratePerUnit ||
                            d.value ||
                            d.data
                                ?.ratePerUnit ||
                            d.data
                                ?.rate
                        );

                    if (
                        !Number.isFinite(
                            rate
                        ) ||
                        rate <= 0
                    ) {
                        throw new Error(
                            'Invalid USD rate'
                        );
                    }

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json',

                            'Cache-Control':
                                'no-store'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            rate,

                            source:
                                'kurs-rublya.ru',

                            updatedAt:
                                new Date()
                                    .toISOString()
                        })
                    );
                } catch (e) {
                    res.writeHead(
                        502,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            error:
                                String(
                                    e
                                )
                        })
                    );
                }
            }


            // ===========================
            // CS2 CATALOG
            // ===========================

            if (
                pathname ===
                    '/api/cs2/catalog' &&
                req.method ===
                    'GET'
            ) {
                try {
                    if (
                        cs2CatalogCache.data &&
                        Date.now() <
                            cs2CatalogCache
                                .expires
                    ) {
                        res.writeHead(
                            200,
                            {
                                'Content-Type':
                                    'application/json; charset=utf-8',

                                'Cache-Control':
                                    'no-store'
                            }
                        );

                        return res.end(
                            JSON.stringify({
                                currency:
                                    'USD',

                                items:
                                    cs2CatalogCache
                                        .data,

                                cached:
                                    true
                            })
                        );
                    }

                    const items =
                        await buildCs2Catalog();

                    if (
                        !items.length
                    ) {
                        throw new Error(
                            'cs2.sh returned no priced items'
                        );
                    }

                    cs2CatalogCache = {
                        data:
                            items,

                        expires:
                            Date.now() +
                            5 *
                                60 *
                                1000
                    };

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8',

                            'Cache-Control':
                                'no-store'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            currency:
                                'USD',

                            items,

                            cached:
                                false
                        })
                    );
                } catch (e) {
                    const status =
                        Number(
                            e.status
                        ) ||
                        502;

                    res.writeHead(
                        status,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            error:
                                'cs2_catalog_proxy_error',

                            message:
                                String(
                                    e.message ||
                                    e
                                ),

                            upstreamStatus:
                                e.status ||
                                null,

                            details:
                                e.body ||
                                null
                        })
                    );
                }
            }


            // ===========================
            // CS2 SCHEMA
            // ===========================

            if (
                pathname ===
                    '/api/cs2/schema' &&
                req.method ===
                    'GET'
            ) {
                try {
                    const r =
                        await fetch(
                            'https://api.cs2.sh/v1/schema',
                            {
                                method:
                                    'GET',

                                headers: {
                                    'Authorization':
                                        'Bearer ' +
                                        KEY,

                                    'Accept-Encoding':
                                        'gzip'
                                }
                            }
                        );

                    const text =
                        await r.text();

                    res.writeHead(
                        r.status,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8',

                            'Cache-Control':
                                'no-store'
                        }
                    );

                    return res.end(
                        text
                    );
                } catch (e) {
                    res.writeHead(
                        502,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            error:
                                'cs2_schema_proxy_error',

                            message:
                                String(
                                    e
                                )
                        })
                    );
                }
            }


            // ===========================
            // CS2 PRICES
            // ===========================

            if (
                pathname ===
                    '/api/prices' &&
                req.method ===
                    'POST'
            ) {
                let body = '';

                req.on(
                    'data',
                    chunk => {
                        body += chunk;
                    }
                );

                req.on(
                    'end',
                    async () => {
                        try {
                            const input =
                                JSON.parse(
                                    body ||
                                    '{}'
                                );

                            const items =
                                Array.isArray(
                                    input.items
                                )
                                    ? input.items
                                        .filter(
                                            x =>
                                                typeof x ===
                                                    'string' &&
                                                x.trim()
                                        )
                                        .slice(
                                            0,
                                            100
                                        )
                                    : [];

                            if (
                                !items.length
                            ) {
                                res.writeHead(
                                    400,
                                    {
                                        'Content-Type':
                                            'application/json'
                                    }
                                );

                                return res.end(
                                    JSON.stringify({
                                        error:
                                            'items_required'
                                    })
                                );
                            }

                            const r =
                                await fetch(
                                    'https://api.cs2.sh/v1/prices/latest',
                                    {
                                        method:
                                            'POST',

                                        headers: {
                                            'Authorization':
                                                'Bearer ' +
                                                KEY,

                                            'Content-Type':
                                                'application/json',

                                            'Accept-Encoding':
                                                'gzip'
                                        },

                                        body:
                                            JSON.stringify({
                                                items
                                            })
                                    }
                                );

                            const text =
                                await r.text();

                            res.writeHead(
                                r.status,
                                {
                                    'Content-Type':
                                        'application/json; charset=utf-8',

                                    'Cache-Control':
                                        'no-store'
                                }
                            );

                            return res.end(
                                text
                            );
                        } catch (e) {
                            res.writeHead(
                                502,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    error:
                                        'cs2_prices_proxy_error',

                                    message:
                                        String(
                                            e.message ||
                                            e
                                        )
                                })
                            );
                        }
                    }
                );

                return;
            }


            // ===========================
            // 404
            // ===========================

            res.writeHead(
                404,
                {
                    'Content-Type':
                        'application/json'
                }
            );

            return res.end(
                JSON.stringify({
                    error:
                        'Not found'
                })
            );
        }
    );


// ===============================
// START
// ===============================

server.listen(
    PORT,
    () => {
        console.log(
            'Zenodrop running on port ' +
            PORT
        );

        console.log(
            'CS2.SH proxy enabled'
        );

        if (
            TG_TOKEN
        ) {
            console.log(
                'Admin Telegram bot enabled'
            );

            telegramStart();
        } else {
            console.log(
                'Admin Telegram bot disabled: TELEGRAM_BOT_TOKEN is missing'
            );
        }

        if (
            PAY_TG_TOKEN
        ) {
            console.log(
                'Payment Telegram bot enabled'
            );

            paymentTelegramStart();
        } else {
            console.log(
                'Payment Telegram bot disabled: TELEGRAM_PAYMENT_BOT_TOKEN is missing'
            );
        }
    }
);
