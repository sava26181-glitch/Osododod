const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();

app.use(session({
    secret: 'zenodrop_super_secret_key_12345',
    resave: true,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new SteamStrategy({
    returnURL: 'https://osododod.onrender.com/auth/steam/return',
    realm: 'https://osododod.onrender.com/',
    apiKey: process.env.STEAM_API_KEY
}, (identifier, profile, done) => {
    process.nextTick(() => {
        profile.identifier = identifier;
        return done(null, profile);
    });
}));

app.use(express.static(path.join(__dirname)));

// --- ЖИВЫЕ ЦЕНЫ СЕРИВИСА SKINTICK ---
let livePrices = {};

async function updatePricesFromSkintick() {
    try {
        const response = await fetch('https://api.skintick.io/v1/prices', {
            headers: { 
                'Authorization': 'Bearer free user_3IxAFNJMcB7ANaJBPoOokBF4rdj' 
            }
        });
        const data = await response.json();
        
        if (data && data.success) {
            livePrices = data.prices || data; 
            console.log("Цены успешно обновлены со Skintick:", new Date().toLocaleTimeString());
        }
    } catch (e) {
        console.error("Ошибка при обновлении цен со Skintick:", e.message);
    }
}

updatePricesFromSkintick();
setInterval(updatePricesFromSkintick, 900000);

// Эндпоинт цен
app.get('/api/live-prices', (req, res) => {
    res.json({ success: true, prices: livePrices });
});

// --- ЛЕНТА ПОСЛЕДНИХ ВЫИГРЫШЕЙ (КАК У КОНКУРЕНТОВ) ---
const sampleDrops = [
    { name: "P90 | Прорыв в вентиляции", price: 34 },
    { name: "SG 553 | Техника дракона", price: 34 },
    { name: "P250 | Киберпанцирь", price: 34 },
    { name: "Desert Eagle | Стрелковая дисциплина", price: 59 },
    { name: "USP-S | Билет в ад", price: 58 },
    { name: "AWP | Древесная гадюка", price: 439 },
    { name: "AK-47 | Колымага", price: 330 },
    { name: "Glock-18 | Франклин", price: 8145 },
    { name: "AWP | Поток информации", price: 12500 }
];

app.get('/api/latest-drops', (req, res) => {
    // Генерируем рандомные реальные выдачи для ленты побед
    const shuffled = [...sampleDrops].sort(() => 0.5 - Math.random());
    res.json({ success: true, drops: shuffled.slice(0, 10) });
});

// --- ЛОГИКА ОТКРЫТИЯ КЕЙСА С УЧЕТОМ ШАНСОВ ---
app.post('/api/open-case', express.json(), (req, res) => {
    const { casePrice } = req.body;
    
    // База предметов с ценами
    let pool = [
        { name: "P90 | Прорыв в вентиляции", price: 34, category: "low" },
        { name: "SG 553 | Техника дракона", price: 34, category: "low" },
        { name: "MP5-SD | Гаусс", price: 48, category: "low" },
        { name: "P250 | Рентген", price: 38, category: "low" },
        { name: "UMP-45 | Лунная ночь", price: 50, category: "low" },
        { name: "MAC-10 | Золотой кирпич", price: 2735, category: "high" },
        { name: "Glock-18 | Франклин", price: 8145, category: "epic" },
        { name: "Desert Eagle | Изумрудный Ёрмунганд", price: 42218, category: "legendary" },
        { name: "AWP | Поток информации", price: 12500, category: "epic" }
    ];

    let rand = Math.random() * 100; // от 0 до 100%
    let wonItem;

    if (casePrice == 100) {
        // Твои точные шансы для кейса за 100р (без вывода текста о процентах клиенту)
        if (rand < 0.001) {
            wonItem = pool.find(i => i.price > 10000); // Легендарки
        } else if (rand < 0.10) {
            wonItem = pool.find(i => i.price > 1000 && i.price <= 10000); // Эпики
        } else if (rand < 2.0) {
            wonItem = pool.find(i => i.price >= 500 && i.price <= 1000);
        } else if (rand < 7.0) {
            wonItem = pool.find(i => i.price >= 400 && i.price < 500);
        } else if (rand < 15.0) {
            wonItem = pool.find(i => i.price >= 300 && i.price < 400);
        } else if (rand < 30.0) {
            wonItem = pool.find(i => i.price >= 200 && i.price < 300);
        } else if (rand < 70.0) {
            wonItem = pool.find(i => i.price >= 150 && i.price < 200);
        } else {
            wonItem = pool.find(i => i.price < 120);
        }
    }
    
    // Страховка, если рандом не зацепил конкретный слот
    if (!wonItem) {
        wonItem = pool[Math.floor(Math.random() * pool.length)];
    }

    res.json({ success: true, item: wonItem });
});

app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
    const steamId = req.user.id;
    const name = encodeURIComponent(req.user.displayName);
    const avatar = encodeURIComponent(req.user.photos[2]?.value || req.user.photos[0]?.value || '');
    res.redirect(`/?steamId=${steamId}&name=${name}&avatar=${avatar}`);
});

app.get('/logout', (req, res, next) => {
    req.logout((err) => { if (err) return next(err); res.redirect('/'); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
