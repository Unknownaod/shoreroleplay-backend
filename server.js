require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Brevo = require("@getbrevo/brevo");
const { MongoClient } = require("mongodb");

const app = express();

// allow large uploads (profile picture base64)
app.use(express.json({ limit: "20mb" }));

// FIX CORS
app.use(
  cors({
    origin: [
      "https://www.shoreroleplay.xyz",
      "https://shoreroleplay.xyz",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST", "DELETE", "PUT"],
    allowedHeaders: ["Content-Type"],
  })
);


/* ===========================
   CONSTANTS
   =========================== */
/////////////
const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const HAS_BREVO_KEY = !!process.env.BREVO_API_KEY;

// staff roles used for forums + moderation
const STAFF_ROLES = [
  "Head Administrator",
  "Internal Affairs",
  "Administration",
  "Junior Administration",
  "Senior Staff",
  "Staff",
  "Staff In Training",
];

/* ===========================
   BREVO INITIALIZATION
   =========================== */

let brevoApi = null;
if (HAS_BREVO_KEY) {
  try {
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
    client.basePath = "https://api.brevo.com/v3";
    brevoApi = new Brevo.TransactionalEmailsApi();
    console.log("✅ Brevo email client ready");
  } catch (err) {
    console.error("❌ Brevo init failed", err);
    brevoApi = null;
  }
} else {
  console.warn("⚠️ Missing BREVO_API_KEY (emails disabled)");
}

/* ===========================
   MONGODB CONNECTION
   =========================== */

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGO_URI);
let db, Applications, Users, Appeals, Threads, Replies, Gallery;

async function initDB() {
  await client.connect();
  db = client.db("shoreRoleplay");
  Applications = db.collection("applications");
  Users = db.collection("users");
  Appeals = db.collection("appeals");
  Threads = db.collection("threads");
  Replies = db.collection("replies");
  Gallery = db.collection("gallery");
  console.log("📦 MongoDB connected");
}

initDB().catch((err) => {
  console.error("❌ DB init error:", err);
  process.exit(1);
});

/* ===========================
   HELPERS
   =========================== */

function getClientIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    // can be "ip, ip, ip"
    return xf.split(",")[0].trim();
  }
  return req.ip || null;
}

// HWID generator (random hex)
function generateHWID() {
  return crypto.randomBytes(16).toString("hex");
}

// does this email have at least one accepted application?
async function userHasDepartment(email) {
  const apps = await Applications.find({
    email,
    status: "accepted",
  }).toArray();
  return apps.length > 0;
}

function isStaff(user) {
  if (!user) return false;
  return STAFF_ROLES.includes(user.role);
}

/* ===========================
   EMAIL TEMPLATES
   =========================== */

const { acceptedEmail, deniedEmail } = require("./emailTemplates");

async function sendDecisionEmail(status, user) {
  const html =
    status === "accepted"
      ? acceptedEmail({ username: user.username })
      : deniedEmail({ username: user.username });

  const subject =
    status === "accepted"
      ? "Your Shore Roleplay Application Has Been Approved"
      : "Your Shore Roleplay Application Status";

  if (!brevoApi) {
    console.log("📧 [DEV MODE] Skipped email:", { to: user.email, subject });
    return;
  }

  try {
    const email = new Brevo.SendSmtpEmail();
    email.sender = { name: FROM_NAME, email: FROM_EMAIL };
    email.to = [{ email: user.email, name: user.username }];
    email.subject = subject;
    email.htmlContent = html;

    await brevoApi.sendTransacEmail(email);
    console.log(`📧 Email sent → ${user.email}`);
  } catch (err) {
    console.error("❌ Email error:", err.response?.body || err);
  }
}

/* ===========================
   ROUTES – BASIC
   =========================== */

// HEALTH CHECK
app.get("/", (req, res) => res.send("Shore Roleplay Backend Online 🚀"));

// STAFF AUTH (for staff panel password)
app.post("/staff-auth", (req, res) => {
  if (!process.env.STAFF_PANEL_PASSWORD) {
    return res.status(500).json({ error: "Staff password not set" });
  }

  req.body.password === process.env.STAFF_PANEL_PASSWORD
    ? res.json({ success: true })
    : res.status(401).json({ error: "Invalid password" });
});

/* ============================================
   HEAD ADMIN PANEL AUTH (HA Panel)
============================================ */
app.post("/ha-auth", (req, res) => {
  const haPass = process.env.HEAD_ADMIN_PASSWORD;

  if (!haPass) {
    return res
      .status(500)
      .json({ error: "HEAD_ADMIN_PASSWORD not set in environment" });
  }

  if (req.body.password === haPass) {
    return res.json({ success: true });
  }

  return res.status(401).json({ error: "Invalid head admin password" });
});


// ===== GALLERY MODEL =====
  department: { type: String, required: true }, // "pd", "fire", etc.
  imageUrl:   { type: String, required: true },
  caption:    { type: String, default: "" },
  author:     { type: String, required: true },
  createdAt:  { type: Date, default: Date.now }
}));

/* ===========================
   APPLICATIONS
   =========================== */

// GET ALL APPLICATIONS
app.get("/applications", async (req, res) => {
  try {
    const apps = await Applications.find({}).toArray();
    res.json(apps);
  } catch (err) {
    console.error("❌ Get Applications Error:", err);
    res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// SUBMIT APPLICATION
app.post("/apply", async (req, res) => {
  try {
    const {
      id,
      username,
      email,
      department,
      reason,
      agreedLogging,
      agreedDiscord,
    } = req.body;

    if (!id || typeof id !== "string")
      return res.status(400).json({ error: "Invalid ID" });
    if (!username || username.length < 3)
      return res.status(400).json({ error: "Invalid username" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Invalid email" });
    if (!department)
      return res.status(400).json({ error: "Select a department" });
    if (!reason || reason.length < 100)
      return res.status(400).json({ error: "Reason too short" });
    if (!agreedLogging || !agreedDiscord) {
      return res.status(400).json({ error: "Agreements required" });
    }

    const exists = await Applications.findOne({ $or: [{ id }, { email }] });
    if (exists) return res.status(409).json({ error: "Application already exists" });

    await Applications.insertOne({
      id,
      username,
      email,
      department,
      reason,
      agreedLogging: true,
      agreedDiscord: true,
      status: "pending",
      submittedAt: new Date().toISOString(),
    });

    res.json({ success: true, message: "Application received" });
  } catch (err) {
    console.error("❌ Apply Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// APPLICATION DECISION
app.post("/applications/:id/decision", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "denied"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const appData = await Applications.findOne({ id: req.params.id });
    if (!appData) return res.status(404).json({ error: "Not found" });

    await Applications.updateOne({ id: req.params.id }, { $set: { status } });
    await sendDecisionEmail(status, appData);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Decision Error:", err);
    res.status(500).json({ error: "Decision email failed" });
  }
});

// DELETE APPLICATION
app.delete("/applications/:id", async (req, res) => {
  try {
    const result = await Applications.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ success: true, message: "Application deleted" });
  } catch (err) {
    console.error("❌ Delete Application Error:", err);
    res.status(500).json({ error: "Failed to delete application" });
  }
});

/* ===========================
   USERS – REGISTRATION / LOGIN
   =========================== */

// USER REGISTRATION
app.post("/users/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || username.length < 3)
      return res.status(400).json({ error: "Bad username" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Bad email" });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Bad password" });

    const exists = await Users.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email used" });

    const hwid = generateHWID();
    const registrationIP = getClientIP(req);

    await Users.insertOne({
      id: crypto.randomUUID(),
      username,
      email,
      password, // ⚠ plaintext for now
      role: "user",
      staffTag: null,
      staffIcon: null,
      banned: false,
      banReason: null,
      banDate: null,
      createdAt: new Date().toISOString(),
      hwid,
      lastIP: registrationIP,
      lastLoginAt: null,
    });

    res.json({ success: true, message: "Account created" });
  } catch (err) {
    console.error("❌ Register Error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// USER LOGIN (tracks HWID/IP)
app.post("/users/login", async (req, res) => {
  try {
    const { email, password, hwid } = req.body;

    const user = await Users.findOne({ email, password });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const lastLoginAt = new Date().toISOString();
    const lastIP = getClientIP(req);

    await Users.updateOne(
      { id: user.id },
      {
        $set: {
          lastLoginAt,
          lastIP,
          hwid: hwid || user.hwid || generateHWID(),
        },
      }
    );

    res.json({
      success: true,
      message: "Login OK",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        staffTag: user.staffTag || null,
        staffIcon: user.staffIcon || null,
        banned: !!user.banned,
        banReason: user.banReason || null,
        banDate: user.banDate || null,
        bio: user.bio || "",
        pfp: user.pfp || null,
      },
    });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ===========================
   USER PROFILE / SECURITY
   =========================== */

// CHANGE USERNAME
app.post("/users/change-username", async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id || !username || username.length < 3) {
      return res.status(400).json({ error: "Invalid username change request" });
    }

    const result = await Users.updateOne({ id }, { $set: { username } });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "Username updated" });
  } catch (err) {
    console.error("❌ Change Username Error:", err);
    res.status(500).json({ error: "Failed to change username" });
  }
});

// UPDATE PASSWORD
app.post("/users/update-password", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: "Invalid password update request" });
    }

    const result = await Users.updateOne(
      { email },
      { $set: { password } } // ⚠ still plaintext
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "Password updated" });
  } catch (err) {
    console.error("❌ Update Password Error:", err);
    res.status(500).json({ error: "Failed to update password" });
  }
});

// UPDATE USER PROFILE (BIO + PFP)
app.post("/users/update", async (req, res) => {
  try {
    const { id, bio, pfp } = req.body;
    if (!id) return res.status(400).json({ error: "Missing user ID" });

    const update = {};
    if (bio !== undefined) update.bio = bio;
    if (pfp !== undefined) update.pfp = pfp;

    const result = await Users.updateOne({ id }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "Profile updated" });
  } catch (err) {
    console.error("❌ User Update Error:", err);
    res.status(500).json({ error: "Update failed" });
  }
});


/* ===========================
   APPEALS – BANNED USERS ONLY
   =========================== */

app.post("/appeals", async (req, res) => {
  try {
    const { userId, username, reason } = req.body;

    if (!userId || !username || !reason || reason.length < 20) {
      return res.status(400).json({ error: "Invalid appeal" });
    }

    const user = await Users.findOne({ id: userId, username });
    if (!user || !user.banned) {
      return res
        .status(403)
        .json({ error: "Appeals allowed only for banned accounts" });
    }

    await Appeals.insertOne({
      id: crypto.randomUUID(),
      userId,
      username,
      reason,
      createdAt: new Date().toISOString(),
      status: "pending",
    });

    res.json({ success: true, message: "Appeal submitted" });
  } catch (err) {
    console.error("❌ Appeal Error:", err);
    res.status(500).json({ error: "Appeal failed" });
  }
});

/* ===========================
   USER ADMIN (BAN / UNBAN / ROLE / DELETE)
   =========================== */

// BAN USER
app.post("/users/:id/ban", async (req, res) => {
  try {
    const id = req.params.id;
    const reason = req.body.reason || "Manual ban";

    const result = await Users.updateOne(
      { id },
      {
        $set: {
          banned: true,
          banReason: reason,
          banDate: new Date().toISOString(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "User banned" });
  } catch (err) {
    console.error("❌ Ban User Error:", err);
    res.status(500).json({ error: "Failed to ban user" });
  }
});

// UNBAN USER
app.post("/users/:id/unban", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await Users.updateOne(
      { id },
      {
        $set: {
          banned: false,
          banReason: null,
          banDate: null,
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "User unbanned" });
  } catch (err) {
    console.error("❌ Unban User Error:", err);
    res.status(500).json({ error: "Failed to unban user" });
  }
});

// ASSIGN STAFF / ROLE + OPTIONAL TAG/ICON (for HA panel)
app.post("/users/:id/role", async (req, res) => {
  try {
    const { role, staffTag, staffIcon } = req.body;

    const update = {
      role: role || "user",
      staffTag: staffTag || null,
      staffIcon: staffIcon || null,
    };

    const result = await Users.updateOne(
      { id: req.params.id },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "Role updated" });
  } catch (err) {
    console.error("❌ Role Update Error:", err);
    res.status(500).json({ error: "Failed to update role" });
  }
});

// FETCH USER BY ID (SESSION / SETTINGS)
app.get("/users/:id", async (req, res) => {
  try {
    const user = await Users.findOne({ id: req.params.id });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      staffTag: user.staffTag || null,
      staffIcon: user.staffIcon || null,
      banned: !!user.banned,
      banReason: user.banReason || null,
      banDate: user.banDate || null,
      createdAt: user.createdAt,
      hwid: user.hwid || null,
      lastIP: user.lastIP || null,
      lastLoginAt: user.lastLoginAt || null,
    });
  } catch (err) {
    console.error("❌ User Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// DELETE USER + THEIR APPLICATIONS
app.delete("/users/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const userResult = await Users.deleteOne({ id });

    await Applications.deleteMany({ id }); // if applications store the user id too

    if (userResult.deletedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "User and associated applications deleted" });
  } catch (err) {
    console.error("❌ User Delete Error:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// GET ALL USERS (HA PANEL)
app.get("/users", async (req, res) => {
  try {
    const users = await Users.find({}).toArray();
    res.json(users);
  } catch (err) {
    console.error("❌ Users Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* ===========================
   FORUM: THREADS & REPLIES
   =========================== */

// CREATE THREAD (requires accepted department OR staff)
app.post("/threads", async (req, res) => {
  try {
    const { title, body, category, userId } = req.body;

    if (!title || title.length < 4)
      return res.status(400).json({ error: "Title too short" });
    if (!body || body.length < 10)
      return res.status(400).json({ error: "Body too short" });

    const user = await Users.findOne({ id: userId });
    if (!user) return res.status(401).json({ error: "Not logged in" });

    // USER MUST BE STAFF OR HAVE AN ACCEPTED DEPARTMENT
    const allowed = (await userHasDepartment(user.email)) || isStaff(user);
    if (!allowed)
      return res.status(403).json({
        error:
          "You must be staff or accepted into a department to create threads",
      });

    const thread = {
      id: crypto.randomUUID(),
      title,
      body,
      category: category || "general",
      authorId: user.id,
      createdAt: new Date().toISOString(),
      replies: 0,
    };

    await Threads.insertOne(thread);
    res.json({ success: true, thread });
  } catch (err) {
    console.error("❌ Create Thread Error:", err);
    res.status(500).json({ error: "Failed to create thread" });
  }
});


// GET THREADS BY CATEGORY (NOW WITH AUTHOR INFO)
app.get("/threads/:category", async (req, res) => {
  try {
    const threads = await Threads.find({
      category: req.params.category,
    })
      .sort({ createdAt: -1 })
      .toArray();

    // Collect author IDs
    const ids = threads.map((t) => t.authorId);
    const authors = await Users.find({ id: { $in: ids } }).toArray();
    const map = new Map(authors.map((u) => [u.id, u]));

    // Attach author objects to each thread
    const result = threads.map((t) => {
      const u = map.get(t.authorId);
      return {
        ...t,
        author: u
          ? {
              id: u.id,
              username: u.username,
              role: u.role,
              staffTag: u.staffTag || null,
              staffIcon: u.staffIcon || null,
            }
          : null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("❌ Fetch Threads Error:", err);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});


// GET SINGLE THREAD + ALL REPLIES WITH AUTHOR DATA
app.get("/thread/:id", async (req, res) => {
  try {
    const thread = await Threads.findOne({ id: req.params.id });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const replies = await Replies.find({ threadId: req.params.id })
      .sort({ createdAt: 1 })
      .toArray();

    const ids = [thread.authorId, ...replies.map((r) => r.authorId)].filter(
      Boolean
    );
    const authors = await Users.find({ id: { $in: ids } }).toArray();
    const map = new Map(authors.map((u) => [u.id, u]));

    const threadWithAuthor = {
      ...thread,
      author: (() => {
        const u = map.get(thread.authorId);
        if (!u) return null;
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          staffTag: u.staffTag || null,
          staffIcon: u.staffIcon || null,
        };
      })(),
    };

    const repliesWithAuthors = replies.map((r) => {
      const u = map.get(r.authorId);
      return {
        ...r,
        author: u
          ? {
              id: u.id,
              username: u.username,
              role: u.role,
              staffTag: u.staffTag || null,
              staffIcon: u.staffIcon || null,
            }
          : null,
      };
    });

    res.json({ thread: threadWithAuthor, replies: repliesWithAuthors });
  } catch (err) {
    console.error("❌ Fetch Thread Error:", err);
    res.status(500).json({ error: "Failed to fetch thread" });
  }
});


// CREATE REPLY (requires accepted department ONLY)
app.post("/thread/:id/reply", async (req, res) => {
  try {
    const { userId, body } = req.body;

    if (!body || body.length < 2)
      return res.status(400).json({ error: "Reply too short" });

    const user = await Users.findOne({ id: userId });
    if (!user) return res.status(401).json({ error: "Not logged in" });

    if (!(await userHasDepartment(user.email)))
      return res
        .status(403)
        .json({ error: "You must be in a department to reply" });

    const reply = {
      id: crypto.randomUUID(),
      threadId: req.params.id,
      authorId: user.id,
      body,
      createdAt: new Date().toISOString(),
    };

    await Replies.insertOne(reply);
    await Threads.updateOne({ id: req.params.id }, { $inc: { replies: 1 } });

    res.json({ success: true, reply });
  } catch (err) {
    console.error("❌ Create Reply Error:", err);
    res.status(500).json({ error: "Failed to create reply" });
  }
});


// DELETE THREAD (STAFF ONLY)
app.delete("/thread/:id", async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await Users.findOne({ id: userId });

    if (!user || !isStaff(user))
      return res.status(403).json({ error: "Staff only" });

    await Replies.deleteMany({ threadId: req.params.id });
    const result = await Threads.deleteOne({ id: req.params.id });

    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Thread not found" });

    res.json({ success: true, message: "Thread deleted" });
  } catch (err) {
    console.error("❌ Delete Thread Error:", err);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});


// DELETE REPLY (STAFF ONLY)
app.delete("/reply/:id", async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await Users.findOne({ id: userId });

    if (!user || !isStaff(user))
      return res.status(403).json({ error: "Staff only" });

    const reply = await Replies.findOne({ id: req.params.id });
    if (!reply) return res.status(404).json({ error: "Reply not found" });

    await Replies.deleteOne({ id: req.params.id });
    await Threads.updateOne(
      { id: reply.threadId },
      { $inc: { replies: -1 } }
    );

    res.json({ success: true, message: "Reply deleted" });
  } catch (err) {
    console.error("❌ Delete Reply Error:", err);
    res.status(500).json({ error: "Failed to delete reply" });
  }
});

/// GALLERY MODEL

// GET ALL GALLERY PHOTOS
app.get("/gallery", async (req, res) => {
  try {
    const photos = await Gallery.find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(photos);
  } catch (err) {
    console.error("Gallery GET error:", err);
    res.status(500).json({ error: "Failed to fetch gallery" });
  }
});

// UPLOAD PHOTO
app.post("/gallery", async (req, res) => {
  try {
    const { department, imageUrl, caption, author } = req.body;

    if (!department || !imageUrl || !author) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const item = {
      id: crypto.randomUUID(),
      department,
      imageUrl,
      caption: caption || "",
      author,
      createdAt: new Date().toISOString(),
    };

    await Gallery.insertOne(item);

    res.json({ success: true, item });
  } catch (err) {
    console.error("Gallery POST error:", err);
    res.status(500).json({ error: "Failed to upload photo" });
  }
});




/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));
