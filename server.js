const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;

const CS2SH_API_KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ''
).trim();

const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();
const STEAM_REALM = process.env.STEAM_REALM || '';
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL || '';

let catalogCache = null;
let catalogCacheTime = 0;
let catalogPromise = null;

const CACHE_TTL = 10 * 60 * 1000;

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });

  res.end(body);
}

function request(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 120000
    }, res => {
      const chunks = [];

      res.on('data', chunk => chunks.push(chunk));

      res.on('end', () => {
        let buffer = Buffer.concat(chunks);

        try {
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();

          if (encoding.includes('gzip')) {
            buffer = zlib.gunzipSync(buffer);
          } else if (encoding.includes('br')) {
            buffer = zlib.brotliDecompressSync(buffer);
          } else if (encoding.includes('deflate')) {
            buffer = zlib.inflateSync(buffer);
          }
        } catch (e) {
          return reject(new Error('Ошибка распаковки ответа API: ' + e.message));
        }

        const body = buffer.toString('utf8');

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`)
          );
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Таймаут запроса'));
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function cs2sh(path, options = {}) {
  if (!CS2SH_API_KEY) {
    throw new Error('CS2SH_API_KEY не задан в Environment Variables');
  }

  return request('https://api.cs2.sh' + path, {
    method: options.method || 'GET',
    timeout: 120000,
    headers: {
      'Authorization': `Bearer ${CS2SH_API_KEY}`,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      ...(options.body
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(options.body)
          }
        : {})
    },
    body: options.body
  });
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function extractPrice(item) {
  if (!item || typeof item !== 'object') return 0;

  const sources = [
    item.steam,
    item.csfloat,
    item.buff,
    item.youpin,
    item.skinport,
    item.c5game
  ];

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;

    const values = [
      source.ask,
      source.price,
      source.sell,
      source.min_price,
      source.lowest_price
    ];

    for (const value of values) {
      const n = positiveNumber(value);
      if (n > 0) return n;
    }
  }

  const direct = [
    item.ask,
    item.price,
    item.usd,
    item.value
  ];

  for (const value of direct) {
    const n = positiveNumber(value);
    if (n > 0) return n;
  }

  return 0;
}

function isForbidden(item) {
  const name = String(
    item?.market_hash_name ||
    item?.name ||
    ''
  ).toLowerCase();

  const category = String(
    item?.category ||
    item?.type ||
    ''
  ).toLowerCase();

  return (
    category.includes('sticker') ||
    category.includes('charm') ||
    category.includes('keychain') ||
    name.includes('sticker') ||
    name.includes('charm') ||
    name.includes('keychain')
  );
}

async function buildCs2Catalog() {
  if (!CS2SH_API_KEY) {
    throw new Error('CS2SH_API_KEY не задан');
  }

  console.log('[CS2] Загружаю schema + prices...');

  const [schemaResponse, pricesResponse] = await Promise.all([
    cs2sh('/v1/schema'),
    cs2sh('/v1/prices/latest')
  ]);

  const schema = JSON.parse(schemaResponse.body);
  const prices = JSON.parse(pricesResponse.body);

  const schemaItems =
    Array.isArray(schema)
      ? schema
      : Object.entries(schema || {}).map(([market_hash_name, value]) => ({
          market_hash_name,
          ...(value && typeof value === 'object' ? value : {})
        }));

  let priceMap = prices;

  if (prices && typeof prices === 'object') {
    if (prices.items && typeof prices.items === 'object') {
      priceMap = prices.items;
    }

    if (prices.data && typeof prices.data === 'object') {
      priceMap = prices.data;
    }
  }

  const result = [];

  for (const item of schemaItems) {
    if (!item || typeof item !== 'object') continue;
    if (isForbidden(item)) continue;

    const marketHashName = String(
      item.market_hash_name ||
      item.name ||
      ''
    ).trim();

    if (!marketHashName) continue;

    const priceData =
      priceMap?.[marketHashName] ||
      priceMap?.items?.[marketHashName] ||
      null;

    const usd = extractPrice(priceData);

    if (!usd) continue;

    const image =
      item.image ||
      item.image_url ||
      item.icon_url ||
      item.icon ||
      '';

    result.push({
      name: marketHashName,
      market_hash_name: marketHashName,
      usd,
      image,
      rarity: item.rarity || '',
      category: item.category || 'skin',
      type: item.type || '',
      weapon: item.weapon || '',
      exterior: item.exterior || '',
      float: item.float ?? null
    });
  }

  result.sort((a, b) => b.usd - a.usd);

  // Ограничиваем размер ответа, чтобы Render и браузер не тормозили.
  const finalResult = result.slice(0, 2500);

  console.log(
    `[CS2] Каталог готов: ${finalResult.length} предметов`
  );

  return finalResult;
}

async function getCatalog() {
  const now = Date.now();

  if (
    catalogCache &&
    now - catalogCacheTime < CACHE_TTL
  ) {
    return catalogCache;
  }

  if (catalogPromise) {
    return catalogPromise;
  }

  catalogPromise = buildCs2Catalog()
    .then(data => {
      catalogCache = data;
      catalogCacheTime = Date.now();
      return data;
    })
    .finally(() => {
      catalogPromise = null;
    });

  return catalogPromise;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';

  const cookies = header.split(';');

  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=');

    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return '';
}

const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    user,
    createdAt: Date.now()
  });

  return token;
}

async function getSteamPlayer(steamId) {
  if (!STEAM_API_KEY || !steamId) {
    return {
      steamid: steamId
    };
  }

  try {
    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/' +
      `?key=${encodeURIComponent(STEAM_API_KEY)}` +
      `&steamids=${encodeURIComponent(steamId)}`;

    const response = await request(url, {
      timeout: 15000,
      headers: {
        'Accept-Encoding': 'gzip'
      }
    });

    const data = JSON.parse(response.body);

    return data?.response?.players?.[0] || {
      steamid: steamId
    };
  } catch (e) {
    console.error('[Steam]', e.message);

    return {
      steamid: steamId
    };
  }
}

function steamLoginUrl() {
  const realm =
    STEAM_REALM ||
    `http://localhost:${PORT}`;

  const returnUrl =
    STEAM_RETURN_URL ||
    `${realm.replace(/\/$/, '')}/auth/steam/callback`;

  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnUrl,
    'openid.realm': realm,
    'openid.identity':
      'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id':
      'http://specs.openid.net/auth/2.0/identifier_select'
  });

  return `https://steamcommunity.com/openid/login?${params.toString()}`;
}

async function verifySteam(reqUrl) {
  const params = reqUrl.searchParams;

  const claimedId = params.get('openid.claimed_id');

  if (!claimedId) {
    throw new Error('Нет Steam claimed_id');
  }

  const match = claimedId.match(/\/id\/(\d+)$/);

  if (!match) {
    throw new Error('Не удалось получить Steam ID');
  }

  const steamId = match[1];

  const verifyParams = new URLSearchParams();

  for (const [key, value] of params.entries()) {
    verifyParams.set(key, value);
  }

  verifyParams.set('openid.mode', 'check_authentication');

  const response = await request(
    'https://steamcommunity.com/openid/login',
    {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(
          verifyParams.toString()
        )
      },
      body: verifyParams.toString()
    }
  );

  if (!response.body.includes('is_valid:true')) {
    throw new Error('Steam OpenID не подтверждён');
  }

  return steamId;
}

async function handle(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    return res.end();
  }

  // Главная страница
  if (
    req.method === 'GET' &&
    (url.pathname === '/' || url.pathname === '/index.html')
  ) {
    try {
      const fs = require('fs');
      const path = require('path');

      const file =
        path.join(__dirname, 'Zenodrop_CS2SH_400.html');

      if (fs.existsSync(file)) {
        return text(
          res,
          200,
          fs.readFileSync(file, 'utf8'),
          'text/html; charset=utf-8'
        );
      }

      return text(
        res,
        404,
        'Zenodrop HTML не найден'
      );
    } catch (e) {
      return text(res, 500, e.message);
    }
  }

  // CS2 каталог — HTML должен обращаться только сюда.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/cs2/catalog'
  ) {
    try {
      const catalog = await getCatalog();

      return json(res, 200, {
        ok: true,
        count: catalog.length,
        items: catalog
      });
    } catch (e) {
      console.error('[CS2 catalog]', e);

      return json(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  // Полная schema через backend.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/cs2/schema'
  ) {
    try {
      const response = await cs2sh('/v1/schema');

      return json(
        res,
        200,
        JSON.parse(response.body)
      );
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  // Универсальный прокси цен.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/prices'
  ) {
    try {
      const response = await cs2sh('/v1/prices/latest');

      return text(
        res,
        200,
        response.body,
        'application/json; charset=utf-8'
      );
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  // Текущий пользователь.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/current-user'
  ) {
    const token = getCookie(req, 'zenodrop_session');
    const session = sessions.get(token);

    if (!session) {
      return json(res, 200, {
        authenticated: false,
        user: null
      });
    }

    return json(res, 200, {
      authenticated: true,
      user: session.user
    });
  }

  // Steam login.
  if (
    req.method === 'GET' &&
    url.pathname === '/auth/steam'
  ) {
    res.writeHead(302, {
      Location: steamLoginUrl()
    });

    return res.end();
  }

  // Steam callback.
  if (
    req.method === 'GET' &&
    url.pathname === '/auth/steam/callback'
  ) {
    try {
      const steamId = await verifySteam(url);

      const player = await getSteamPlayer(steamId);

      const user = {
        steamid: steamId,
        id: steamId,
        name:
          player.personaname ||
          `Steam ${steamId}`,
        avatar:
          player.avatarfull ||
          player.avatarmedium ||
          player.avatar ||
          '',
        profile:
          player.profileurl ||
          `https://steamcommunity.com/profiles/${steamId}`
      };

      const token = createSession(user);

      res.writeHead(302, {
        Location: '/',
        'Set-Cookie':
          `zenodrop_session=${encodeURIComponent(token)}; ` +
          'Path=/; HttpOnly; SameSite=Lax'
      });

      return res.end();
    } catch (e) {
      console.error('[Steam auth]', e);

      return text(
        res,
        500,
        'Ошибка авторизации Steam: ' + e.message
      );
    }
  }

  // Logout.
  if (
    req.method === 'GET' &&
    url.pathname === '/auth/logout'
  ) {
    const token = getCookie(req, 'zenodrop_session');

    if (token) {
      sessions.delete(token);
    }

    res.writeHead(302, {
      Location: '/',
      'Set-Cookie':
        'zenodrop_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    });

    return res.end();
  }

  // USD/RUB.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/usd-rub'
  ) {
    try {
      const response = await request(
        'https://open.er-api.com/v6/latest/USD',
        {
          timeout: 15000,
          headers: {
            'Accept-Encoding': 'gzip'
          }
        }
      );

      const data = JSON.parse(response.body);
      const rub = Number(data?.rates?.RUB);

      if (!Number.isFinite(rub) || rub <= 0) {
        throw new Error('Не удалось получить курс RUB');
      }

      return json(res, 200, {
        ok: true,
        usd_rub: rub
      });
    } catch (e) {
      console.error('[USD/RUB]', e);

      return json(res, 200, {
        ok: false,
        usd_rub: 80
      });
    }
  }

  return json(res, 404, {
    ok: false,
    error: 'Not found'
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[SERVER]', err);

    if (!res.headersSent) {
      json(res, 500, {
        ok: false,
        error: err.message
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Zenodrop server started on port ${PORT}`);

  // Предзагрузка каталога после запуска.
  setTimeout(() => {
    getCatalog()
      .then(() => {
        console.log('[CS2] Предзагрузка завершена');
      })
      .catch(err => {
        console.error(
          '[CS2] Предзагрузка не удалась:',
          err.message
        );
      });
  }, 100);
});
