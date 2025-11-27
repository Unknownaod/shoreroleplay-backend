require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const path = require("path");

const app = express();

// Serve your front-end (public folder)
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  secret: process.env.SESSION_SECRET || "SHORERP-SECRET",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 } // 1 day
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: `${process.env.CALLBACK_URL}`, // IMPORTANT CHANGE
  scope: ["identify"]
}, (accessToken, refreshToken, profile, done) => done(null, profile)));


// =====================
// AUTH ROUTES
// =====================

// Start OAuth
app.get("/auth", passport.authenticate("discord"));

// Discord redirects here
app.get("/auth/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/") // send back to frontend
);

// Logout user
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Returns the logged-in Discord user
app.get("/user", (req, res) => {
  res.json(req.user || {});
});


// =====================
// SERVER LISTENER
// =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Shore Roleplay Auth Server running on port ${PORT}`)
);
