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
// CS2.SH CACHE
// ===============================

let cs2CatalogCache = {
    data: null,
    expires: 0
};

let cs2CatalogPromise = null;
const CS2_CACHE_MS = 10 * 60 * 1000;

// ===============================
// CS2.SH REQUEST
// ===============================

async function cs2Fetch(url, options = {}) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, 30000);

    try {
        const r = await fetch(url, {
            ...options,
            signal: controller.signal,

            headers: {
                'Authorization': 'Bearer ' + KEY,
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',

                ...(options.headers || {})
            }
        });

        const text = await r.text();

        let data = null;

        try {
            data = JSON.parse(text);
        } catch (_) {}

        if (!r.ok) {
            const msg =
                data?.message ||
                data?.error ||
                ('HTTP ' + r.status);

            const err = new Error(msg);

            err.status = r.status;
            err.body = data || text.slice(0, 1000);

            throw err;
        }

        return data;

    } finally {
        clearTimeout(timer);
    }
}

// ===============================
// BUILD CS2 CATALOG
// ===============================

async function buildCs2Catalog() {

    console.log('[CS2] Loading schema + prices in small batches...');

    // Не используем GET /v1/prices/latest: полный snapshot очень большой
    // и на Render периодически заканчивается 502/timeout. CS2.SH поддерживает
    // POST максимум по 100 market_hash_name за запрос.
    const schema = await cs2Fetch(
        'https://api.cs2.sh/v1/schema'
    );

    const raw = schema?.items || schema || {};
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const uniq = new Map();

    for (const x of arr) {
        const name = String(
            x?.market_hash_name || x?.name || ''
        ).trim();
        const image = x?.image || x?.icon_url || x?.image_url || '';
        if (!name || !image || uniq.has(name)) continue;

        const type = String(
            x?.type || x?.category || ''
        ).toLowerCase();

        const isWeapon =
            /weapon|skin|gloves|knife|agent/.test(type) ||
            name.includes('|');

        if (!isWeapon) continue;

        uniq.set(name, { name, img: image, api: x });
    }

    const all = [...uniq.values()];
    all.sort((a, b) => a.name.localeCompare(b.name));

    // Убираем только дубли одного семейства, но не отбрасываем дешёвые предметы.
    const families = new Set();
    const selected = [];

    for (const x of all) {
        const family = x.name
            .replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, '')
            .toLowerCase();

        if (families.has(family)) continue;
        families.add(family);
        selected.push(x);
        if (selected.length >= 1800) break;
    }

    console.log('[CS2] Selected names:', selected.length);

    const priceMap = new Map();
    const names = selected.map(x => x.name);
    const BATCH = 100;

    // 100 предметов = максимум на один POST по документации CS2.SH.
    // Делаем запросы последовательно с небольшой паузой, чтобы не ловить 429.
    for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        let data = null;
        let lastError = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                data = await cs2Fetch(
                    'https://api.cs2.sh/v1/prices/latest',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ items: batch })
                    }
                );
                break;
            } catch (e) {
                lastError = e;
                const retryable = [429, 500, 502, 503, 504].includes(Number(e.status));
                if (!retryable || attempt === 3) break;
                await new Promise(r => setTimeout(r, 800 * attempt));
            }
        }

        if (!data) {
            console.warn('[CS2] Price batch failed:', i, lastError?.message || lastError);
            continue;
        }

        for (const [name, item] of Object.entries(data.items || {})) {
            priceMap.set(name, item);
        }

        if (i + BATCH < names.length) {
            await new Promise(r => setTimeout(r, 120));
        }
    }

    const sources = [
        'steam', 'csfloat', 'buff', 'youpin', 'skinport', 'c5game'
    ];

    const result = [];

    for (const x of selected) {
        const p = priceMap.get(x.name);
        let usd = 0;

        for (const source of sources) {
            const ask = Number(p?.[source]?.ask);
            if (Number.isFinite(ask) && ask > 0) {
                usd = ask;
                break;
            }
        }

        if (!(usd > 0)) continue;

        result.push({
            id: 'skin_' + crypto.createHash('sha1').update(x.name).digest('hex').slice(0, 12),
            name: x.name,
            img: x.img,
            usd,
            api: x.api
        });
    }

    result.sort((a, b) => a.usd - b.usd);

    console.log('[CS2] Priced items:', result.length);
    return result.slice(0, 1500);
}

// ===============================
// COOKIES
// ===============================

function parseCookies(req) {

    const list = {};

    const rc = req.headers.cookie;

    if (!rc) {
        return list;
    }

    rc.split(';').forEach(cookie => {

        const parts = cookie.split('=');

        const key = parts
            .shift()
            .trim();

        const value = decodeURI(
            parts.join('=')
        );

        list[key] = value;
    });

    return list;
}

// ===============================
// SERVER
// ===============================

const server = http.createServer(
    async (req, res) => {

        const urlObj = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        const pathname =
            urlObj.pathname;

        // ===========================
        // SESSION
        // ===========================

        const cookies =
            parseCookies(req);

        let sessionUser = null;

        if (
            cookies.session_id &&
            sessions.has(cookies.session_id)
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
            pathname === '/auth/steam'
        ) {

            const proto =
                req.headers['x-forwarded-proto'] ||
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
                    (value, key) => {

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
                            method: 'POST',

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
                        urlObj.searchParams.get(
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

                    if (steamId) {

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

                        const userData = {

                            steamid:
                                steamId,

                            username:
                                player.personaname ||
                                'Unknown',

                            avatar:
                                player.avatarfull ||
                                player.avatarmedium ||
                                player.avatar ||
                                ''
                        };

                        const sessionId =
                            crypto.randomBytes(
                                16
                            ).toString('hex');

                        sessions.set(
                            sessionId,
                            userData
                        );

                        res.writeHead(
                            302,
                            {
                                Location: '/',

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
                    Location: '/'
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
            req.method === 'GET'
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
                JSON.stringify(
                    sessionUser || null
                )
            );
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
                    Location: '/',

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
            req.url === '/'
        ) {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'text/html; charset=utf-8'
                }
            );

            return res.end(html);
        }

        // ===========================
        // USD → RUB
        // ===========================

        if (
            pathname ===
                '/api/usd-rub' &&
            req.method === 'GET'
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

                if (!r.ok) {

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
                    JSON.parse(text);

                const rate =
                    Number(
                        d.ratePerUnit ||
                        d.value ||
                        d.data?.ratePerUnit ||
                        d.data?.rate
                    );

                if (
                    !Number.isFinite(rate) ||
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
                            new Date().toISOString()
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
                            String(e)
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
            req.method === 'GET'
        ) {

            try {

                // Отдаём кеш
                if (
                    cs2CatalogCache.data &&
                    Date.now() <
                        cs2CatalogCache.expires
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
                            currency: 'USD',

                            items:
                                cs2CatalogCache.data,

                            cached: true
                        })
                    );
                }

                // Один общий запрос для всех клиентов.
                // Иначе несколько открытых вкладок одновременно бьют CS2.SH.
                if (!cs2CatalogPromise) {
                    cs2CatalogPromise = buildCs2Catalog()
                        .finally(() => { cs2CatalogPromise = null; });
                }

                const items = await cs2CatalogPromise;

                if (
                    !items.length
                ) {
                    throw new Error(
                        'cs2.sh returned no priced items'
                    );
                }

                cs2CatalogCache = {

                    data: items,

                    expires:
                        Date.now() +
                        CS2_CACHE_MS
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
                        currency: 'USD',

                        items,

                        cached: false
                    })
                );

            } catch (e) {

                const status =
                    Number(e.status) ||
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
                                e.message || e
                            ),

                        upstreamStatus:
                            e.status || null,

                        details:
                            e.body || null
                    })
                );
            }
        }

        // ===========================
        // CS2 SCHEMA PROXY
        // ===========================

        if (
            pathname ===
                '/api/cs2/schema' &&
            req.method === 'GET'
        ) {

            try {

                const r =
                    await fetch(
                        'https://api.cs2.sh/v1/schema',
                        {
                            method: 'GET',

                            headers: {
                                'Authorization':
                                    'Bearer ' + KEY,

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
                            String(e)
                    })
                );
            }
        }

        // ===========================
        // CS2 PRICES PROXY
        // ===========================

        if (
            pathname ===
                '/api/prices' &&
            req.method === 'POST'
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
                                body || '{}'
                            );

                        const items =
                            Array.isArray(
                                input.items
                            )
                                ? input.items
                                    .filter(
                                        x =>
                                            typeof x === 'string' &&
                                            x.trim()
                                    )
                                    .slice(0, 100)
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
                                    method: 'POST',

                                    headers: {
                                        'Authorization':
                                            'Bearer ' + KEY,

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
                                        e.message || e
                                    )
                            })
                        );
                    }
                }
            );

            return;
        }

        // ===========================
        // CS2 HEALTH
        // ===========================

        if (
            pathname === '/api/cs2/health' &&
            req.method === 'GET'
        ) {
            const cached = !!(
                cs2CatalogCache.data &&
                Date.now() < cs2CatalogCache.expires
            );

            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });

            return res.end(JSON.stringify({
                ok: true,
                apiKeyConfigured: !!KEY,
                catalogCached: cached,
                catalogItems: cs2CatalogCache.data?.length || 0,
                cacheExpiresAt: cs2CatalogCache.expires || null,
                mode: 'POST /v1/prices/latest batches of 100'
            }));
        }

        // ===========================
        // 404
        // ===========================

        res.writeHead(404);

        res.end(
            'Not found'
        );
    }
);

// ===============================
// START
// ===============================

// Прогреваем каталог сразу после запуска Render, чтобы первый игрок
// не ждал построения каталога во время игры. Ошибка не ломает сервер.
setTimeout(() => {
    if (!cs2CatalogPromise) {
        cs2CatalogPromise = buildCs2Catalog()
            .then(items => {
                if (items.length) {
                    cs2CatalogCache = {
                        data: items,
                        expires: Date.now() + CS2_CACHE_MS
                    };
                    console.log('CS2 catalog preloaded:', items.length);
                }
                return items;
            })
            .catch(error => {
                console.error('CS2 preload failed:', error.message);
                return [];
            })
            .finally(() => {
                cs2CatalogPromise = null;
            });
    }
}, 100);

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
    }
);
