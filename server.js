const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;

const KEY = (
  process.env.CS2SH_API_KEY ||
  process.env.CS2_API_KEY ||
  process.env.CS2SH_KEY ||
  ""
).trim();

const STEAM_API_KEY = (
  process.env.STEAM_API_KEY || ""
).trim();

if (!KEY) {
  console.error("ERROR: CS2SH_API_KEY is not set");
  process.exit(1);
}

const HTML_FILE = path.join(
  __dirname,
  "Zenodrop_CS2SH_400.html"
);

const html = fs.readFileSync(
  HTML_FILE,
  "utf8"
);

const sessions = new Map();

let catalogCache = null;
let catalogCacheExpires = 0;
let catalogBuildPromise = null;

const CATALOG_CACHE_TIME =
  10 * 60 * 1000;

/* =========================
   CS2.SH
========================= */

async function cs2Fetch(url, options = {}) {
  const controller =
    new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 45000);

  try {
    const response = await fetch(url, {
      ...options,

      signal: controller.signal,

      headers: {
        Authorization:
          "Bearer " + KEY,

        Accept:
          "application/json",

        "Accept-Encoding":
          "gzip",

        ...(options.headers || {})
      }
    });

    const text =
      await response.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    if (!response.ok) {
      const error =
        new Error(
          data?.message ||
          data?.error ||
          `HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.body =
        data || text.slice(0, 1000);

      throw error;
    }

    return data;

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   BUILD CATALOG
========================= */

async function buildCs2Catalog() {
  console.log(
    "[CS2] Loading schema + prices..."
  );

  /*
   * ДВА запроса одновременно.
   */
  const [schema, prices] =
    await Promise.all([
      cs2Fetch(
        "https://api.cs2.sh/v1/schema"
      ),

      cs2Fetch(
        "https://api.cs2.sh/v1/prices/latest"
      )
    ]);

  const schemaItems =
    schema?.items || {};

  const priceItems =
    prices?.items || {};

  console.log(
    "[CS2] Schema:",
    Object.keys(schemaItems).length
  );

  console.log(
    "[CS2] Prices:",
    Object.keys(priceItems).length
  );

  const sources = [
    "steam",
    "csfloat",
    "buff",
    "youpin",
    "skinport",
    "c5game"
  ];

  const all = [];

  for (
    const [name, item]
    of Object.entries(schemaItems)
  ) {
    if (!name) continue;

    if (!item?.image) continue;

    /*
     * Берём именно игровые скины.
     */
    const category =
      String(
        item.category || ""
      ).toLowerCase();

    if (
      category &&
      ![
        "skin",
        "gloves",
        "knife",
        "weapon"
      ].some(x =>
        category.includes(x)
      ) &&
      !name.includes("|")
    ) {
      continue;
    }

    const price =
      priceItems[name];

    if (!price) continue;

    let usd = 0;

    for (
      const source
      of sources
    ) {
      const ask =
        Number(
          price?.[source]?.ask
        );

      if (
        Number.isFinite(ask) &&
        ask > 0
      ) {
        usd = ask;
        break;
      }
    }

    if (!(usd > 0)) continue;

    all.push({
      id:
        "skin_" +
        crypto
          .createHash("sha1")
          .update(name)
          .digest("hex")
          .slice(0, 12),

      name,

      img:
        item.image,

      usd,

      api:
        item
    });
  }

  console.log(
    "[CS2] Priced items:",
    all.length
  );

  /*
   * Сортируем по цене.
   */
  all.sort(
    (a, b) =>
      a.usd - b.usd
  );

  /*
   * Ценовые диапазоны.
   * Благодаря этому дешёвые кейсы
   * не получают случайно ножи за 200 000 ₽.
   */
  const buckets = [
    [0.5, 2],
    [2, 5],
    [5, 10],
    [10, 20],
    [20, 50],
    [50, 100],
    [100, 250],
    [250, 500],
    [500, 1000],
    [1000, 2500],
    [2500, 10000],
    [10000, Infinity]
  ];

  const limits = [
    300,
    280,
    240,
    200,
    170,
    140,
    110,
    80,
    60,
    40,
    25,
    15
  ];

  const picked = [];
  const used = new Set();

  for (
    let i = 0;
    i < buckets.length;
    i++
  ) {
    const min =
      buckets[i][0];

    const max =
      buckets[i][1];

    const pool =
      all.filter(
        x =>
          x.usd >= min &&
          x.usd < max
      );

    /*
     * Перемешиваем диапазон.
     */
    for (
      let j = pool.length - 1;
      j > 0;
      j--
    ) {
      const k =
        Math.floor(
          Math.random() *
          (j + 1)
        );

      [
        pool[j],
        pool[k]
      ] = [
        pool[k],
        pool[j]
      ];
    }

    for (
      const item
      of pool.slice(
        0,
        limits[i]
      )
    ) {
      if (
        used.has(item.name)
      ) {
        continue;
      }

      used.add(item.name);
      picked.push(item);
    }
  }

  /*
   * Если каталог маленький —
   * добираем остальные.
   */
  for (
    const item
    of all
  ) {
    if (
      picked.length >= 1500
    ) {
      break;
    }

    if (
      used.has(item.name)
    ) {
      continue;
    }

    used.add(item.name);
    picked.push(item);
  }

  /*
   * Финальная сортировка.
   */
  picked.sort(
    (a, b) =>
      a.usd - b.usd
  );

  const result =
    picked.slice(
      0,
      1500
    );

  console.log(
    "[CS2] Catalog ready:",
    result.length
  );

  if (result.length) {
    console.log(
      "[CS2] Range:",
      result[0].usd,
      "-",
      result[result.length - 1].usd
    );
  }

  return result;
}

/* =========================
   CATALOG CACHE
========================= */

async function getCatalog() {
  const now =
    Date.now();

  if (
    catalogCache &&
    now < catalogCacheExpires
  ) {
    return catalogCache;
  }

  /*
   * Если каталог уже строится,
   * второй раз его не запускаем.
   */
  if (catalogBuildPromise) {
    return catalogBuildPromise;
  }

  catalogBuildPromise =
    buildCs2Catalog()
      .then(items => {
        catalogCache =
          items;

        catalogCacheExpires =
          Date.now() +
          CATALOG_CACHE_TIME;

        return items;
      })
      .finally(() => {
        catalogBuildPromise =
          null;
      });

  return catalogBuildPromise;
}

/* =========================
   COOKIES
========================= */

function parseCookies(req) {
  const result = {};

  const cookie =
    req.headers.cookie;

  if (!cookie) {
    return result;
  }

  cookie
    .split(";")
    .forEach(part => {
      const index =
        part.indexOf("=");

      if (index === -1) {
        return;
      }

      const key =
        part
          .slice(0, index)
          .trim();

      const value =
        part
          .slice(index + 1)
          .trim();

      result[key] =
        decodeURIComponent(value);
    });

  return result;
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

        const pathname =
          url.pathname;

        const cookies =
          parseCookies(req);

        let sessionUser =
          null;

        if (
          cookies.session_id &&
          sessions.has(
            cookies.session_id
          )
        ) {
          sessionUser =
            sessions.get(
              cookies.session_id
            );
        }

        /* =====================
           STEAM LOGIN
        ===================== */

        if (
          pathname ===
          "/auth/steam"
        ) {

          const proto =
            req.headers[
              "x-forwarded-proto"
            ] || "https";

          const host =
            req.headers.host;

          const realm =
            `${proto}://${host}`;

          const returnTo =
            `${realm}/auth/steam/return`;

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
            returnTo
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

          res.writeHead(
            302,
            {
              Location:
                "https://steamcommunity.com/openid/login?" +
                params.toString()
            }
          );

          return res.end();
        }

        /* =====================
           STEAM RETURN
        ===================== */

        if (
          pathname ===
          "/auth/steam/return"
        ) {

          try {

            const params =
              new URLSearchParams();

            params.set(
              "openid.ns",
              "http://specs.openid.net/auth/2.0"
            );

            params.set(
              "openid.mode",
              "check_authentication"
            );

            url.searchParams.forEach(
              (value, key) => {

                if (
                  key !==
                  "openid.mode"
                ) {
                  params.append(
                    key,
                    value
                  );
                }

              }
            );

            const verify =
              await fetch(
                "https://steamcommunity.com/openid/login",
                {
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/x-www-form-urlencoded"
                  },

                  body:
                    params.toString()
                }
              );

            const text =
              await verify.text();

            if (
              text.includes(
                "is_valid:true"
              )
            ) {

              const claimed =
                url.searchParams.get(
                  "openid.claimed_id"
                );

              const match =
                claimed &&
                claimed.match(
                  /\/id\/(\d+)$/
                );

              if (match) {

                const steamId =
                  match[1];

                let user = {
                  steamid:
                    steamId
                };

                if (
                  STEAM_API_KEY
                ) {

                  try {

                    const r =
                      await fetch(
                        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?" +
                        new URLSearchParams({
                          key:
                            STEAM_API_KEY,

                          steamids:
                            steamId
                        })
                      );

                    const data =
                      await r.json();

                    const player =
                      data
                        ?.response
                        ?.players?.[0];

                    if (player) {

                      user = {
                        steamid:
                          steamId,

                        username:
                          player.personaname ||
                          "Steam",

                        personaname:
                          player.personaname ||
                          "Steam",

                        avatar:
                          player.avatarfull ||
                          player.avatarmedium ||
                          player.avatar ||
                          "",

                        profileurl:
                          player.profileurl ||
                          ""
                      };

                    }

                  } catch {}
                }

                const sessionId =
                  crypto
                    .randomBytes(24)
                    .toString(
                      "hex"
                    );

                sessions.set(
                  sessionId,
                  user
                );

                res.writeHead(
                  302,
                  {
                    Location: "/",

                    "Set-Cookie":
                      `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
                  }
                );

                return res.end();
              }
            }

          } catch (error) {

            console.error(
              "Steam Auth Error:",
              error
            );
          }

          res.writeHead(
            302,
            {
              Location: "/"
            }
          );

          return res.end();
        }

        /* =====================
           CURRENT USER
        ===================== */

        if (
          pathname ===
          "/api/current-user" &&
          req.method === "GET"
        ) {

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",

              "Cache-Control":
                "no-store"
            }
          );

          return res.end(
            JSON.stringify(
              sessionUser || null
            )
          );
        }

        /* =====================
           LOGOUT
        ===================== */

        if (
          pathname ===
          "/auth/logout"
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
              Location: "/",

              "Set-Cookie":
                "session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
            }
          );

          return res.end();
        }

        /* =====================
           MAIN HTML
        ===================== */

        if (
          pathname === "/" &&
          req.method === "GET"
        ) {

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8",

              "Cache-Control":
                "no-cache"
            }
          );

          return res.end(html);
        }

        /* =====================
           USD → RUB
        ===================== */

        if (
          pathname ===
          "/api/usd-rub"
        ) {

          try {

            const r =
              await fetch(
                "https://open.er-api.com/v6/latest/USD"
              );

            const data =
              await r.json();

            const rate =
              Number(
                data
                  ?.rates
                  ?.RUB
              );

            if (
              !Number.isFinite(
                rate
              ) ||
              rate <= 0
            ) {
              throw new Error(
                "Invalid USD/RUB rate"
              );
            }

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json",

                "Cache-Control":
                  "no-store"
              }
            );

            return res.end(
              JSON.stringify({
                rate
              })
            );

          } catch {

            /*
             * Главное — не блокировать
             * запуск сайта из-за курса.
             */
            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                rate: 80
              })
            );
          }
        }

        /* =====================
           IMAGE PROXY
        ===================== */

        if (
          pathname ===
          "/api/skin-image" &&
          req.method === "GET"
        ) {

          try {

            const raw =
              url.searchParams.get(
                "url"
              );

            if (!raw) {

              res.writeHead(
                400,
                {
                  "Content-Type":
                    "application/json"
                }
              );

              return res.end(
                JSON.stringify({
                  error:
                    "missing_url"
                })
              );
            }

            const imageUrl =
              new URL(raw);

            /*
             * Только cs2.sh.
             */
            if (
              imageUrl.protocol !==
                "https:" ||
              !(
                imageUrl.hostname ===
                  "cs2.sh" ||
                imageUrl.hostname.endsWith(
                  ".cs2.sh"
                )
              )
            ) {

              res.writeHead(
                403,
                {
                  "Content-Type":
                    "application/json"
                }
              );

              return res.end(
                JSON.stringify({
                  error:
                    "image_host_not_allowed"
                })
              );
            }

            const image =
              await fetch(
                imageUrl,
                {
                  headers: {
                    Accept:
                      "image/*"
                  },

                  signal:
                    AbortSignal.timeout(
                      10000
                    )
                }
              );

            if (
              !image.ok
            ) {

              res.writeHead(
                image.status,
                {
                  "Content-Type":
                    "application/json"
                }
              );

              return res.end(
                JSON.stringify({
                  error:
                    "image_fetch_failed"
                })
              );
            }

            const buffer =
              Buffer.from(
                await image.arrayBuffer()
              );

            res.writeHead(
              200,
              {
                "Content-Type":
                  image.headers.get(
                    "content-type"
                  ) ||
                  "image/png",

                "Cache-Control":
                  "public, max-age=86400, immutable",

                "Content-Length":
                  buffer.length
              }
            );

            return res.end(
              buffer
            );

          } catch {

            res.writeHead(
              404,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                error:
                  "image_unavailable"
              })
            );
          }
        }

        /* =====================
           CS2 CATALOG
        ===================== */

        if (
          pathname ===
            "/api/cs2/catalog" &&
          req.method === "GET"
        ) {

          try {

            if (
              catalogCache &&
              Date.now() <
                catalogCacheExpires
            ) {

              res.writeHead(
                200,
                {
                  "Content-Type":
                    "application/json; charset=utf-8",

                  "Cache-Control":
                    "public, max-age=300"
                }
              );

              return res.end(
                JSON.stringify({
                  currency:
                    "USD",

                  items:
                    catalogCache,

                  cached:
                    true
                })
              );
            }

            const items =
              await getCatalog();

            if (
              !items.length
            ) {
              throw new Error(
                "cs2.sh returned no priced items"
              );
            }

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json; charset=utf-8",

                "Cache-Control":
                  "public, max-age=300"
              }
            );

            return res.end(
              JSON.stringify({
                currency:
                  "USD",

                items,

                cached:
                  false
              })
            );

          } catch (error) {

            console.error(
              "[CS2 CATALOG ERROR]",
              error
            );

            res.writeHead(
              Number(
                error.status
              ) || 502,
              {
                "Content-Type":
                  "application/json; charset=utf-8"
              }
            );

            return res.end(
              JSON.stringify({
                error:
                  "cs2_catalog_proxy_error",

                message:
                  String(
                    error.message ||
                    error
                  ),

                upstreamStatus:
                  error.status ||
                  null,

                details:
                  error.body ||
                  null
              })
            );
          }
        }

        /* =====================
           CS2 SCHEMA
        ===================== */

        if (
          pathname ===
            "/api/cs2/schema" &&
          req.method === "GET"
        ) {

          try {

            const data =
              await cs2Fetch(
                "https://api.cs2.sh/v1/schema"
              );

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json; charset=utf-8"
              }
            );

            return res.end(
              JSON.stringify(data)
            );

          } catch (error) {

            res.writeHead(
              502,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                error:
                  "cs2_schema_proxy_error",

                message:
                  String(
                    error.message ||
                    error
                  )
              })
            );
          }
        }

        /* =====================
           CS2 PRICE PROXY
        ===================== */

        if (
          pathname ===
            "/api/prices" &&
          req.method === "POST"
        ) {

          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );

          req.on(
            "end",
            async () => {

              try {

                const input =
                  JSON.parse(
                    body || "{}"
                  );

                const items =
                  Array.isArray(
                    input.items
                  )
                    ? input.items
                        .filter(
                          x =>
                            typeof x ===
                              "string" &&
                            x.trim()
                        )
                        .slice(
                          0,
                          100
                        )
                    : [];

                if (
                  !items.length
                ) {

                  res.writeHead(
                    400,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

                  return res.end(
                    JSON.stringify({
                      error:
                        "items_required"
                    })
                  );
                }

                const data =
                  await cs2Fetch(
                    "https://api.cs2.sh/v1/prices/latest",
                    {
                      method:
                        "POST",

                      headers: {
                        "Content-Type":
                          "application/json"
                      },

                      body:
                        JSON.stringify({
                          items
                        })
                    }
                  );

                res.writeHead(
                  200,
                  {
                    "Content-Type":
                      "application/json; charset=utf-8"
                  }
                );

                return res.end(
                  JSON.stringify(data)
                );

              } catch (error) {

                res.writeHead(
                  502,
                  {
                    "Content-Type":
                      "application/json"
                  }
                );

                return res.end(
                  JSON.stringify({
                    error:
                      "cs2_prices_proxy_error",

                    message:
                      String(
                        error.message ||
                        error
                      )
                  })
                );
              }
            }
          );

          return;
        }

        /* =====================
           404
        ===================== */

        res.writeHead(
          404,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        return res.end(
          "Not found"
        );

      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );

        if (
          !res.headersSent
        ) {

          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              error:
                error.message
            })
          );
        }

        res.end();
      }
    }
  );

/* =========================
   START
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Zenodrop running on port ${PORT}`
    );

    console.log(
      "CS2.SH:",
      KEY
        ? "OK"
        : "NO KEY"
    );

    console.log(
      "Steam:",
      STEAM_API_KEY
        ? "OK"
        : "NO KEY"
    );
  }
);
