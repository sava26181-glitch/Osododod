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

// Настройка Steam Strategy (использует ваш домен и ключ из переменных Render)
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

// Раздаем статические файлы (ваш index.html будет работать как главная страница)
app.use(express.static(path.join(__dirname)));

// Маршрут авторизации через Steam
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' })
);

// Маршрут возврата после успешного входа в Steam
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // Передаем данные пользователя обратно на фронтенд через параметры URL
        const steamId = req.user.id;
        const name = encodeURIComponent(req.user.displayName);
        const avatar = encodeURIComponent(req.user.photos[2]?.value || req.user.photos[0]?.value || '');
        
        // Перенаправляем пользователя на главную страницу с его данными
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
