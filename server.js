require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const cors = require("cors");
const path = require("path");

const app = express();

/* ===========================
   CORS FIX FOR FRONTEND DOMAIN
   =========================== */
app.use(cors({
  origin: ["https://shoreroleplay.xyz", "https://www.shoreroleplay.xyz"],
  credentials: true
}));

/* Required for secure cookies behind Render proxy */
app.set("trust proxy", 1);

/* ===========================
   SESSION (ONLY ONCE!)
   =========================== */
app.use(session({
  secret: process.env.SESSION_SECRET || "SHORERP-SECRET",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,          // HTTPS-only cookie
    httpOnly: true,
    sameSite: "none",      // REQUIRED for cross-domain
    maxAge: 86400000       // 1 day
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(passport.initialize());
app.use(passport.session());

/* ===========================
   PASSPORT DISCORD STRATEGY
   =========================== */
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL, // MUST MATCH DISCORD PORTAL
  scope: ["identify"]
}, (accessToken, refreshToken, profile, done) => done(null, profile)));


/* ===========================
   AUTH ROUTES
   =========================== */

// Discord login start
app.get("/auth", passport.authenticate("discord"));

// Discord returns here
app.get("/auth/callback",
  passport.authenticate("discord", { failureRedirect: "https://shoreroleplay.xyz" }),
  (req, res) => res.redirect("https://shoreroleplay.xyz")
);

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("https://shoreroleplay.xyz"));
});

// Returns logged-in Discord user
app.get("/user", (req, res) => {
  res.json(req.user || {});
});


/* ===========================
   SERVER
   =========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Auth server running on " + PORT));
