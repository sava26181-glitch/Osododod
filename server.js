const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render автоматически подставляет внешний URL, либо используем localhost для тестов
const HOST_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.use(session({ secret: 'zenodrop_secret_key', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(obj));

passport.use(new SteamStrategy({
    returnURL: `${HOST_URL}/auth/steam/return`,
    realm: `${HOST_URL}/`,
    apiKey: 'ВАШ_STEAM_API_KEY' // Получите бесплатный ключ на https://steamcommunity.com/dev/apikey
}, (identifier, profile, done) => {
    profile.identifier = identifier;
    return done(null, profile);
}));

app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return', 
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        const steamId = req.user.id;
        const displayName = encodeURIComponent(req.user.displayName);
        const avatar = encodeURIComponent(req.user.photos && req.user.photos[2] ? req.user.photos[2].value : '');
        res.redirect(`/index.html?steamId=${steamId}&name=${displayName}&avatar=${avatar}`);
    }
);

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
