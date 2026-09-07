const http = require("http");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = process.env.PORT || 8787;

const CS2SH_API_KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ""
).trim();

const STEAM_API_KEY = (process.env.STEAM_API_KEY || "").trim();
const STEAM_RETURN_URL = (
  process.env.STEAM_RETURN_URL ||
  ""
).trim();

const SESSION_COOKIE = "zenodrop_session";

let cs2CatalogCache = null;
let cs2CatalogCacheTime = 0;
let cs2CatalogBuildPromise = null;

const CS2_CACHE_MS = 5 * 60 * 1000;

const sessions = new Map();

function send(res, status, data, headers = {}) {
  const body =
    typeof data === "string"
      ? data
      : JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      typeof data === "string"
        ? "text/html; charset=utf-8"
        : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });

  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });
  res.end();
}

function parseCookies(req) {
  const result = {};

  const cookie = req.headers.cookie || "";

  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    result[key] = decodeURIComponent(value);
  }

  return result;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];

  if (!sid) return null;

  return sessions.get(sid) || null;
}

function createSession(user) {
  const sid = crypto.randomBytes(32).toString("hex");

  sessions.set(sid, {
    user,
    createdAt: Date.now()
  });

  return sid;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];

  if (sid) {
    sessions.delete(sid);
  }
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeout || 30000);

    const req = https.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          ...(options.headers || {})
        },
        signal: controller.signal
      },
      response => {
        const chunks = [];

        response.on("data", chunk => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          clearTimeout(timeout);

          let body = Buffer.concat(chunks);

          const encoding = String(
            response.headers["content-encoding"] || ""
          ).toLowerCase();

          try {
            if (encoding.includes("gzip")) {
              body = zlib.gunzipSync(body);
            } else if (encoding.includes("br")) {
              body = zlib.brotliDecompressSync(body);
            } else if (encoding.includes("deflate")) {
              body = zlib.inflateSync(body);
            }
          } catch (e) {
            return reject(
              new Error(
                "Ошибка распаковки ответа: " + e.message
              )
            );
          }

          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body
          });
        });
      }
    );

    req.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function cs2Get(path) {
  if (!CS2SH_API_KEY) {
    throw new Error(
      "CS2SH_API_KEY не задан на Render"
    );
  }

  const response = await requestBuffer(
    "https://api.cs2.sh" + path,
    {
      method: "GET",
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${CS2SH_API_KEY}`,
        Accept: "application/json",
        "Accept-Encoding": "gzip"
      }
    }
  );

  const text = response.body.toString("utf8");

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `cs2.sh GET ${path}: HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `cs2.sh вернул не JSON: ${text.slice(0, 500)}`
    );
  }
}

async function cs2Post(path, data) {
  if (!CS2SH_API_KEY) {
    throw new Error(
      "CS2SH_API_KEY не задан на Render"
    );
  }

  const body = JSON.stringify(data);

  const response = await requestBuffer(
    "https://api.cs2.sh" + path,
    {
      method: "POST",
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${CS2SH_API_KEY}`,
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      body
    }
  );

  const text = response.body.toString("utf8");

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `cs2.sh POST ${path}: HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `cs2.sh вернул не JSON: ${text.slice(0, 500)}`
    );
  }
}

function extractSchemaItems(schema) {
  if (!schema) return [];

  if (Array.isArray(schema)) {
    return schema;
  }

  if (Array.isArray(schema.items)) {
    return schema.items;
  }

  if (schema.data && Array.isArray(schema.data)) {
    return schema.data;
  }

  if (
    schema.data &&
    typeof schema.data === "object"
  ) {
    return Object.entries(schema.data).map(
      ([name, item]) => ({
        market_hash_name: name,
        ...item
      })
    );
  }

  if (typeof schema === "object") {
    return Object.entries(schema)
      .filter(
        ([key, value]) =>
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
      )
      .map(([name, item]) => ({
        market_hash_name: name,
        ...item
      }));
  }

  return [];
}

function extractPriceObject(data, name) {
  if (!data) return null;

  if (data[name]) {
    return data[name];
  }

  if (data.items && data.items[name]) {
    return data.items[name];
  }

  if (data.data && data.data[name]) {
    return data.data[name];
  }

  if (Array.isArray(data)) {
    return data.find(
      item =>
        item &&
        (
          item.market_hash_name === name ||
          item.name === name
        )
    );
  }

  if (Array.isArray(data.items)) {
    return data.items.find(
      item =>
        item &&
        (
          item.market_hash_name === name ||
          item.name === name
        )
    );
  }

  if (Array.isArray(data.data)) {
    return data.data.find(
      item =>
        item &&
        (
          item.market_hash_name === name ||
          item.name === name
        )
    );
  }

  return null;
}

function getNumericPrice(value) {
  if (typeof value === "number" && value > 0) {
    return value;
  }

  if (
    typeof value === "string" &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
  ) {
    return Number(value);
  }

  return 0;
}

function getUsdPrice(price) {
  if (!price) return 0;

  const sources = [
    price.steam,
    price.csfloat,
    price.buff,
    price.youpin,
    price.skinport,
    price.c5game
  ];

  for (const source of sources) {
    if (!source) continue;

    const ask =
      getNumericPrice(source.ask) ||
      getNumericPrice(source.price) ||
      getNumericPrice(source.value);

    if (ask > 0) {
      return ask;
    }
  }

  if (price.ask) {
    return getNumericPrice(price.ask);
  }

  if (price.price) {
    return getNumericPrice(price.price);
  }

  return 0;
}

function getImage(item) {
  return (
    item.image ||
    item.img ||
    item.icon ||
    item.image_url ||
    item.icon_url ||
    ""
  );
}

async function buildCs2Catalog() {
  console.log("[CS2] Загрузка schema...");

  const schema = await cs2Get("/v1/schema");

  const rawItems = extractSchemaItems(schema);

  console.log(
    `[CS2] Получено предметов schema: ${rawItems.length}`
  );

  const selected = rawItems
    .map(item => ({
      name:
        item.market_hash_name ||
        item.name ||
        "",
      image: getImage(item),
      rarity:
        item.rarity ||
        item.quality ||
        "",
      category:
        item.category ||
        "",
      weapon:
        item.weapon ||
        "",
      type:
        item.type ||
        ""
    }))
    .filter(item => item.name);

  /*
   * Не грузим десятки тысяч предметов.
   * Для Zenodrop достаточно большого каталога.
   */
  const limited = selected.slice(0, 1800);

  console.log(
    `[CS2] Будет проверено цен: ${limited.length}`
  );

  const batches = [];

  for (let i = 0; i < limited.length; i += 100) {
    batches.push(
      limited.slice(i, i + 100)
    );
  }

  const results = new Array(batches.length);

  let nextBatch = 0;

  async function worker(workerId) {
    while (true) {
      const index = nextBatch++;

      if (index >= batches.length) {
        return;
      }

      const batch = batches[index];

      console.log(
        `[CS2] Worker ${workerId}: batch ${
          index + 1
        }/${batches.length}`
      );

      try {
        const names = batch.map(
          item => item.name
        );

        const prices = await cs2Post(
          "/v1/prices/latest",
          names
        );

        results[index] = prices;
      } catch (error) {
        console.error(
          `[CS2] Ошибка batch ${index + 1}:`,
          error.message
        );

        results[index] = null;
      }
    }
  }

  const workers = Math.min(
    4,
    Math.max(1, batches.length)
  );

  await Promise.all(
    Array.from(
      { length: workers },
      (_, i) => worker(i + 1)
    )
  );

  const catalog = [];

  for (let i = 0; i < limited.length; i++) {
    const item = limited[i];

    const priceData = results.find(
      data =>
        data &&
        extractPriceObject(
          data,
          item.name
        )
    );

    const price = extractPriceObject(
      priceData,
      item.name
    );

    const usd = getUsdPrice(price);

    if (!usd || usd <= 0) {
      continue;
    }

    catalog.push({
      id: item.name,
      name: item.name,
      usd: Number(usd.toFixed(2)),
      img: item.image,
      rarity: item.rarity,
      category: item.category,
      weapon: item.weapon,
      type: item.type
    });
  }

  catalog.sort(
    (a, b) => b.usd - a.usd
  );

  const finalCatalog = catalog.slice(
    0,
    1500
  );

  console.log(
    `[CS2] Готово. Предметов с ценой: ${finalCatalog.length}`
  );

  return {
    updatedAt: Date.now(),
    items: finalCatalog
  };
}

async function getCs2Catalog() {
  const now = Date.now();

  if (
    cs2CatalogCache &&
    now - cs2CatalogCacheTime <
      CS2_CACHE_MS
  ) {
    return cs2CatalogCache;
  }

  if (cs2CatalogBuildPromise) {
    return cs2CatalogBuildPromise;
  }

  cs2CatalogBuildPromise =
    buildCs2Catalog()
      .then(catalog => {
        cs2CatalogCache = catalog;
        cs2CatalogCacheTime = Date.now();

        return catalog;
      })
      .finally(() => {
        cs2CatalogBuildPromise = null;
      });

  return cs2CatalogBuildPromise;
}

async function steamGetPlayer(steamId) {
  if (!STEAM_API_KEY) {
    return {
      steamid: steamId
    };
  }

  const url =
    "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/" +
    `?key=${encodeURIComponent(STEAM_API_KEY)}` +
    `&steamids=${encodeURIComponent(steamId)}`;

  const response = await requestBuffer(
    url,
    {
      method: "GET",
      timeout: 15000,
      headers: {
        Accept: "application/json"
      }
    }
  );

  const text =
    response.body.toString("utf8");

  try {
    const json = JSON.parse(text);

    return (
      json &&
      json.response &&
      json.response.players &&
      json.response.players[0]
    ) || {
      steamid: steamId
    };
  } catch {
    return {
      steamid: steamId
    };
  }
}

function getSteamIdFromOpenId(url) {
  const claimed =
    url.searchParams.get(
      "openid.claimed_id"
    );

  if (!claimed) return null;

  const match =
    claimed.match(
      /\/id\/(\d+)$/
    );

  return match
    ? match[1]
    : null;
}

function steamLoginUrl(req) {
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  const proto =
    req.headers["x-forwarded-proto"] ||
    "https";

  const returnUrl =
    STEAM_RETURN_URL ||
    `${proto}://${host}/auth/steam/callback`;

  const params =
    new URLSearchParams();

  params.set(
    "openid.ns",
    "http://specs.openid.net/auth/2.0"
  );

  params.set(
    "openid.mode",
    "checkid_setup"
  );

  params.set(
    "openid.return_to",
    returnUrl
  );

  params.set(
    "openid.realm",
    `${proto}://${host}/`
  );

  params.set(
    "openid.identity",
    "http://specs.openid.net/auth/2.0/identifier_select"
  );

  params.set(
    "openid.claimed_id",
    "http://specs.openid.net/auth/2.0/identifier_select"
  );

  return (
    "https://steamcommunity.com/openid/login?" +
    params.toString()
  );
}

async function handleSteamCallback(req, res) {
  const currentUrl =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );

  const steamId =
    getSteamIdFromOpenId(
      currentUrl
    );

  if (!steamId) {
    return send(
      res,
      400,
      {
        ok: false,
        error: "Steam ID не найден"
      }
    );
  }

  const user =
    await steamGetPlayer(
      steamId
    );

  const sid =
    createSession({
      steamid: steamId,
      personaname:
        user.personaname ||
        `Steam ${steamId}`,
      avatar:
        user.avatarfull ||
        user.avatarmedium ||
        user.avatar ||
        "",
      profileurl:
        user.profileurl ||
        `https://steamcommunity.com/profiles/${steamId}`
    });

  redirect(
    res,
    "/?steam_login=success",
  );

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(
      sid
    )}; Path=/; HttpOnly; SameSite=Lax; Secure`
  );
}

async function handleApi(req, res, url) {
  if (
    url.pathname ===
    "/api/current-user"
  ) {
    const session =
      getSession(req);

    if (!session) {
      return send(res, 200, {
        loggedIn: false,
        user: null
      });
    }

    return send(res, 200, {
      loggedIn: true,
      user: session.user
    });
  }

  if (
    url.pathname ===
    "/auth/logout"
  ) {
    destroySession(req);

    return send(
      res,
      200,
      {
        ok: true
      },
      {
        "Set-Cookie":
          `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
      }
    );
  }

  if (
    url.pathname ===
    "/auth/steam"
  ) {
    return redirect(
      res,
      steamLoginUrl(req)
    );
  }

  if (
    url.pathname ===
    "/api/usd-rub"
  ) {
    try {
      const response =
        await fetch(
          "https://open.er-api.com/v6/latest/USD"
        );

      const data =
        await response.json();

      const rate =
        Number(
          data &&
          data.rates &&
          data.rates.RUB
        );

      if (!rate) {
        throw new Error(
          "USD/RUB rate отсутствует"
        );
      }

      return send(res, 200, {
        ok: true,
        rate
      });
    } catch (error) {
      return send(
        res,
        500,
        {
          ok: false,
          error: error.message
        }
      );
    }
  }

  if (
    url.pathname ===
    "/api/cs2/catalog"
  ) {
    try {
      const catalog =
        await getCs2Catalog();

      return send(
        res,
        200,
        catalog,
        {
          "Cache-Control":
            "public, max-age=60"
        }
      );
    } catch (error) {
      console.error(
        "[CS2 CATALOG]",
        error
      );

      return send(
        res,
        500,
        {
          ok: false,
          error: error.message
        }
      );
    }
  }

  if (
    url.pathname ===
    "/api/cs2/schema"
  ) {
    try {
      const schema =
        await cs2Get(
          "/v1/schema"
        );

      return send(
        res,
        200,
        schema
      );
    } catch (error) {
      return send(
        res,
        500,
        {
          ok: false,
          error: error.message
        }
      );
    }
  }

  if (
    url.pathname ===
    "/api/prices"
  ) {
    try {
      const namesParam =
        url.searchParams.get(
          "names"
        );

      if (!namesParam) {
        return send(
          res,
          400,
          {
            ok: false,
            error:
              "Не переданы names"
          }
        );
      }

      const names =
        namesParam
          .split(",")
          .map(x => x.trim())
          .filter(Boolean)
          .slice(0, 100);

      const data =
        await cs2Post(
          "/v1/prices/latest",
          names
        );

      return send(
        res,
        200,
        data
      );
    } catch (error) {
      return send(
        res,
        500,
        {
          ok: false,
          error: error.message
        }
      );
    }
  }

  return send(
    res,
    404,
    {
      ok: false,
      error: "API route not found"
    }
  );
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        if (
          url.pathname ===
          "/auth/steam/callback"
        ) {
          return await handleSteamCallback(
            req,
            res
          );
        }

        if (
          url.pathname.startsWith(
            "/api/"
          ) ||
          url.pathname.startsWith(
            "/auth/"
          )
        ) {
          return await handleApi(
            req,
            res,
            url
          );
        }

        if (
          url.pathname === "/" ||
          url.pathname.endsWith(".html")
        ) {
          const fs =
            require("fs");
          const path =
            require("path");

          const file =
            path.join(
              __dirname,
              "Zenodrop_CS2SH_400.html"
            );

          if (
            fs.existsSync(file)
          ) {
            return send(
              res,
              200,
              fs.readFileSync(
                file,
                "utf8"
              ),
              {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            );
          }
        }

        send(
          res,
          404,
          "Not Found"
        );
      } catch (error) {
        console.error(
          "[SERVER ERROR]",
          error
        );

        if (!res.headersSent) {
          send(
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
      }
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Zenodrop server started on port ${PORT}`
    );

    console.log(
      "CS2SH API key:",
      CS2SH_API_KEY
        ? "SET"
        : "NOT SET"
    );

    console.log(
      "Steam API key:",
      STEAM_API_KEY
        ? "SET"
        : "NOT SET"
    );
  }
);
