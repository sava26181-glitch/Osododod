const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;

const CS2SH_API_KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ''
).trim();

const STEAM_API_KEY = (
  process.env.STEAM_API_KEY || ''
).trim();

const STEAM_REALM = (
  process.env.STEAM_REALM || ''
).trim();

const STEAM_RETURN_URL = (
  process.env.STEAM_RETURN_URL || ''
).trim();

let catalogCache = null;
let catalogCacheTime = 0;
let catalogPromise = null;

const CACHE_TTL = 10 * 60 * 1000;

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
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
          const encoding = String(
            res.headers['content-encoding'] || ''
          ).toLowerCase();

          if (encoding.includes('gzip')) {
            buffer = zlib.gunzipSync(buffer);
          } else if (encoding.includes('br')) {
            buffer = zlib.brotliDecompressSync(buffer);
          } else if (encoding.includes('deflate')) {
            buffer = zlib.inflateSync(buffer);
          }
        } catch (e) {
          return reject(
            new Error('Ошибка распаковки API: ' + e.message)
          );
        }

        const body = buffer.toString('utf8');

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              `cs2.sh HTTP ${res.statusCode}: ${body.slice(0, 1000)}`
            )
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
      req.destroy(new Error('Таймаут запроса к API'));
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function cs2Request(endpoint) {
  if (!CS2SH_API_KEY) {
    throw new Error(
      'CS2SH_API_KEY не задан в Render Environment Variables'
    );
  }

  return request(
    'https://api.cs2.sh' + endpoint,
    {
      method: 'GET',
      timeout: 120000,
      headers: {
        'Authorization': `Bearer ${CS2SH_API_KEY}`,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      }
    }
  );
}

function getPrice(item) {
  if (!item || typeof item !== 'object') {
    return 0;
  }

  const sources = [
    'steam',
    'csfloat',
    'buff',
    'youpin',
    'skinport',
    'c5game'
  ];

  for (const sourceName of sources) {
    const source = item[sourceName];

    if (!source || typeof source !== 'object') {
      continue;
    }

    const values = [
      source.ask,
      source.price,
      source.sell,
      source.min_price,
      source.lowest_price
    ];

    for (const value of values) {
      const n = Number(value);

      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }
  }

  return 0;
}

function isForbidden(item, name) {
  const category = String(
    item?.category || ''
  ).toLowerCase();

  const type = String(
    item?.type || ''
  ).toLowerCase();

  const text = String(
    name || item?.market_hash_name || ''
  ).toLowerCase();

  return (
    category.includes('sticker') ||
    category.includes('charm') ||
    category.includes('keychain') ||

    type.includes('sticker') ||
    type.includes('charm') ||
    type.includes('keychain') ||

    text.includes('sticker') ||
    text.includes('charm') ||
    text.includes('keychain')
  );
}

async function buildCatalog() {
  console.log('[CS2] Загружаю schema и prices...');

  if (!CS2SH_API_KEY) {
    throw new Error(
      'На Render отсутствует переменная CS2SH_API_KEY'
    );
  }

  // Оба больших запроса выполняются одновременно.
  const [schemaResponse, pricesResponse] = await Promise.all([
    cs2Request('/v1/schema'),
    cs2Request('/v1/prices/latest')
  ]);

  const schema = JSON.parse(schemaResponse.body);
  const prices = JSON.parse(pricesResponse.body);

  /*
    ВАЖНО:

    cs2.sh:

    schema.items = {
      "AK-47 | Redline (Field-Tested)": {...},
      ...
    }

    prices.items = {
      "AK-47 | Redline (Field-Tested)": {...},
      ...
    }
  */

  const schemaItems =
    schema &&
    schema.items &&
    typeof schema.items === 'object'
      ? schema.items
      : {};

  const priceItems =
    prices &&
    prices.items &&
    typeof prices.items === 'object'
      ? prices.items
      : {};

  console.log(
    `[CS2] Schema items: ${Object.keys(schemaItems).length}`
  );

  console.log(
    `[CS2] Price items: ${Object.keys(priceItems).length}`
  );

  const result = [];

  for (const [marketHashName, schemaItem] of Object.entries(schemaItems)) {
    if (!schemaItem || typeof schemaItem !== 'object') {
      continue;
    }

    if (isForbidden(schemaItem, marketHashName)) {
      continue;
    }

    const priceItem = priceItems[marketHashName];

    if (!priceItem) {
      continue;
    }

    const usd = getPrice(priceItem);

    if (!usd || usd <= 0) {
      continue;
    }

    result.push({
      name: marketHashName,
      market_hash_name: marketHashName,

      usd: Number(usd),

      image:
        schemaItem.image ||
        schemaItem.steam_image ||
        '',

      category:
        schemaItem.category ||
        'skin',

      rarity:
        typeof schemaItem.rarity === 'object'
          ? (
              schemaItem.rarity.name ||
              schemaItem.rarity.tier ||
              ''
            )
          : (
              schemaItem.rarity || ''
            ),

      weapon:
        schemaItem.weapon ||
        '',

      exterior:
        schemaItem.exterior ||
        '',

      tradable:
        schemaItem.is_tradable !== false
    });
  }

  // Самые дорогие сверху.
  result.sort((a, b) => b.usd - a.usd);

  // Не отправляем браузеру десятки тысяч предметов.
  const finalCatalog = result.slice(0, 2500);

  console.log(
    `[CS2] Готово: ${finalCatalog.length} предметов`
  );

  return finalCatalog;
}

async function getCatalog() {
  const now = Date.now();

  if (
    catalogCache &&
    catalogCacheTime &&
    now - catalogCacheTime < CACHE_TTL
  ) {
    return catalogCache;
  }

  if (catalogPromise) {
    return catalogPromise;
  }

  catalogPromise = buildCatalog()
    .then(catalog => {
      catalogCache = catalog;
      catalogCacheTime = Date.now();

      return catalog;
    })
    .finally(() => {
      catalogPromise = null;
    });

  return catalogPromise;
}

/* =========================
   STEAM
========================= */

const sessions = new Map();

function getCookie(req, name) {
  const header = req.headers.cookie || '';

  for (const item of header.split(';')) {
    const parts = item.trim().split('=');
    const key = parts.shift();

    if (key === name) {
      return decodeURIComponent(parts.join('='));
    }
  }

  return '';
}

function createSession(user) {
  const token = crypto
    .randomBytes(32)
    .toString('hex');

  sessions.set(token, {
    user,
    createdAt: Date.now()
  });

  return token;
}

function getSteamLoginURL() {
  const realm =
    STEAM_REALM ||
    `http://localhost:${PORT}`;

  const returnUrl =
    STEAM_RETURN_URL ||
    `${realm.replace(/\/$/, '')}/auth/steam/callback`;

  const params = new URLSearchParams({
    'openid.ns':
      'http://specs.openid.net/auth/2.0',

    'openid.mode':
      'checkid_setup',

    'openid.return_to':
      returnUrl,

    'openid.realm':
      realm,

    'openid.identity':
      'http://specs.openid.net/auth/2.0/identifier_select',

    'openid.claimed_id':
      'http://specs.openid.net/auth/2.0/identifier_select'
  });

  return (
    'https://steamcommunity.com/openid/login?' +
    params.toString()
  );
}

async function verifySteam(url) {
  const params = url.searchParams;

  const claimedId =
    params.get('openid.claimed_id');

  if (!claimedId) {
    throw new Error('Steam claimed_id отсутствует');
  }

  const match =
    claimedId.match(/\/id\/(\d+)$/);

  if (!match) {
    throw new Error('Не удалось получить Steam ID');
  }

  const steamId = match[1];

  const verify = new URLSearchParams();

  for (const [key, value] of params.entries()) {
    verify.set(key, value);
  }

  verify.set(
    'openid.mode',
    'check_authentication'
  );

  const response = await request(
    'https://steamcommunity.com/openid/login',
    {
      method: 'POST',

      timeout: 20000,

      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',

        'Content-Length':
          Buffer.byteLength(verify.toString())
      },

      body: verify.toString()
    }
  );

  if (!response.body.includes('is_valid:true')) {
    throw new Error(
      'Steam не подтвердил авторизацию'
    );
  }

  return steamId;
}

async function getSteamUser(steamId) {
  if (!STEAM_API_KEY) {
    return {
      steamid: steamId
    };
  }

  try {
    const url =
      'https://api.steampowered.com/' +
      'ISteamUser/GetPlayerSummaries/v2/' +
      `?key=${encodeURIComponent(STEAM_API_KEY)}` +
      `&steamids=${encodeURIComponent(steamId)}`;

    const response = await request(url, {
      timeout: 15000,
      headers: {
        'Accept-Encoding': 'gzip'
      }
    });

    const data = JSON.parse(response.body);

    return (
      data?.response?.players?.[0] || {
        steamid: steamId
      }
    );
  } catch (e) {
    console.error(
      '[Steam API]',
      e.message
    );

    return {
      steamid: steamId
    };
  }
}

/* =========================
   SERVER
========================= */

async function handle(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods':
        'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type'
    });

    return res.end();
  }

  /* HTML */

  if (
    req.method === 'GET' &&
    (
      url.pathname === '/' ||
      url.pathname === '/index.html'
    )
  ) {
    const file = path.join(
      __dirname,
      'Zenodrop_CS2SH_400.html'
    );

    if (!fs.existsSync(file)) {
      return sendText(
        res,
        404,
        'Zenodrop_CS2SH_400.html не найден'
      );
    }

    return sendText(
      res,
      200,
      fs.readFileSync(file, 'utf8'),
      'text/html; charset=utf-8'
    );
  }

  /* =========================
     CS2 CATALOG
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/cs2/catalog'
  ) {
    try {
      const catalog = await getCatalog();

      return sendJSON(res, 200, {
        ok: true,
        count: catalog.length,
        items: catalog
      });

    } catch (e) {
      console.error(
        '[CS2 CATALOG ERROR]',
        e.message
      );

      return sendJSON(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  /* =========================
     CS2 SCHEMA
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/cs2/schema'
  ) {
    try {
      const response =
        await cs2Request('/v1/schema');

      return sendText(
        res,
        200,
        response.body,
        'application/json; charset=utf-8'
      );

    } catch (e) {
      return sendJSON(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  /* =========================
     CS2 PRICES
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/prices'
  ) {
    try {
      const response =
        await cs2Request('/v1/prices/latest');

      return sendText(
        res,
        200,
        response.body,
        'application/json; charset=utf-8'
      );

    } catch (e) {
      return sendJSON(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  /* =========================
     USD/RUB
  ========================= */

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

      const data =
        JSON.parse(response.body);

      const rate =
        Number(data?.rates?.RUB);

      if (
        !Number.isFinite(rate) ||
        rate <= 0
      ) {
        throw new Error(
          'Некорректный курс RUB'
        );
      }

      return sendJSON(res, 200, {
        ok: true,
        usd_rub: rate
      });

    } catch (e) {
      return sendJSON(res, 200, {
        ok: false,
        usd_rub: 80
      });
    }
  }

  /* =========================
     CURRENT USER
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/current-user'
  ) {
    const token =
      getCookie(
        req,
        'zenodrop_session'
      );

    const session =
      sessions.get(token);

    if (!session) {
      return sendJSON(res, 200, {
        authenticated: false,
        user: null
      });
    }

    return sendJSON(res, 200, {
      authenticated: true,
      user: session.user
    });
  }

  /* =========================
     STEAM LOGIN
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/auth/steam'
  ) {
    res.writeHead(302, {
      Location: getSteamLoginURL()
    });

    return res.end();
  }

  /* =========================
     STEAM CALLBACK
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/auth/steam/callback'
  ) {
    try {
      const steamId =
        await verifySteam(url);

      const player =
        await getSteamUser(steamId);

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

      const token =
        createSession(user);

      res.writeHead(302, {
        Location: '/',

        'Set-Cookie':
          `zenodrop_session=${encodeURIComponent(token)}; ` +
          'Path=/; HttpOnly; SameSite=Lax'
      });

      return res.end();

    } catch (e) {
      console.error(
        '[STEAM LOGIN]',
        e.message
      );

      return sendText(
        res,
        500,
        'Ошибка авторизации Steam: ' +
        e.message
      );
    }
  }

  /* =========================
     LOGOUT
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/auth/logout'
  ) {
    const token =
      getCookie(
        req,
        'zenodrop_session'
      );

    if (token) {
      sessions.delete(token);
    }

    res.writeHead(302, {
      Location: '/',

      'Set-Cookie':
        'zenodrop_session=; ' +
        'Path=/; Max-Age=0; ' +
        'HttpOnly; SameSite=Lax'
    });

    return res.end();
  }

  return sendJSON(res, 404, {
    ok: false,
    error: 'Not found'
  });
}

const server = http.createServer(
  (req, res) => {
    handle(req, res).catch(err => {
      console.error(
        '[SERVER ERROR]',
        err
      );

      if (!res.headersSent) {
        sendJSON(res, 500, {
          ok: false,
          error: err.message
        });
      } else {
        res.end();
      }
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Zenodrop server started on ${PORT}`
    );

    if (!CS2SH_API_KEY) {
      console.error(
        '!!! CS2SH_API_KEY НЕ ЗАДАН !!!'
      );
    } else {
      console.log(
        'CS2SH_API_KEY найден'
      );
    }

    // Предзагрузка каталога.
    setTimeout(() => {
      getCatalog()
        .then(() => {
          console.log(
            '[CS2] Каталог успешно загружен'
          );
        })
        .catch(err => {
          console.error(
            '[CS2] Ошибка загрузки:',
            err.message
          );
        });
    }, 500);
  }
);
