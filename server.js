const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();

// Настройка сессий
app.use(session({
    secret: 'zenodrop_super_secret_key_12345',
    resave: true,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

// Настройка Steam Strategy
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

// Раздаем статические файлы
app.use(express.static(path.join(__dirname)));

// --- НАСТРОЙКА ЦЕН (SKINTICK) ---
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

// Запускаем сразу при старте и каждые 15 минут
updatePricesFromSkintick();
setInterval(updatePricesFromSkintick, 900000);

// Эндпоинт для фронтенда
app.get('/api/live-prices', (req, res) => {
    res.json({ success: true, prices: livePrices });
});
// ---------------------------------

// Маршруты авторизации через Steam
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' })
);

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        const steamId = req.user.id;
        const name = encodeURIComponent(req.user.displayName);
        const avatar = encodeURIComponent(req.user.photos[2]?.value || req.user.photos[0]?.value || '');
        res.redirect(`/?steamId=${steamId}&name=${name}&avatar=${avatar}`);
    }
);

// Выход из аккаунта
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
