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
      "http://localhost:3000",
    ],
     methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
    allowedHeaders: ["Content-Type"],
  })
);

/* ===========================
   CONSTANTS
   =========================== */
const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const HAS_BREVO_KEY = !!process.env.BREVO_API_KEY;

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
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.ip || null;
}

function generateHWID() {
  return crypto.randomBytes(16).toString("hex");
}

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

app.get("/", (req, res) => res.send("Shore Roleplay Backend Online 🚀"));

app.post("/staff-auth", (req, res) => {
  if (!process.env.STAFF_PANEL_PASSWORD)
    return res.status(500).json({ error: "Staff password not set" });

  req.body.password === process.env.STAFF_PANEL_PASSWORD
    ? res.json({ success: true })
    : res.status(401).json({ error: "Invalid password" });
});

/* ===========================
   HEAD ADMIN PANEL AUTH
   =========================== */

app.post("/ha-auth", (req, res) => {
  const haPass = process.env.HEAD_ADMIN_PASSWORD;
  if (!haPass)
    return res
      .status(500)
      .json({ error: "HEAD_ADMIN_PASSWORD not set in environment" });

  req.body.password === haPass
    ? res.json({ success: true })
    : res.status(401).json({ error: "Invalid head admin password" });
});

/* ===========================
   APPLICATIONS
   =========================== */

app.get("/applications", async (req, res) => {
  try {
    const apps = await Applications.find({}).toArray();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

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

    if (!id || !username || !email || !department || !reason)
      return res.status(400).json({ error: "Missing fields" });

    if (reason.length < 100)
      return res.status(400).json({ error: "Reason too short" });

    const exists = await Applications.findOne({ $or: [{ id }, { email }] });
    if (exists) return res.status(409).json({ error: "Exists" });

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

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Internal" });
  }
});

app.post("/applications/:id/decision", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "denied"].includes(status))
      return res.status(400).json({ error: "Invalid" });

    const appData = await Applications.findOne({ id: req.params.id });
    if (!appData) return res.status(404).json({ error: "Not found" });

    await Applications.updateOne({ id: req.params.id }, { $set: { status } });
    await sendDecisionEmail(status, appData);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/applications/:id", async (req, res) => {
  try {
    const result = await Applications.deleteOne({ id: req.params.id });
    if (!result.deletedCount)
      return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   USERS
   =========================== */

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
    if (exists) return res.status(409).json({ error: "Used" });

    const hwid = generateHWID();
    const registrationIP = getClientIP(req);

    await Users.insertOne({
      id: crypto.randomUUID(),
      username,
      email,
      password,
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

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/login", async (req, res) => {
  try {
    const { email, password, hwid } = req.body;

    const user = await Users.findOne({ email, password });
    if (!user) return res.status(401).json({ error: "Invalid" });

    await Users.updateOne(
      { id: user.id },
      {
        $set: {
          lastLoginAt: new Date().toISOString(),
          lastIP: getClientIP(req),
          hwid: hwid || user.hwid || generateHWID(),
        },
      }
    );

    const hasDept = await Applications.findOne({
      email: user.email,
      status: "accepted",
    });

    res.json({
      success: true,
      message: "OK",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        hasDepartment: !!hasDept,
        department: hasDept ? hasDept.department : null,
        isStaff: isStaff(user),
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
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/change-username", async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id || !username || username.length < 3)
      return res.status(400).json({ error: "Invalid request" });

    const r = await Users.updateOne({ id }, { $set: { username } });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/update-password", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6)
      return res.status(400).json({ error: "Invalid" });

    const r = await Users.updateOne({ email }, { $set: { password } });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/update", async (req, res) => {
  try {
    const { id, bio, pfp } = req.body;
    if (!id) return res.status(400).json({ error: "Missing" });

    const update = {};
    if (bio !== undefined) update.bio = bio;
    if (pfp !== undefined) update.pfp = pfp;

    const r = await Users.updateOne({ id }, { $set: update });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   APPEALS
   =========================== */

app.post("/appeals", async (req, res) => {
  try {
    const { userId, username, reason } = req.body;
    if (!userId || !username || !reason || reason.length < 20)
      return res.status(400).json({ error: "Invalid" });

    const user = await Users.findOne({ id: userId, username });
    if (!user || !user.banned)
      return res.status(403).json({ error: "Not banned" });

    await Appeals.insertOne({
      id: crypto.randomUUID(),
      userId,
      username,
      reason,
      createdAt: new Date().toISOString(),
      status: "pending",
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

/* LIST ALL APPEALS (HA ONLY) */
app.get("/appeals", async (req, res) => {
  try {
    const appeals = await Appeals.find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json(appeals);
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});


/* ===========================
   USER ADMIN
   =========================== */

app.post("/users/:id/ban", async (req, res) => {
  try {
    const r = await Users.updateOne(
      { id: req.params.id },
      {
        $set: {
          banned: true,
          banReason: req.body.reason || "Manual ban",
          banDate: new Date().toISOString(),
        },
      }
    );

    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/:id/unban", async (req, res) => {
  try {
    const r = await Users.updateOne(
      { id: req.params.id },
      {
        $set: {
          banned: false,
          banReason: null,
          banDate: null,
        },
      }
    );

    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/users/:id/role", async (req, res) => {
  try {
    const r = await Users.updateOne(
      { id: req.params.id },
      {
        $set: {
          role: req.body.role || "user",
          staffTag: req.body.staffTag || null,
          staffIcon: req.body.staffIcon || null,
        },
      }
    );

    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/users/:id", async (req, res) => {
  try {
    const user = await Users.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: "Not found" });

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
      department: user.department || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const u = await Users.deleteOne({ id });
    await Applications.deleteMany({ id });

    if (!u.deletedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/users", async (req, res) => {
  try {
    res.json(await Users.find({}).toArray());
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   USER RESTRICT / UNRESTRICT (STAFF ONLY)
   =========================== */

app.patch("/users/:id/restrict", async (req, res) => {
  try {
    const { userId, restricted } = req.body;

    // Validate staff performing the action
    const staff = await Users.findOne({ id: userId });
    if (!staff || !isStaff(staff)) {
      return res.status(403).json({ error: "Staff only" });
    }

    const result = await Users.updateOne(
      { id: req.params.id },
      { $set: { restricted: !!restricted } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      success: true,
      message: `User ${restricted ? "restricted" : "unrestricted"}`,
    });
  } catch (err) {
    console.error("❌ Restrict Error:", err);
    res.status(500).json({ error: "Failed to update restriction" });
  }
});


/* ===========================
   FORUM
   =========================== */

app.post("/threads", async (req, res) => {
  try {
    const { title, body, category, userId } = req.body;

    if (!title || title.length < 4)
      return res.status(400).json({ error: "Title short" });
    if (!body || body.length < 10)
      return res.status(400).json({ error: "Body short" });

    const user = await Users.findOne({ id: userId });
    if (!user) return res.status(401).json({ error: "Not logged in" });

    if (!(await userHasDepartment(user.email)) && !isStaff(user))
      return res.status(403).json({
        error:
          "You must be staff or accepted into a department to create threads",
      });

    const t = {
      id: crypto.randomUUID(),
      title,
      body,
      category: category || "general",
      authorId: user.id,
      createdAt: new Date().toISOString(),
      replies: 0,
    };

    await Threads.insertOne(t);
    res.json({ success: true, thread: t });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/threads/:category", async (req, res) => {
  try {
    const threads = await Threads.find({
      category: req.params.category,
    })
      .sort({ createdAt: -1 })
      .toArray();

    const ids = threads.map((x) => x.authorId);
    const authors = await Users.find({ id: { $in: ids } }).toArray();
    const map = new Map(authors.map((u) => [u.id, u]));

    res.json(
      threads.map((t) => {
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
      })
    );
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/thread/:id", async (req, res) => {
  try {
    const thread = await Threads.findOne({ id: req.params.id });
    if (!thread) return res.status(404).json({ error: "Not found" });

    const replies = await Replies.find({ threadId: req.params.id })
      .sort({ createdAt: 1 })
      .toArray();

    const ids = [thread.authorId, ...replies.map((r) => r.authorId)];
    const authors = await Users.find({ id: { $in: ids } }).toArray();
    const map = new Map(authors.map((u) => [u.id, u]));

    const t = {
      ...thread,
      author: (() => {
        const u = map.get(thread.authorId);
        return u
          ? {
              id: u.id,
              username: u.username,
              role: u.role,
              staffTag: u.staffTag || null,
              staffIcon: u.staffIcon || null,
            }
          : null;
      })(),
    };

    res.json({
      thread: t,
      replies: replies.map((r) => {
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
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/thread/:id/reply", async (req, res) => {
  try {
    const { userId, body } = req.body;
    if (!body || body.length < 2)
      return res.status(400).json({ error: "Short" });

    const user = await Users.findOne({ id: userId });
    if (!user) return res.status(401).json({ error: "Not logged in" });

    if (!(await userHasDepartment(user.email)))
      return res.status(403).json({ error: "Must be in dept" });

    const r = {
      id: crypto.randomUUID(),
      threadId: req.params.id,
      authorId: user.id,
      body,
      createdAt: new Date().toISOString(),
    };

    await Replies.insertOne(r);
    await Threads.updateOne({ id: req.params.id }, { $inc: { replies: 1 } });

    res.json({ success: true, reply: r });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/thread/:id", async (req, res) => {
  try {
    const user = await Users.findOne({ id: req.body.userId });
    if (!user || !isStaff(user))
      return res.status(403).json({ error: "Staff only" });

    await Replies.deleteMany({ threadId: req.params.id });
    const r = await Threads.deleteOne({ id: req.params.id });

    if (!r.deletedCount) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/reply/:id", async (req, res) => {
  try {
    const user = await Users.findOne({ id: req.body.userId });
    if (!user || !isStaff(user))
      return res.status(403).json({ error: "Staff only" });

    const reply = await Replies.findOne({ id: req.params.id });
    if (!reply) return res.status(404).json({ error: "Not found" });

    await Replies.deleteOne({ id: req.params.id });
    await Threads.updateOne(
      { id: reply.threadId },
      { $inc: { replies: -1 } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   GALLERY
   =========================== */

app.get("/gallery", async (_, res) => {
  try {
    res.json(await Gallery.find({}).sort({ createdAt: -1 }).toArray());
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/gallery", async (req, res) => {
  try {
    const { department, imageUrl, caption, author } = req.body;
    if (!department || !imageUrl || !author)
      return res.status(400).json({ error: "Missing" });

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
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));

