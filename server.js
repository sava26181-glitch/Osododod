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
    console.log('Loading CS2.SH schema + prices in batches...');

    // Не скачиваем огромный полный snapshot: на Render это может занимать
    // слишком долго. Берём схему (~47.5k предметов), равномерно выбираем
    // несколько тысяч обычных weapon skins и запрашиваем цены батчами по 100.
    const schema = await cs2Fetch('https://api.cs2.sh/v1/schema');
    const raw = schema?.items || schema || {};
    const arr = Array.isArray(raw) ? raw : Object.values(raw);

    const candidates = [];
    const seen = new Set();
    for (const x of arr) {
        const name = String(x?.market_hash_name || x?.name || '').trim();
        const image = x?.image || x?.icon_url || x?.image_url || '';
        if (!name || !image || !name.includes('|')) continue;
        const low = name.toLowerCase();
        if (low.includes('sticker') || low.includes('patch') || low.includes('graffiti') || low.includes('music kit')) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        candidates.push({name, image});
    }

    // Важно: не режем каталог просто по алфавиту. Иначе дорогие Covert/ножи
    // могут вообще не попасть в выборку. Собираем каталог по ценовым классам:
    // high-tier предметы + ножи/перчатки + обычные дешёвые серии.
    const priorityWords = [
        'ak-47 |','m4a1-s |','m4a4 |','awp |','usp-s |','glock-18 |','p250 |',
        'deagle |','desert eagle |','famas |','galil ar |','mp9 |','mac-10 |',
        'mp7 |','mp5-sd |','ump-45 |','p90 |','ssg 08 |','scar-20 |','aug |',
        'sg 553 |','nova |','xm1014 |','mag-7 |','sawed-off |','tec-9 |',
        'five-seven |','cz75-auto |','dual berettas |','r8 revolver |','negev |','m249 |'
    ];
    const isWeapon = x => {
        const c=String(x?.category||'').toLowerCase();
        const n=String(x?.name||'').toLowerCase();
        return c==='skin' || n.includes(' | ');
    };
    const rarityTier = x => Number(x?.rarity?.tier || 0);
    const isKnife = x => /^★\s/.test(x.name) || String(x?.category||'').toLowerCase().includes('knife');
    const isGlove = x => String(x?.category||'').toLowerCase().includes('glove') || x.name.toLowerCase().includes('gloves');

    const high = candidates.filter(x => isWeapon(x) && rarityTier(x) >= 5);
    const knives = candidates.filter(x => isKnife(x) || isGlove(x));
    const priority = candidates.filter(x => priorityWords.some(w => x.name.toLowerCase().startsWith(w)));
    const cheapPool = candidates.filter(x => rarityTier(x) <= 4);

    const selected = [];
    const selectedSet = new Set();
    const add = x => {
        if(selected.length >= 7000 || !x || selectedSet.has(x.name)) return;
        selectedSet.add(x.name); selected.push(x);
    };

    // Сначала гарантируем дорогие категории.
    for (const x of high) add(x);
    for (const x of knives) add(x);
    for (const x of priority) add(x);

    // Затем равномерно добираем низкие/средние редкости, чтобы не пропали
    // дешёвые скины примерно от 10–20 ₽.
    const rest = cheapPool.filter(x => !selectedSet.has(x.name));
    const need = 7000 - selected.length;
    if (need > 0 && rest.length) {
        for (let i=0; i<Math.min(need, rest.length); i++) {
            const idx=Math.floor(i * rest.length / Math.min(need, rest.length));
            add(rest[idx]);
        }
    }
    // Если после этого осталось место — добираем весь остальной каталог равномерно.
    const remaining = candidates.filter(x => !selectedSet.has(x.name));
    const left = 7000 - selected.length;
    if (left > 0 && remaining.length) {
        for (let i=0; i<Math.min(left, remaining.length); i++) {
            const idx=Math.floor(i * remaining.length / Math.min(left, remaining.length));
            add(remaining[idx]);
        }
    }

    const batches = [];
    for (let i = 0; i < selected.length; i += 100) batches.push(selected.slice(i, i + 100).map(x => x.name));

    const priceMap = new Map();
    let cursor = 0;
    const workers = Math.min(8, batches.length);
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= batches.length) return;
            try {
                const data = await cs2Fetch('https://api.cs2.sh/v1/prices/latest', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({items: batches[i]})
                });
                for (const [name, item] of Object.entries(data?.items || {})) priceMap.set(name, item);
            } catch (e) {
                console.warn('CS2 batch failed:', e.message || e);
            }
        }
    }
    await Promise.all(Array.from({length: workers}, worker));

    const result = [];
    const sources = ['steam','csfloat','buff','youpin','skinport','c5game'];
    for (const x of selected) {
        const p = priceMap.get(x.name);
        if (!p) continue;
        let usd = 0;
        for (const source of sources) {
            const ask = Number(p?.[source]?.ask);
            if (Number.isFinite(ask) && ask > 0) { usd = ask; break; }
        }
        if (usd <= 0) continue;
        result.push({
            id: 'skin_' + crypto.createHash('sha1').update(x.name).digest('hex').slice(0, 12),
            name: x.name,
            img: x.image,
            usd,
            api: p
        });
    }

    result.sort((a,b) => a.usd - b.usd);
    console.log('Priced weapon items:', result.length, 'batches:', batches.length);
    return result.slice(0, 7000);
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

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 3000);
                const r =
                    await fetch(
                        'https://kurs-rublya.ru/api/v1/rates/USD/',
                        {
                            signal: controller.signal,
                            headers: {
                                Accept:
                                    'application/json'
                            }
                        }
                    );
                clearTimeout(timer);

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
