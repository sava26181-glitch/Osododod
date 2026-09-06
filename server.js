const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const KEY = process.env.CS2SH_API_KEY;

if (!KEY) {
    console.error('Set CS2SH_API_KEY environment variable');
    process.exit(1);
}

const html = fs.readFileSync(
    path.join(__dirname, 'Zenodrop_CS2SH_400.html')
);

const server = http.createServer(async (req, res) => {

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

    // Цены CS2.SH
    if (req.url === '/api/prices' && req.method === 'POST') {

        let body = '';

        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {

            try {

                const input = JSON.parse(body);

                // Максимум 100 скинов за один запрос
                const items = Array.isArray(input.items)
                    ? input.items.slice(0, 100)
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
                    'Content-Type': 'application/json'
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
