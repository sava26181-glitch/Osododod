# Zenodrop — cs2.sh proxy build

На Render добавьте Environment Variable:

`CS2SH_API_KEY=<ваш ключ cs2.sh>`

Ключ не должен находиться в HTML.

Запуск:
`npm install`
`npm start`

Маршруты:
- GET `/api/cs2/schema` — прокси схемы cs2.sh
- POST `/api/prices` — прокси цен cs2.sh
- GET `/api/usd-rub` — курс USD/RUB

Браузер обращается только к своему Render-серверу, поэтому Bearer-ключ не раскрывается посетителям.
