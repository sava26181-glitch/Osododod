const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const KEY = process.env.CS2SH_API_KEY;

// Твой Steam Web API ключ для получения профиля
const STEAM_API_KEY = '4DC2D6431BE21B53EBAE0E4A7CCDB1D3';

if (!KEY) {
    console.error('Set CS2SH_API_KEY environment variable');
    process.exit(1);
}

const html = fs.readFileSync(
    path.join(__dirname, 'Zenodrop_CS2SH_400.html')
);

// Простейшее хранилище сессий в памяти (session_id -> user_data)
const sessions = new Map();

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    rc && rc.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // Парсим куки для всех запросов
    const cookies = parseCookies(req);
    let sessionUser = null;
    if (cookies.session_id && sessions.has(cookies.session_id)) {
        sessionUser = sessions.get(cookies.session_id);
    }

    // --- СТИМ АВТОРИЗАЦИЯ ---

    // 1. Шаг редиректа в Steam
    if (pathname === '/auth/steam') {
        const realm = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
        const returnTo = `${realm}/auth/steam/return`;
        
        const params = new URLSearchParams({
            'openid.ns': 'http://specs.openid.net/auth/2.0',
            'openid.mode': 'checkid_setup',
            'openid.return_to': returnTo,
            'openid.realm': realm,
            'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
            'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
        });

        res.writeHead(302, { 'Location': `https://steamcommunity.com/openid/login?${params.toString()}` });
        return res.end();
    }

    // 2. Шаг возврата из Steam и проверка подлинности
    if (pathname === '/auth/steam/return') {
        try {
            const params = new URLSearchParams();
            params.append('openid.ns', 'http://specs.openid.net/auth/2.0');
            params.append('openid.mode', 'check_authentication');
            
            urlObj.searchParams.forEach((value, key) => {
                if (key !== 'openid.mode') {
                    params.append(key, value);
                }
            });

            const verification = await fetch('https://steamcommunity.com/openid/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
            });

            const verificationText = await verification.text();

            if (verificationText.includes('is_valid:true')) {
                const claimedId = urlObj.searchParams.get('openid.claimed_id');
                const match = claimedId ? claimedId.match(/\/id\/([0-9]{17})/) : null;
                const steamId = match ? match[1] : null;

                if (steamId) {
                    // Запрашиваем реальный профиль через Steam Web API
                    const playerRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
                    const playerData = await playerRes.json();
                    const player = playerData.response?.players?.[0] || {};

                    const userData = {
                        steamid: steamId,
                        username: player.personaname || 'Unknown',
                        avatar: player.avatarfull || player.avatarmedium || player.avatar || ''
                    };

                    const sessionId = crypto.randomBytes(16).toString('hex');
                    sessions.set(sessionId, userData);

                    res.writeHead(302, {
                        'Location': '/',
                        'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
                    });
                    return res.end();
                }
            }
        } catch (e) {
            console.error('Steam Auth Error:', e);
        }

        res.writeHead(302, { 'Location': '/' });
        return res.end();
    }

    // 3. Получение текущего пользователя на фронтенд
    if (pathname === '/api/current-user' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify(sessionUser || null));
    }

    // 4. Выход из аккаунта
    if (pathname === '/auth/logout') {
        if (cookies.session_id) {
            sessions.delete(cookies.session_id);
        }
        res.writeHead(302, {
            'Location': '/',
            'Set-Cookie': 'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        });
        return res.end();
    }

    // --- КОНЕЦ СТИМ АВТОРИЗАЦИИ ---


    // Главная страница
    if (req.url === '/') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8'
        });

        return res.end(html);
    }

    // Автоматический курс USD/RUB
    if (req.url === '/api/usd-rub' && req.method === 'GET') {
        try {
            const r = await fetch(
                'https://kurs-rublya.ru/api/v1/rates/USD/',
                {
                    headers: {
                        'Accept': 'application/json'
                    },
                    cache: 'no-store'
                }
            );

            const text = await r.text();

            if (!r.ok) {
                res.writeHead(r.status, {
                    'Content-Type': 'application/json'
                });

                return res.end(text);
            }

            const d = JSON.parse(text);

            const rate = Number(
                d.ratePerUnit ||
                d.value ||
                d.data?.ratePerUnit ||
                d.data?.rate
            );

            if (!Number.isFinite(rate) || rate <= 0) {
                throw new Error('Invalid USD rate');
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            });

            return res.end(JSON.stringify({
                rate,
                source: 'kurs-rublya.ru',
                updatedAt: new Date().toISOString()
            }));

        } catch (e) {

            res.writeHead(502, {
                'Content-Type': 'application/json'
            });

            return res.end(JSON.stringify({
                error: String(e)
            }));
        }
    }

    // Схема CS2.SH через серверный прокси.
    // Ключ хранится только в переменной окружения Render.
    if (req.url === '/api/cs2/schema' && req.method === 'GET') {
        try {
            const r = await fetch(
                'https://api.cs2.sh/v1/schema',
                {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + KEY,
                        'Accept-Encoding': 'gzip'
                    }
                }
            );

            const text = await r.text();

            res.writeHead(r.status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });

            return res.end(text);
        } catch (e) {
            res.writeHead(502, {
                'Content-Type': 'application/json; charset=utf-8'
            });

            return res.end(JSON.stringify({
                error: 'cs2_schema_proxy_error',
                message: String(e)
            }));
        }
    }

    // Цены CS2.SH через серверный прокси.
    if (req.url === '/api/prices' && req.method === 'POST') {

        let body = '';

        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {

            try {

                const input = JSON.parse(body || '{}');

                // cs2.sh принимает максимум 100 market_hash_name за POST-запрос.
                const items = Array.isArray(input.items)
                    ? input.items
                        .filter(x => typeof x === 'string' && x.trim())
                        .slice(0, 100)
                    : [];

                const r = await fetch(
                    'https://api.cs2.sh/v1/prices/latest',
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + KEY,
                            'Content-Type': 'application/json',
                            'Accept-Encoding': 'gzip'
                        },
                        body: JSON.stringify({
                            items
                        })
                    }
                );

                const text = await r.text();

                res.writeHead(r.status, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                });

                res.end(text);

            } catch (e) {

                res.writeHead(502, {
                    'Content-Type': 'application/json'
                });

                res.end(JSON.stringify({
                    error: String(e)
                }));
            }
        });

        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(
        'Zenodrop: http://localhost:' + PORT
    );
});
