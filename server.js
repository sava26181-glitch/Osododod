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

let catalogCache = null;
let catalogCacheTime = 0;
let catalogPromise = null;

const CATALOG_CACHE_TIME = 10 * 60 * 1000;

const sessions = new Map();

/* =========================
   RESPONSE
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

    ...headers
  });

  res.end(body);
}

function redirect(res, location, cookie) {
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
   COOKIES
========================= */

function parseCookies(req) {
  const result = {};

  const cookie = req.headers.cookie || "";

  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part
      .slice(0, index)
      .trim();

    const value = part
      .slice(index + 1)
      .trim();

    result[key] =
      decodeURIComponent(value);
  }

  return result;
}

function getSession(req) {
  const cookies =
    parseCookies(req);

  const id =
    cookies[SESSION_COOKIE];

  if (!id) return null;

  return sessions.get(id) || null;
}

function createSession(user) {
  const id =
    crypto.randomBytes(32).toString("hex");

  sessions.set(id, {
    user,
    createdAt: Date.now()
  });

  return id;
}

function destroySession(req) {
  const cookies =
    parseCookies(req);

  const id =
    cookies[SESSION_COOKIE];

  if (id) {
    sessions.delete(id);
  }
}

/* =========================
   HTTPS
========================= */

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, options.timeout || 30000);

    const request = https.request(
      url,
      {
        method:
          options.method || "GET",

        headers:
          options.headers || {},

        signal: controller.signal
      },
      response => {
        const chunks = [];

        response.on(
          "data",
          chunk => chunks.push(chunk)
        );

        response.on(
          "end",
          () => {
            clearTimeout(timeout);

            let buffer =
              Buffer.concat(chunks);

            const encoding =
              String(
                response.headers[
                  "content-encoding"
                ] || ""
              ).toLowerCase();

            try {
              if (
                encoding.includes("gzip")
              ) {
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
          }
        );
      }
    );

    request.on(
      "error",
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );

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
    requestBody =
      JSON.stringify(body);

    headers["Content-Type"] =
      "application/json";

    headers["Content-Length"] =
      Buffer.byteLength(
        requestBody
      );
  }

  const response =
    await httpsRequest(
      "https://api.cs2.sh" +
        endpoint,
      {
        method,
        headers,
        body: requestBody,
        timeout: 60000
      }
    );

  const text =
    response.body.toString(
      "utf8"
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    throw new Error(
      `cs2.sh ${method} ${endpoint}: HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  return JSON.parse(text);
}

/* =========================
   PRICE
========================= */

function getPrice(item) {
  if (!item) return 0;

  const sources = [
    "steam",
    "csfloat",
    "buff",
    "youpin",
    "skinport",
    "c5game"
  ];

  for (const source of sources) {
    const data = item[source];

    if (!data) continue;

    const ask =
      Number(data.ask);

    if (
      Number.isFinite(ask) &&
      ask > 0
    ) {
      return ask;
    }
  }

  return 0;
}

/* =========================
   FAST CATALOG
========================= */

async function buildCatalog() {
  console.log(
    "[CS2] Loading schema + prices..."
  );

  const [schema, prices] =
    await Promise.all([
      cs2Request(
        "/v1/schema"
      ),

      cs2Request(
        "/v1/prices/latest"
      )
    ]);

  const schemaItems =
    schema?.items || {};

  const priceItems =
    prices?.items || {};

  console.log(
    `[CS2] Schema: ${
      Object.keys(schemaItems).length
    }`
  );

  console.log(
    `[CS2] Prices: ${
      Object.keys(priceItems).length
    }`
  );

  const catalog = [];

  for (
    const [name, item]
    of Object.entries(schemaItems)
  ) {
    if (!name) continue;

    /*
     * Только скины.
     * Это убирает контейнеры,
     * стикеры и прочий мусор.
     */

    if (
      item.category &&
      item.category !== "skin"
    ) {
      continue;
    }

    const price =
      priceItems[name];

    if (!price) continue;

    const usd =
      getPrice(price);

    if (
      !Number.isFinite(usd) ||
      usd <= 0
    ) {
      continue;
    }

    const img =
      item.image ||
      item.steam_image ||
      "";

    if (!img) continue;

    catalog.push({
      id: name,

      name: name,

      usd: Number(
        usd.toFixed(2)
      ),

      img: img,

      category:
        item.category || "skin",

      rarity:
        item.rarity || null
    });
  }

  /*
   * Дорогие/ликвидные предметы
   * идут первыми.
   */

  catalog.sort(
    (a, b) =>
      b.usd - a.usd
  );

  /*
   * Большой каталог,
   * но не грузим браузеру
   * десятки тысяч объектов.
   */

  const result = {
    ok: true,

    updatedAt: Date.now(),

    items:
      catalog.slice(0, 2500)
  };

  console.log(
    `[CS2] Catalog ready: ${
      result.items.length
    }`
  );

  return result;
}

/* =========================
   CACHE
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

  if (catalogPromise) {
    return catalogPromise;
  }

  catalogPromise =
    buildCatalog()
      .then(result => {
        catalogCache =
          result;

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

function getSteamLoginUrl(req) {
  const host =
    req.headers[
      "x-forwarded-host"
    ] ||
    req.headers.host;

  const protocol =
    req.headers[
      "x-forwarded-proto"
    ] ||
    "https";

  const returnUrl =
    STEAM_RETURN_URL ||
    `${protocol}://${host}/auth/steam/return`;

  const realm =
    `${protocol}://${host}`;

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
    realm
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

async function steamReturn(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );

  try {
    /*
     * Проверяем OpenID у Steam.
     */

    const verify =
      new URLSearchParams();

    verify.set(
      "openid.ns",
      "http://specs.openid.net/auth/2.0"
    );

    verify.set(
      "openid.mode",
      "check_authentication"
    );

    for (
      const [key, value]
      of url.searchParams
    ) {
      if (
        key !== "openid.mode"
      ) {
        verify.append(
          key,
          value
        );
      }
    }

    const verification =
      await fetch(
        "https://steamcommunity.com/openid/login",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            verify.toString()
        }
      );

    const text =
      await verification.text();

    if (
      !text.includes(
        "is_valid:true"
      )
    ) {
      console.error(
        "[STEAM] Invalid OpenID:",
        text
      );

      return redirect(
        res,
        "/?steam_error=invalid"
      );
    }

    /*
     * Получаем SteamID.
     */

    const claimed =
      url.searchParams.get(
        "openid.claimed_id"
      );

    const match =
      claimed &&
      claimed.match(
        /\/id\/([0-9]{17})/
      );

    const steamId =
      match
        ? match[1]
        : null;

    if (!steamId) {
      return redirect(
        res,
        "/?steam_error=no_steamid"
      );
    }

    /*
     * Получаем профиль.
     */

    let player = {};

    if (STEAM_API_KEY) {
      try {
        const playerResponse =
          await fetch(
            "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/" +
            `?key=${encodeURIComponent(
              STEAM_API_KEY
            )}` +
            `&steamids=${steamId}`
          );

        const data =
          await playerResponse.json();

        player =
          data?.response?.players?.[0] ||
          {};
      } catch (error) {
        console.error(
          "[STEAM PROFILE]",
          error.message
        );
      }
    }

    const user = {
      steamid: steamId,

      username:
        player.personaname ||
        "Steam User",

      avatar:
        player.avatarfull ||
        player.avatarmedium ||
        player.avatar ||
        "",

      profileurl:
        player.profileurl ||
        `https://steamcommunity.com/profiles/${steamId}`
    };

    /*
     * Создаём сессию.
     */

    const sessionId =
      createSession(user);

    const cookie =
      `${SESSION_COOKIE}=${encodeURIComponent(
        sessionId
      )}; Path=/; HttpOnly; SameSite=Lax; Secure`;

    console.log(
      `[STEAM] Login OK: ${steamId}`
    );

    return redirect(
      res,
      "/?steam_login=success",
      cookie
    );
  } catch (error) {
    console.error(
      "[STEAM ERROR]",
      error
    );

    return redirect(
      res,
      "/?steam_error=server"
    );
  }
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
   *
   * ВАЖНО:
   * здесь одновременно отдаём
   * steamid на верхнем уровне
   * и user внутри.
   *
   * Это совместимо с текущим HTML.
   */

  if (
    url.pathname ===
    "/api/current-user"
  ) {
    const session =
      getSession(req);

    if (
      !session ||
      !session.user
    ) {
      return send(
        res,
        200,
        {
          loggedIn: false,

          steamid: null,

          username: null,

          avatar: null,

          user: null
        }
      );
    }

    return send(
      res,
      200,
      {
        loggedIn: true,

        steamid:
          session.user.steamid,

        username:
          session.user.username,

        avatar:
          session.user.avatar,

        user:
          session.user
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
   * CS2 CATALOG
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
        "[CS2 CATALOG ERROR]",
        error
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
   * USD/RUB
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
          data?.rates?.RUB
        );

      return send(
        res,
        200,
        {
          ok: true,

          rate:
            rate > 0
              ? rate
              : 80
        }
      );
    } catch {
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
   * SCHEMA
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
   * SPECIFIC PRICES
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
          "/auth/steam/return"
        ) {
          return await steamReturn(
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

        res.end();
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
