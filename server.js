const http = require("http");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;

const CS2SH_API_KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ""
).trim();

const STEAM_API_KEY = (
  process.env.STEAM_API_KEY || ""
).trim();

const STEAM_RETURN_URL = (
  process.env.STEAM_RETURN_URL || ""
).trim();

const SESSION_COOKIE = "zenodrop_session";

/* =========================
   CACHE
========================= */

let catalogCache = null;
let catalogCacheTime = 0;

let catalogPromise = null;

const CATALOG_CACHE_TIME = 10 * 60 * 1000;

/* =========================
   BASIC SERVER
========================= */

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

function redirect(res, location, cookie = null) {
  const headers = {
    Location: location,
    "Cache-Control": "no-store"
  };

  if (cookie) {
    headers["Set-Cookie"] = cookie;
  }

  res.writeHead(302, headers);
  res.end();
}

/* =========================
   COOKIES / SESSIONS
========================= */

const sessions = new Map();

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

  if (!cookies[SESSION_COOKIE]) {
    return null;
  }

  return sessions.get(
    cookies[SESSION_COOKIE]
  ) || null;
}

function createSession(user) {
  const id = crypto
    .randomBytes(32)
    .toString("hex");

  sessions.set(id, {
    user,
    createdAt: Date.now()
  });

  return id;
}

function destroySession(req) {
  const cookies = parseCookies(req);

  if (cookies[SESSION_COOKIE]) {
    sessions.delete(
      cookies[SESSION_COOKIE]
    );
  }
}

/* =========================
   HTTPS REQUEST
========================= */

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeout || 30000);

    const request = https.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        signal: controller.signal
      },
      response => {
        const chunks = [];

        response.on("data", chunk => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          clearTimeout(timeout);

          let buffer = Buffer.concat(chunks);

          const encoding = String(
            response.headers[
              "content-encoding"
            ] || ""
          ).toLowerCase();

          try {
            if (encoding.includes("gzip")) {
              buffer =
                zlib.gunzipSync(buffer);
            } else if (
              encoding.includes("br")
            ) {
              buffer =
                zlib.brotliDecompressSync(
                  buffer
                );
            } else if (
              encoding.includes("deflate")
            ) {
              buffer =
                zlib.inflateSync(buffer);
            }
          } catch (error) {
            return reject(error);
          }

          resolve({
            status:
              response.statusCode || 0,

            headers:
              response.headers,

            body: buffer
          });
        });
      }
    );

    request.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

/* =========================
   CS2.SH
========================= */

async function cs2Request(
  endpoint,
  method = "GET",
  body = null
) {
  if (!CS2SH_API_KEY) {
    throw new Error(
      "CS2SH_API_KEY не задан на Render"
    );
  }

  const headers = {
    Authorization:
      `Bearer ${CS2SH_API_KEY}`,

    Accept:
      "application/json",

    "Accept-Encoding":
      "gzip"
  };

  let requestBody = null;

  if (body !== null) {
    requestBody = JSON.stringify(body);

    headers["Content-Type"] =
      "application/json";

    headers["Content-Length"] =
      Buffer.byteLength(requestBody);
  }

  const response =
    await httpsRequest(
      "https://api.cs2.sh" + endpoint,
      {
        method,
        headers,
        body: requestBody,
        timeout: 45000
      }
    );

  const text =
    response.body.toString("utf8");

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    throw new Error(
      `cs2.sh ${method} ${endpoint}: HTTP ${response.status} ${text.slice(
        0,
        400
      )}`
    );
  }

  return JSON.parse(text);
}

/* =========================
   BUILD FAST CATALOG
========================= */

async function buildCatalog() {
  console.log(
    "[CS2] Начинаю быструю загрузку..."
  );

  /*
   * Делаем ДВА запроса параллельно:
   *
   * 1. schema
   * 2. latest prices
   *
   * Это намного быстрее, чем десятки POST-запросов.
   */

  const [schema, prices] =
    await Promise.all([
      cs2Request(
        "/v1/schema",
        "GET"
      ),

      cs2Request(
        "/v1/prices/latest",
        "GET"
      )
    ]);

  const schemaItems =
    schema &&
    schema.items &&
    typeof schema.items === "object"
      ? schema.items
      : {};

  const priceItems =
    prices &&
    prices.items &&
    typeof prices.items === "object"
      ? prices.items
      : {};

  console.log(
    `[CS2] Schema: ${Object.keys(schemaItems).length}`
  );

  console.log(
    `[CS2] Prices: ${Object.keys(priceItems).length}`
  );

  const catalog = [];

  /*
   * Берём только обычные скины.
   * Это сильно уменьшает каталог и ускоряет сайт.
   */

  for (
    const [name, item] of Object.entries(
      schemaItems
    )
  ) {
    if (!name) continue;

    const price =
      priceItems[name];

    if (!price) continue;

    let usd = 0;

    const sources = [
      "steam",
      "csfloat",
      "buff",
      "youpin",
      "skinport",
      "c5game"
    ];

    for (const source of sources) {
      const data =
        price[source];

      if (!data) continue;

      const ask =
        Number(data.ask);

      if (
        Number.isFinite(ask) &&
        ask > 0
      ) {
        usd = ask;
        break;
      }
    }

    if (
      !Number.isFinite(usd) ||
      usd <= 0
    ) {
      continue;
    }

    const image =
      item.image ||
      item.steam_image ||
      "";

    if (!image) continue;

    catalog.push({
      id: name,

      name,

      usd: Number(
        usd.toFixed(2)
      ),

      img: image,

      category:
        item.category || "",

      rarity:
        item.rarity || null
    });

    /*
     * Сайт не нуждается в 40-50 тысячах предметов.
     * Оставляем большой каталог из 2500.
     */

    if (catalog.length >= 2500) {
      break;
    }
  }

  /*
   * Сначала дорогие/ликвидные предметы.
   */

  catalog.sort(
    (a, b) =>
      b.usd - a.usd
  );

  const result = {
    ok: true,

    updatedAt: Date.now(),

    items: catalog
  };

  console.log(
    `[CS2] Каталог готов: ${catalog.length}`
  );

  return result;
}

/* =========================
   CATALOG CACHE
========================= */

async function getCatalog() {
  const now = Date.now();

  if (
    catalogCache &&
    now - catalogCacheTime <
      CATALOG_CACHE_TIME
  ) {
    return catalogCache;
  }

  /*
   * Если загрузка уже идёт,
   * второй запрос её не запускает.
   */

  if (catalogPromise) {
    return catalogPromise;
  }

  catalogPromise =
    buildCatalog()
      .then(result => {
        catalogCache = result;

        catalogCacheTime =
          Date.now();

        return result;
      })
      .finally(() => {
        catalogPromise = null;
      });

  return catalogPromise;
}

/* =========================
   STEAM
========================= */

async function getSteamUser(
  steamId
) {
  if (!STEAM_API_KEY) {
    return {
      steamid: steamId
    };
  }

  const url =
    "https://api.steampowered.com/" +
    "ISteamUser/GetPlayerSummaries/v2/" +
    `?key=${encodeURIComponent(
      STEAM_API_KEY
    )}` +
    `&steamids=${encodeURIComponent(
      steamId
    )}`;

  try {
    const response =
      await httpsRequest(
        url,
        {
          timeout: 15000,
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    const json =
      JSON.parse(
        response.body.toString(
          "utf8"
        )
      );

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

function getSteamId(url) {
  const claimed =
    url.searchParams.get(
      "openid.claimed_id"
    );

  if (!claimed) {
    return null;
  }

  const match =
    claimed.match(
      /\/id\/(\d+)$/
    );

  return match
    ? match[1]
    : null;
}

function getSteamLoginUrl(req) {
  const host =
    req.headers[
      "x-forwarded-host"
    ] ||
    req.headers.host;

  const protocol =
    req.headers[
      "x-forwarded-proto"
    ] || "https";

  const returnUrl =
    STEAM_RETURN_URL ||
    `${protocol}://${host}/auth/steam/callback`;

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
    `${protocol}://${host}/`
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

/* =========================
   API
========================= */

async function handleApi(
  req,
  res,
  url
) {
  /*
   * CURRENT USER
   */

  if (
    url.pathname ===
    "/api/current-user"
  ) {
    const session =
      getSession(req);

    if (!session) {
      return send(
        res,
        200,
        {
          loggedIn: false,
          user: null
        }
      );
    }

    return send(
      res,
      200,
      {
        loggedIn: true,
        user: session.user
      }
    );
  }

  /*
   * LOGOUT
   */

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

  /*
   * STEAM LOGIN
   */

  if (
    url.pathname ===
    "/auth/steam"
  ) {
    return redirect(
      res,
      getSteamLoginUrl(req)
    );
  }

  /*
   * USD/RUB
   *
   * Не блокируем запуск сайта,
   * если курс временно недоступен.
   */

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
          "Курс RUB не найден"
        );
      }

      return send(
        res,
        200,
        {
          ok: true,
          rate
        }
      );
    } catch {
      /*
       * Примерный fallback.
       * Главное — не блокировать сайт.
       */

      return send(
        res,
        200,
        {
          ok: true,
          rate: 80
        }
      );
    }
  }

  /*
   * FAST CS2 CATALOG
   */

  if (
    url.pathname ===
    "/api/cs2/catalog"
  ) {
    try {
      const catalog =
        await getCatalog();

      return send(
        res,
        200,
        catalog,
        {
          "Cache-Control":
            "public, max-age=300"
        }
      );
    } catch (error) {
      console.error(
        "[CS2 ERROR]",
        error.message
      );

      return send(
        res,
        500,
        {
          ok: false,
          error:
            error.message
        }
      );
    }
  }

  /*
   * CS2 SCHEMA
   */

  if (
    url.pathname ===
    "/api/cs2/schema"
  ) {
    try {
      const schema =
        await cs2Request(
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
          error:
            error.message
        }
      );
    }
  }

  /*
   * MANUAL PRICE REQUEST
   */

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
              "names отсутствует"
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
        await cs2Request(
          "/v1/prices/latest",
          "POST",
          {
            items: names
          }
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
          error:
            error.message
        }
      );
    }
  }

  return send(
    res,
    404,
    {
      ok: false,
      error:
        "API route not found"
    }
  );
}

/* =========================
   STEAM CALLBACK
========================= */

async function steamCallback(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );

  const steamId =
    getSteamId(url);

  if (!steamId) {
    return send(
      res,
      400,
      {
        ok: false,
        error:
          "Steam ID не найден"
      }
    );
  }

  const player =
    await getSteamUser(
      steamId
    );

  const user = {
    steamid: steamId,

    personaname:
      player.personaname ||
      `Steam ${steamId}`,

    avatar:
      player.avatarfull ||
      player.avatarmedium ||
      player.avatar ||
      "",

    profileurl:
      player.profileurl ||
      `https://steamcommunity.com/profiles/${steamId}`
  };

  const sessionId =
    createSession(user);

  const cookie =
    `${SESSION_COOKIE}=${encodeURIComponent(
      sessionId
    )}; Path=/; HttpOnly; SameSite=Lax; Secure`;

  redirect(
    res,
    "/?steam_login=success",
    cookie
  );
}

/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        /*
         * STEAM CALLBACK
         */

        if (
          url.pathname ===
          "/auth/steam/callback"
        ) {
          return await steamCallback(
            req,
            res
          );
        }

        /*
         * API
         */

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

        /*
         * HTML
         */

        if (
          url.pathname === "/" ||
          url.pathname.endsWith(
            ".html"
          )
        ) {
          const file =
            path.join(
              __dirname,
              "Zenodrop_CS2SH_400.html"
            );

          if (
            fs.existsSync(file)
          ) {
            const html =
              fs.readFileSync(
                file,
                "utf8"
              );

            return send(
              res,
              200,
              html,
              {
                "Content-Type":
                  "text/html; charset=utf-8",

                "Cache-Control":
                  "no-cache"
              }
            );
          }
        }

        return send(
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
        }
      }
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Zenodrop started on ${PORT}`
    );

    console.log(
      "CS2SH:",
      CS2SH_API_KEY
        ? "OK"
        : "NO KEY"
    );

    console.log(
      "STEAM:",
      STEAM_API_KEY
        ? "OK"
        : "NO KEY"
    );
  }
);
