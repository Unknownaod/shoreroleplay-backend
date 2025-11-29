/* ============================================================
   SHORE ROLEPLAY RADIO SERVER
   Unified Web-Based Radio Communications Infrastructure
   ------------------------------------------------------------
   Requirements:
   - Node.js 18+
   - Serves pure WebSocket low-latency audio
   - Integrates with MongoDB users + departments via REST API
============================================================ */

const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch");
const crypto = require("crypto");

// CONFIG
const PORT = process.env.RADIO_PORT || 8899;
const API = process.env.API_URL || "https://shoreroleplay.onrender.com";

// Active channels in memory
const channels = new Map(); // id → { users: Set, roster: [] }

// Users online
const users = new Map(); // socket.id → user object

// Panic state
let panicActive = false;
let panicUnit = null;

// ------------------------------------------------------------
// SERVER SETUP
// ------------------------------------------------------------

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: {
    origin: ["https://radio.shoreroleplay.xyz", "https://shoreroleplay.xyz"],
    methods: ["GET", "POST"]
  }
});

httpServer.listen(PORT, () =>
  console.log(`📡 Shore Radio Server online on port ${PORT}`)
);

// ------------------------------------------------------------
// AUTH HELPERS
// ------------------------------------------------------------

async function validateUser(token, userId) {
  try {
    const res = await fetch(`${API}/users/${userId}`);
    const u = await res.json();
    if (!u || u.error) return null;
    return u;
  } catch (e) {
    console.log("Auth check failed:", e.message);
    return null;
  }
}

// ------------------------------------------------------------
// SOCKET EVENTS
// ------------------------------------------------------------

io.use(async (socket, next) => {
  const { token, userId } = socket.handshake.auth;

  const user = await validateUser(token, userId);
  if (!user) return next(new Error("AUTH_FAIL"));

  users.set(socket.id, {
    id: user.id,
    username: user.username,
    role: user.role,
    department: user.department || null,
    socket
  });

  socket.emit("auth_success");
  next();
});

io.on("connection", socket => {
  const user = users.get(socket.id);
  console.log(`🔗 User connected: ${user.username}`);

  socket.on("joinChannel", chId => joinChannel(socket, chId));
  socket.on("signal", chunk => relayAudio(socket, chunk));
  socket.on("ptt_start", () => broadcastPTT(socket, "start"));
  socket.on("ptt_stop", () => broadcastPTT(socket, "stop"));
  socket.on("panic_trigger", () => handlePanic(socket));

  socket.on("disconnect", () => {
    leaveAll(socket);
    users.delete(socket.id);
    console.log(`❌ User disconnected: ${user.username}`);
  });
});

// ------------------------------------------------------------
// CHANNEL HANDLING
// ------------------------------------------------------------

async function joinChannel(socket, chId) {
  const user = users.get(socket.id);
  leaveAll(socket);

  if (!channels.has(chId)) {
    channels.set(chId, { users: new Set(), roster: [] });
  }

  const ch = channels.get(chId);
  ch.users.add(socket.id);

  updateRoster(chId);

  socket.join(chId);
  socket.emit("joined", { id: chId, name: await fetchChannelName(chId) });
  console.log(`📡 ${user.username} joined ${chId}`);
}

function leaveAll(socket) {
  for (const [chId, ch] of channels) {
    if (ch.users.has(socket.id)) {
      ch.users.delete(socket.id);
      updateRoster(chId);
    }
  }
}

// ------------------------------------------------------------
// ROSTER FORMATION
// ------------------------------------------------------------

async function updateRoster(chId) {
  const ch = channels.get(chId);
  const roster = [...ch.users].map(id => users.get(id));

  ch.roster = roster.map(u => ({
    username: u.username,
    role: u.role || "CIV"
  }));

  io.to(chId).emit("channel_roster", { roster: ch.roster });
}

// ------------------------------------------------------------
// AUDIO RELAY
// ------------------------------------------------------------

function relayAudio(socket, chunk) {
  const user = users.get(socket.id);
  socket.rooms.forEach(room => {
    if (room !== socket.id) {
      socket.to(room).emit("signal", { chunk });
    }
  });
}

// ------------------------------------------------------------
// PTT INDICATORS
// ------------------------------------------------------------

function broadcastPTT(socket, state) {
  const user = users.get(socket.id);
  socket.rooms.forEach(room => {
    if (room !== socket.id) {
      socket.to(room).emit("ptt_state", { user, state });
    }
  });
}

// ------------------------------------------------------------
// PANIC MODE
// ------------------------------------------------------------

function handlePanic(socket) {
  const user = users.get(socket.id);

  panicActive = true;
  panicUnit = user.username;

  io.emit("panic_alert", { unit: user.username });
  console.log(`🚨 PANIC from ${user.username}`);
}

function clearPanic() {
  panicActive = false;
  panicUnit = null;
  io.emit("panic_clear");
}

// ------------------------------------------------------------
// CHANNEL NAME LOOKUP
// ------------------------------------------------------------

async function fetchChannelName(id) {
  try {
    const res = await fetch(`${API}/radio/channels`);
    const chans = await res.json();
    const c = chans.find(x => x.id === id);
    return c?.name || "UNKNOWN CHANNEL";
  } catch {
    return "UNKNOWN CHANNEL";
  }
}

// ------------------------------------------------------------
