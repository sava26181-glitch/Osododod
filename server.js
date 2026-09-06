const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const app = express();

// Настройка сессий (обязательно для Passport)
app.use(session({
    secret: 'your_secret_key_here',
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

// Настройка стратегии Steam
passport.use(new SteamStrategy({
    returnURL: 'https://osododod.onrender.com/auth/steam/return',
    realm: 'https://osododod.onrender.com/',
    apiKey: process.env.STEAM_API_KEY // Ключ берется из переменных Render
}, (identifier, profile, done) => {
    process.nextTick(() => {
        profile.identifier = identifier;
        return done(null, profile);
    });
}));

// Маршрут для входа через Steam
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    }
);

// Маршрут возврата после авторизации в Steam
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // Успешный вход, перенаправляем на главную или в профиль
        res.redirect('/');
    }
);

// Главная страница
app.get('/', (req, res) => {
    res.send(req.isAuthenticated() ? `Привет, ${req.user.displayName}!` : '<a href="/auth/steam">Войти через Steam</a>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
