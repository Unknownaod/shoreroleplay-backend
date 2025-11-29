/**
 * Shore Roleplay – Advanced Radio Signaling Server
 * ------------------------------------------------
 * Responsibilities:
 *  - WebSocket (Socket.io) transport
 *  - Validates users against existing Shore backend
 *  - Loads radio channels from /radio/channels
 *  - Enforces channel permissions (public / dept / staff / custom)
 *  - Tracks channel membership + live rosters
 *  - Handles PTT start/stop and audio chunk relays
 *  - Supports staff monitoring multiple channels
 *
 *  Expected handshake from client:
 *    const socket = io(RADIO_URL, {
 *      auth: { token: shoreUser.token, userId: shoreUser.id }
 *    });
 */

const express = require("express");
const http = require("http");
const cors = require("cors");
const axios = require("axios");
const { Server } = require("socket.io");

/* ==========================
   CONFIG
   ========================== */

const BACKEND_URL =
  process.env.BACKEND_URL || "https://shoreroleplay.onrender.com";

const PORT = process.env.PORT || 3001;

// How often we refresh channels from backend (ms)
const CHANNEL_REFRESH_MS = Number(process.env.CHANNEL_REFRESH_MS || 10000);

// Simple anti-spam limits
const MAX_PTT_STARTS_PER_10S = Number(
  process.env.MAX_PTT_STARTS_PER_10S || 10
);
const MAX_CHUNKS_PER_SECOND = Number(
  process.env.MAX_CHUNKS_PER_SECOND || 30
);

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

/* ==========================
   IN-MEMORY STATE
   ========================== */

// Latest channel definitions from backend
//  { id, name, type, department, allowedRoles, system, ... }
let CHANNELS = [];

// Map<socket.id, { user, currentChannel, monitoring:Set<string>, stats:{...} }>
const clients = new Map();

// Map<channelId, Set<socket.id>>
const channelMembers = new Map();

/* ==========================
   HELPERS
   ========================== */

function getChannelById(id) {
  return CHANNELS.find((c) => c.id === id);
}

function userIsStaff(user) {
  if (!user) return false;
  if (user.isStaff) return true;
  if (user.roles && Array.isArray(user.roles)) {
    return user.roles.includes("staff");
  }
  return false;
}

function getUserDisplay(user) {
  return {
    id: user.id,
    username: user.username,
    department: user.department || null,
    role: user.role || null,
    isStaff: !!userIsStaff(user),
  };
}

// Basic permission logic, using channel doc + user doc
function userCanJoinChannel(user, channel) {
  if (!user || !channel) return false;

  // Staff can bypass most things unless we explicitly block them
  const staff = userIsStaff(user);

  switch (channel.type) {
    case "public":
      return true;

    case "department":
      if (staff) return true;
      return user.department && user.department === channel.department;

    case "staff":
      return staff;

    case "custom": {
      if (staff) return true;
      // Optional department restriction
      if (channel.department && user.department !== channel.department) {
        return false;
      }
      // Optional role restriction
      if (
        channel.allowedRoles &&
        Array.isArray(channel.allowedRoles) &&
        channel.allowedRoles.length
      ) {
        const userRoles = Array.isArray(user.roles) ? user.roles : [];
        const overlap = channel.allowedRoles.some((r) =>
          userRoles.includes(r)
        );
        if (!overlap) return false;
      }
      return true;
    }

    default:
      return false;
  }
}

async function validateUser(auth) {
  const { token, userId } = auth || {};

  // Prefer proper token validation route if it exists
  if (token) {
    try {
      const res = await axios.get(`${BACKEND_URL}/users/validate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data && res.data.user) return res.data.user;
    } catch (_) {
      // fall through to /users/:id
    }
  }

  // Fallback: if we have userId, try to fetch user directly
  if (userId) {
    try {
      const res = await axios.get(`${BACKEND_URL}/users/${userId}`);
      return res.data;
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function loadChannelsFromBackend() {
  try {
    const res = await axios.get(`${BACKEND_URL}/radio/channels`);
    if (Array.isArray(res.data)) {
      CHANNELS = res.data;
    } else {
      CHANNELS = [];
    }
  } catch (err) {
    console.error("❌ Failed to load radio channels:", err.message);
  }
}

// Broadcast channel roster to everyone in that channel
function broadcastRoster(channelId) {
  const members = channelMembers.get(channelId);
  if (!members) return;

  const roster = Array.from(members).map((sid) => {
    const data = clients.get(sid);
    return data ? getUserDisplay(data.user) : null;
  }).filter(Boolean);

  io.to(channelId).emit("channel_roster", {
    channelId,
    roster,
  });
}

// Ensure channelMembers map has a set for id
function ensureChannelSet(id) {
  if (!channelMembers.has(id)) {
    channelMembers.set(id, new Set());
  }
  return channelMembers.get(id);
}

/* ==========================
   INITIAL BOOTSTRAP
   ========================== */

loadChannelsFromBackend();
setInterval(loadChannelsFromBackend, CHANNEL_REFRESH_MS);

/* ==========================
   SOCKET HANDLERS
   ========================== */

io.on("connection", async (socket) => {
  // Validate user against backend
  const user = await validateUser(socket.handshake.auth);

  if (!user) {
    socket.emit("auth_failed");
    return socket.disconnect(true);
  }

  const userDisplay = getUserDisplay(user);

  // Initialize client state
  clients.set(socket.id, {
    user,
    currentChannel: null,
    monitoring: new Set(), // for staff monitor
    stats: {
      pttStarts: [],
      chunksPerSecond: {},
    },
  });

  console.log(
    `🔌 ${userDisplay.username} connected to radio (${socket.id})`
  );

  socket.emit("auth_success", userDisplay);
  socket.emit("channels", CHANNELS);

  /* ---- JOIN PRIMARY CHANNEL ---- */
  socket.on("joinChannel", (channelId) => {
    const state = clients.get(socket.id);
    if (!state) return;

    const channel = getChannelById(channelId);
    if (!channel) return socket.emit("errorMsg", "Channel not found.");

    if (!userCanJoinChannel(state.user, channel)) {
      return socket.emit(
        "denied",
        `You are not allowed to join ${channel.name}.`
      );
    }

    // Leave previous primary channel
    if (state.currentChannel) {
      const prevSet = ensureChannelSet(state.currentChannel);
      prevSet.delete(socket.id);
      socket.leave(state.currentChannel);
      broadcastRoster(state.currentChannel);
    }

    state.currentChannel = channelId;
    const set = ensureChannelSet(channelId);
    set.add(socket.id);
    socket.join(channelId);

    console.log(
      `📡 ${state.user.username} joined primary channel ${channelId}`
    );

    socket.emit("joined", {
      id: channelId,
      name: channel.name,
    });
    broadcastRoster(channelId);
  });

  /* ---- STAFF MONITOR EXTRA CHANNELS (LISTEN ONLY) ---- */
  socket.on("monitorChannel", (channelId) => {
    const state = clients.get(socket.id);
    if (!state) return;
    if (!userIsStaff(state.user)) {
      return socket.emit("denied", "Only staff can monitor channels.");
    }

    const channel = getChannelById(channelId);
    if (!channel) return;

    if (state.monitoring.has(channelId)) return; // already monitoring

    state.monitoring.add(channelId);
    socket.join(channelId);

    console.log(
      `👂 ${state.user.username} is now monitoring channel ${channelId}`
    );

    socket.emit("monitoring", Array.from(state.monitoring));
  });

  socket.on("unmonitorChannel", (channelId) => {
    const state = clients.get(socket.id);
    if (!state) return;
    if (!userIsStaff(state.user)) return;

    if (!state.monitoring.has(channelId)) return;

    state.monitoring.delete(channelId);
    // Only leave the room if it's not their primary
    if (state.currentChannel !== channelId) {
      socket.leave(channelId);
    }

    socket.emit("monitoring", Array.from(state.monitoring));
  });

  /* ---- PTT START / STOP + RATE LIMITING ---- */

  socket.on("ptt_start", () => {
    const state = clients.get(socket.id);
    if (!state || !state.currentChannel) return;

    // Rate limit PTT start spam (very primitive)
    const now = Date.now();
    state.stats.pttStarts = state.stats.pttStarts.filter(
      (t) => now - t < 10_000
    );
    if (state.stats.pttStarts.length >= MAX_PTT_STARTS_PER_10S) {
      return socket.emit(
        "denied",
        "You are pressing PTT too frequently. Slow down."
      );
    }
    state.stats.pttStarts.push(now);

    // Notify others in channel that this user started transmitting
    io.to(state.currentChannel).emit("ptt_state", {
      user: getUserDisplay(state.user),
      state: "start",
      channelId: state.currentChannel,
    });
  });

  socket.on("ptt_stop", () => {
    const state = clients.get(socket.id);
    if (!state || !state.currentChannel) return;

    io.to(state.currentChannel).emit("ptt_state", {
      user: getUserDisplay(state.user),
      state: "stop",
      channelId: state.currentChannel,
    });
  });

  /* ---- AUDIO CHUNKS ---- */

  socket.on("signal", (audioChunk) => {
    const state = clients.get(socket.id);
    if (!state || !state.currentChannel) return;

    // Basic per-second chunk limit
    const nowSec = Math.floor(Date.now() / 1000);
    const cps = state.stats.chunksPerSecond;
    cps[nowSec] = (cps[nowSec] || 0) + 1;

    // Clean up old entries
    for (const sec in cps) {
      if (Number(sec) < nowSec - 5) delete cps[sec];
    }

    if (cps[nowSec] > MAX_CHUNKS_PER_SECOND) {
      return; // silently drop, user is sending too much
    }

    // Relay to everyone in the same channel (including staff monitoring)
    io.to(state.currentChannel).emit("signal", {
      from: getUserDisplay(state.user),
      channelId: state.currentChannel,
      chunk: audioChunk,
    });
  });

  /* ---- CLIENT REQUESTS REFRESHED CHANNEL LIST ---- */
  socket.on("getChannels", () => {
    socket.emit("channels", CHANNELS);
  });

  /* ---- DISCONNECT ---- */
  socket.on("disconnect", () => {
    const state = clients.get(socket.id);
    if (state) {
      if (state.currentChannel) {
        const set = ensureChannelSet(state.currentChannel);
        set.delete(socket.id);
        broadcastRoster(state.currentChannel);
      }
      // monitored channels: we don't need to update rosters for listen-only
      clients.delete(socket.id);
      console.log(
        `❌ ${state.user.username} disconnected from radio (${socket.id})`
      );
    }
  });
});

/* ==========================
   HTTP ROUTE (optional ping)
   ========================== */

app.get("/", (_req, res) => {
  res.send("Shore Radio Signaling Server Online 📡");
});

/* ==========================
   START SERVER
   ========================== */

server.listen(PORT, () => {
  console.log(
    `📡 Shore Radio Signaling Server listening on port ${PORT}, backend: ${BACKEND_URL}`
  );
});
