const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;

const SITE_URL = 'https://osododod.onrender.com';
const STEAM_CALLBACK = SITE_URL + '/auth/steam/callback';

const CS2SH_API_KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ''
).trim();

const STEAM_API_KEY = (
  process.env.STEAM_API_KEY || ''
).trim();

const SESSION_SECRET = (
  process.env.SESSION_SECRET ||
  CS2SH_API_KEY ||
  STEAM_API_KEY ||
  'zenodrop-session-secret-change-me'
).trim();

let catalogCache = null;
let catalogCacheTime = 0;
let catalogPromise = null;

const CACHE_TTL = 10 * 60 * 1000;


/* =========================================================
   HTTP
========================================================= */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(body);
}

function sendText(
  res,
  status,
  body,
  type = 'text/plain; charset=utf-8'
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });

  res.end(body);
}

function request(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);

    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 120000
      },
      res => {
        const chunks = [];

        res.on('data', chunk => {
          chunks.push(chunk);
        });

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
              new Error(
                'Ошибка распаковки ответа API: ' +
                e.message
              )
            );
          }

          const body = buffer.toString('utf8');

          if (
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            return reject(
              new Error(
                `HTTP ${res.statusCode}: ${body.slice(0, 1000)}`
              )
            );
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(
        new Error('Таймаут запроса')
      );
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}


/* =========================================================
   CS2.SH
========================================================= */

async function cs2Request(endpoint) {
  if (!CS2SH_API_KEY) {
    throw new Error(
      'CS2SH_API_KEY не задан на Render'
    );
  }

  return request(
    'https://api.cs2.sh' + endpoint,
    {
      method: 'GET',
      timeout: 120000,
      headers: {
        Authorization:
          `Bearer ${CS2SH_API_KEY}`,
        Accept:
          'application/json',
        'Accept-Encoding':
          'gzip'
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

      if (
        Number.isFinite(n) &&
        n > 0
      ) {
        return n;
      }
    }
  }

  const direct = [
    item.ask,
    item.price,
    item.usd
  ];

  for (const value of direct) {
    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n > 0
    ) {
      return n;
    }
  }

  return 0;
}

function isForbidden(name, item) {
  const text = (
    String(name || '') +
    ' ' +
    String(item?.category || '') +
    ' ' +
    String(item?.type || '')
  ).toLowerCase();

  return (
    text.includes('sticker') ||
    text.includes('charm') ||
    text.includes('keychain')
  );
}

async function buildCatalog() {
  console.log('[CS2] Загружаю schema + prices...');

  if (!CS2SH_API_KEY) {
    throw new Error(
      'CS2SH_API_KEY отсутствует'
    );
  }

  const [
    schemaResponse,
    pricesResponse
  ] = await Promise.all([
    cs2Request('/v1/schema'),
    cs2Request('/v1/prices/latest')
  ]);

  const schema =
    JSON.parse(schemaResponse.body);

  const prices =
    JSON.parse(pricesResponse.body);

  const schemaItems =
    schema?.items &&
    typeof schema.items === 'object'
      ? schema.items
      : {};

  const priceItems =
    prices?.items &&
    typeof prices.items === 'object'
      ? prices.items
      : {};

  console.log(
    '[CS2] Schema items:',
    Object.keys(schemaItems).length
  );

  console.log(
    '[CS2] Price items:',
    Object.keys(priceItems).length
  );

  const result = [];

  for (
    const [name, item]
    of Object.entries(schemaItems)
  ) {
    if (!item) continue;

    if (isForbidden(name, item)) {
      continue;
    }

    const priceItem =
      priceItems[name];

    if (!priceItem) {
      continue;
    }

    const usd =
      getPrice(priceItem);

    if (!usd || usd <= 0) {
      continue;
    }

    result.push({
      name,
      market_hash_name: name,
      usd: Number(usd),

      image:
        item.image ||
        item.image_url ||
        item.steam_image ||
        '',

      category:
        item.category ||
        'skin',

      rarity:
        typeof item.rarity === 'object'
          ? (
              item.rarity.name ||
              item.rarity.tier ||
              ''
            )
          : (
              item.rarity || ''
            ),

      weapon:
        item.weapon || '',

      exterior:
        item.exterior || '',

      tradable:
        item.is_tradable !== false
    });
  }

  result.sort(
    (a, b) =>
      b.usd - a.usd
  );

  console.log(
    '[CS2] Всего предметов:',
    result.length
  );

  return result;
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

  catalogPromise =
    buildCatalog()
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


/* =========================================================
   COOKIE SESSION
========================================================= */

function sign(value) {
  return crypto
    .createHmac(
      'sha256',
      SESSION_SECRET
    )
    .update(value)
    .digest('hex');
}

function createSessionCookie(user) {
  const payload =
    Buffer.from(
      JSON.stringify(user),
      'utf8'
    ).toString('base64url');

  const signature =
    sign(payload);

  return `${payload}.${signature}`;
}

function readSessionCookie(value) {
  if (!value) {
    return null;
  }

  const dot =
    value.lastIndexOf('.');

  if (dot <= 0) {
    return null;
  }

  const payload =
    value.slice(0, dot);

  const signature =
    value.slice(dot + 1);

  const expected =
    sign(payload);

  const a =
    Buffer.from(signature);

  const b =
    Buffer.from(expected);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(
        payload,
        'base64url'
      ).toString('utf8')
    );
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header =
    req.headers.cookie || '';

  for (
    const cookie
    of header.split(';')
  ) {
    const parts =
      cookie.trim().split('=');

    const key =
      parts.shift();

    if (key === name) {
      return decodeURIComponent(
        parts.join('=')
      );
    }
  }

  return '';
}


/* =========================================================
   STEAM
========================================================= */

function getSteamLoginURL() {
  const params =
    new URLSearchParams({
      'openid.ns':
        'http://specs.openid.net/auth/2.0',

      'openid.mode':
        'checkid_setup',

      'openid.return_to':
        STEAM_CALLBACK,

      'openid.realm':
        SITE_URL,

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
  const params =
    url.searchParams;

  const claimedId =
    params.get(
      'openid.claimed_id'
    );

  if (!claimedId) {
    throw new Error(
      'Steam не вернул claimed_id'
    );
  }

  const match =
    claimedId.match(
      /\/id\/(\d+)$/
    );

  if (!match) {
    throw new Error(
      'Не удалось получить Steam ID'
    );
  }

  const steamId =
    match[1];

  const verify =
    new URLSearchParams();

  for (
    const [key, value]
    of params.entries()
  ) {
    verify.set(
      key,
      value
    );
  }

  verify.set(
    'openid.mode',
    'check_authentication'
  );

  const response =
    await request(
      'https://steamcommunity.com/openid/login',
      {
        method: 'POST',

        timeout: 20000,

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',

          'Content-Length':
            Buffer.byteLength(
              verify.toString()
            )
        },

        body:
          verify.toString()
      }
    );

  if (
    !response.body.includes(
      'is_valid:true'
    )
  ) {
    throw new Error(
      'Steam не подтвердил OpenID'
    );
  }

  return steamId;
}

async function getSteamUser(steamId) {
  if (!STEAM_API_KEY) {
    return {
      steamid: steamId,
      personaname:
        `Steam ${steamId}`
    };
  }

  try {
    const api =
      'https://api.steampowered.com/' +
      'ISteamUser/GetPlayerSummaries/v2/' +
      `?key=${encodeURIComponent(
        STEAM_API_KEY
      )}` +
      `&steamids=${encodeURIComponent(
        steamId
      )}`;

    const response =
      await request(api, {
        timeout: 15000,

        headers: {
          Accept:
            'application/json',

          'Accept-Encoding':
            'gzip'
        }
      });

    const data =
      JSON.parse(
        response.body
      );

    return (
      data?.response?.players?.[0] || {
        steamid: steamId
      }
    );
  } catch (e) {
    console.error(
      '[STEAM API]',
      e.message
    );

    return {
      steamid: steamId
    };
  }
}


/* =========================================================
   SERVER
========================================================= */

async function handle(req, res) {
  const url =
    new URL(
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


  /* =========================
     HTML
  ========================= */

  if (
    req.method === 'GET' &&
    (
      url.pathname === '/' ||
      url.pathname === '/index.html'
    )
  ) {
    const file =
      path.join(
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
      fs.readFileSync(
        file,
        'utf8'
      ),
      'text/html; charset=utf-8'
    );
  }


  /* =========================
     CS2 CATALOG
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/api/cs2/catalog'
  ) {
    try {
      const catalog =
        await getCatalog();

      return sendJSON(
        res,
        200,
        {
          ok: true,
          count: catalog.length,
          items: catalog
        }
      );
    } catch (e) {
      console.error(
        '[CS2 ERROR]',
        e.message
      );

      return sendJSON(
        res,
        500,
        {
          ok: false,
          error: e.message
        }
      );
    }
  }


  /* =========================
     SCHEMA
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/api/cs2/schema'
  ) {
    try {
      const response =
        await cs2Request(
          '/v1/schema'
        );

      return sendText(
        res,
        200,
        response.body,
        'application/json; charset=utf-8'
      );
    } catch (e) {
      return sendJSON(
        res,
        500,
        {
          ok: false,
          error: e.message
        }
      );
    }
  }


  /* =========================
     PRICES
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/api/prices'
  ) {
    try {
      const response =
        await cs2Request(
          '/v1/prices/latest'
        );

      return sendText(
        res,
        200,
        response.body,
        'application/json; charset=utf-8'
      );
    } catch (e) {
      return sendJSON(
        res,
        500,
        {
          ok: false,
          error: e.message
        }
      );
    }
  }


  /* =====================================================
     CURRENT USER
     
     ВАЖНО:
     HTML ожидает steamUser.steamid,
     а не только steamUser.user.steamid.
  ===================================================== */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/api/current-user'
  ) {
    const raw =
      getCookie(
        req,
        'zenodrop_session'
      );

    const user =
      readSessionCookie(raw);

    if (!user) {
      return sendJSON(
        res,
        200,
        {
          authenticated: false,
          steamid: null,
          username: null,
          avatar: null,
          user: null
        }
      );
    }

    return sendJSON(
      res,
      200,
      {
        authenticated: true,

        // Совместимость с текущим HTML
        steamid:
          user.steamid,

        username:
          user.name ||
          user.username ||
          `Steam ${user.steamid}`,

        avatar:
          user.avatar || '',

        // Полный объект пользователя
        user
      }
    );
  }


  /* =========================
     STEAM LOGIN
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/auth/steam'
  ) {
    console.log(
      '[STEAM] Redirect:',
      STEAM_CALLBACK
    );

    res.writeHead(
      302,
      {
        Location:
          getSteamLoginURL()
      }
    );

    return res.end();
  }


  /* =========================
     STEAM CALLBACK
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/auth/steam/callback'
  ) {
    try {
      console.log(
        '[STEAM] Callback received'
      );

      const steamId =
        await verifySteam(url);

      console.log(
        '[STEAM] Verified:',
        steamId
      );

      const player =
        await getSteamUser(
          steamId
        );

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

      const session =
        createSessionCookie(user);

      /*
        ВАЖНО:
        Cookie ставится на весь Render-домен.
      */

      res.writeHead(
        302,
        {
          Location:
            SITE_URL + '/',

          'Set-Cookie':
            `zenodrop_session=${encodeURIComponent(
              session
            )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
        }
      );

      console.log(
        '[STEAM] Session created for:',
        steamId
      );

      return res.end();

    } catch (e) {
      console.error(
        '[STEAM LOGIN ERROR]',
        e
      );

      return sendText(
        res,
        500,
        'Ошибка Steam авторизации: ' +
        e.message
      );
    }
  }


  /* =========================
     LOGOUT
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/auth/logout'
  ) {
    res.writeHead(
      302,
      {
        Location:
          SITE_URL + '/',

        'Set-Cookie':
          'zenodrop_session=; ' +
          'Path=/; Max-Age=0; ' +
          'HttpOnly; Secure; SameSite=Lax'
      }
    );

    return res.end();
  }


  /* =========================
     USD/RUB
  ========================= */

  if (
    req.method === 'GET' &&
    url.pathname ===
      '/api/usd-rub'
  ) {
    try {
      const response =
        await request(
          'https://open.er-api.com/v6/latest/USD',
          {
            timeout: 15000,

            headers: {
              Accept:
                'application/json',

              'Accept-Encoding':
                'gzip'
            }
          }
        );

      const data =
        JSON.parse(
          response.body
        );

      const rate =
        Number(
          data?.rates?.RUB
        );

      if (
        !Number.isFinite(rate) ||
        rate <= 0
      ) {
        throw new Error(
          'Курс RUB не получен'
        );
      }

      /*
        HTML сейчас читает d.rate,
        поэтому отдаём оба варианта.
      */

      return sendJSON(
        res,
        200,
        {
          ok: true,
          rate,
          usd_rub: rate
        }
      );

    } catch {
      return sendJSON(
        res,
        200,
        {
          ok: false,
          rate: 80,
          usd_rub: 80
        }
      );
    }
  }


  return sendJSON(
    res,
    404,
    {
      ok: false,
      error: 'Not found'
    }
  );
}


/* =========================================================
   START
========================================================= */

const server =
  http.createServer(
    (req, res) => {
      handle(req, res)
        .catch(error => {
          console.error(
            '[SERVER ERROR]',
            error
          );

          if (!res.headersSent) {
            sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  error.message
              }
            );
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
      '======================================'
    );

    console.log(
      'ZENODROP SERVER STARTED'
    );

    console.log(
      'PORT:',
      PORT
    );

    console.log(
      'SITE:',
      SITE_URL
    );

    console.log(
      'STEAM CALLBACK:',
      STEAM_CALLBACK
    );

    console.log(
      'CS2 KEY:',
      CS2SH_API_KEY
        ? 'FOUND'
        : 'NOT FOUND'
    );

    console.log(
      'STEAM KEY:',
      STEAM_API_KEY
        ? 'FOUND'
        : 'NOT FOUND'
    );

    console.log(
      '======================================'
    );

    setTimeout(() => {
      getCatalog()
        .then(() => {
          console.log(
            '[CS2] Предзагрузка завершена'
          );
        })
        .catch(e => {
          console.error(
            '[CS2] Ошибка предзагрузки:',
            e.message
          );
        });
    }, 1000);
  }
);
