const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();

// Настройка сессий (обязательно для работы passport-steam)
app.use(session({
    secret: 'your_super_secret_key_change_this',
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

// Настройка стратегии Steam Web API
passport.use(new SteamStrategy({
    returnURL: 'https://osododod.onrender.com/auth/steam/return',
    realm: 'https://osododod.onrender.com/',
    apiKey: process.env.STEAM_API_KEY // Ключ автоматически берется из переменных окружения Render
}, (identifier, profile, done) => {
    process.nextTick(() => {
        profile.identifier = identifier;
        return done(null, profile);
    });
}));

// Статические файлы (если ваш фронтенд лежит в папке public)
app.use(express.static(path.join(__dirname, 'public')));

// Шаг 1: Запрос на авторизацию — перенаправляет на сайт Steam
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // Функция не обязательна, так как passport сам делает redirect на Steam
    }
);

// Шаг 2: Возврат со Steam после входа
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // Успешный вход! Сюда можно подставить путь, куда перенаправлять пользователя
        // Например, на главную страницу или в профиль:
        res.redirect('/'); 
    }
);

// Маршрут для получения данных текущего авторизованного пользователя (удобно для фронтенда)
app.get('/api/current-user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ success: true, user: req.user });
    } else {
        res.status(401).json({ success: false, error: 'Not authenticated' });
    }
);

// Выход из аккаунта
app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
