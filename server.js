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
    console.log('Loading CS2.SH schema...');

    // Не скачиваем огромный полный snapshot цен. Берём схему,
    // выбираем нужные предметы и запрашиваем цены пачками по 100.
    const schema = await cs2Fetch('https://api.cs2.sh/v1/schema');

    const raw = schema?.items || schema || {};
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const uniq = new Map();

    for (const x of arr) {
        const name = String(x?.market_hash_name || x?.name || '').trim();
        const image = x?.image || x?.icon_url || x?.image_url || '';
        if (!name || !image || uniq.has(name)) continue;

        const type = String(x?.type || x?.category || '').toLowerCase();
        const isWeapon = /weapon|skin|gloves|knife|agent/.test(type) || name.includes('|');
        if (!isWeapon) continue;

        uniq.set(name, { name, img: image, api: x });
    }

    const all = [...uniq.values()];
    all.sort((a, b) => a.name.localeCompare(b.name));

    const families = new Set();
    const selected = [];
    for (const x of all) {
        const family = x.name
            .replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, '')
            .toLowerCase();
        if (families.has(family)) continue;
        families.add(family);
        selected.push(x);
        if (selected.length >= 1500) break;
    }

    console.log('Selected items:', selected.length);

    const batches = [];
    for (let i = 0; i < selected.length; i += 100) {
        batches.push(selected.slice(i, i + 100));
    }

    const priceMap = {};
    const concurrency = 5;
    for (let i = 0; i < batches.length; i += concurrency) {
        const group = batches.slice(i, i + concurrency);
        const responses = await Promise.all(group.map(batch =>
            cs2Fetch('https://api.cs2.sh/v1/prices/latest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: batch.map(x => x.name) })
            })
        ));
        for (const data of responses) {
            Object.assign(priceMap, data?.items || {});
        }
    }

    const sources = ['steam', 'csfloat', 'buff', 'youpin', 'skinport', 'c5game'];
    const result = [];

    for (const x of selected) {
        const p = priceMap[x.name];
        let usd = 0;
        for (const source of sources) {
            const ask = Number(p?.[source]?.ask);
            if (Number.isFinite(ask) && ask > 0) {
                usd = ask;
                break;
            }
        }
        if (usd <= 0) continue;

        result.push({
            id: 'skin_' + crypto.createHash('sha1').update(x.name).digest('hex').slice(0, 12),
            name: x.name,
            img: x.img,
            usd,
            api: x.api
        });
    }

    result.sort((a, b) => a.usd - b.usd);
    console.log('Priced items:', result.length);
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

                // Обновляем каталог
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

                    data: items,

                    expires:
                        Date.now() +
                        5 * 60 * 1000
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

// Каталог строится только по запросу клиента и затем кешируется.

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
