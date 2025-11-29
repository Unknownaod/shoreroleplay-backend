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

// ADD PendingUsers HERE ⬇
let db, Applications, Users, PendingUsers, Appeals, Threads, Replies, Gallery;

async function initDB() {
  await client.connect();
  db = client.db("shoreRoleplay");

  // MAIN COLLECTIONS
  Applications = db.collection("applications");
  Users = db.collection("users");
  Appeals = db.collection("appeals");
  Threads = db.collection("threads");
  Replies = db.collection("replies");
  Gallery = db.collection("gallery");

  // 🆕 REQUIRED FOR EMAIL VERIFICATION FLOW
  PendingUsers = db.collection("pendingUsers");

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

const {
  acceptedEmail,
  deniedEmail,
  verifyEmail
} = require("./emailTemplates");

/* ============================================================
   SEND DECISION EMAILS (APPLICATION STATUS)
   ============================================================ */

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
   APPLICATIONS (ORIGINAL)
   =========================== */

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

    // PREVENT SAME APPLICATION ID, BUT ALLOW MULTIPLE APPLICATIONS
    // just ensure they don't submit the same ID twice
    const exists = await Applications.findOne({ id });
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
    console.error("❌ APPLY ERROR:", err);
    res.status(500).json({ error: "Internal" });
  }
});


/* Decide on an application */
app.post("/applications/:id/decision", async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, reason } = req.body;

    // Validate input
    if (!["accepted", "denied"].includes(decision)) {
      return res.status(400).json({ error: "Invalid decision type" });
    }

    // Find application
    const appDoc = await Applications.findOne({ id: id });
    if (!appDoc) {
      return res.status(404).json({ error: "Application not found" });
    }

    // Update application
    await Applications.updateOne(
      { id: id },
      {
        $set: {
          status: decision,
          decisionReason: reason || null,
          decisionDate: new Date(),
        },
      }
    );

    res.json({ message: `Application ${decision} successfully.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update application decision" });
  }
});


/* Get all applications for a specific user by email */
app.get("/applications/user/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const apps = await Applications.find({ email }).sort({ submittedAt: -1 }).toArray();
    res.json(apps);
  } catch (err) {
    console.error("APPLICATION FETCH ERROR:", err);
    res.status(500).json({ error: "Failed to fetch applications" });
  }
});

/* ===========================
   APPLICATION FILTER ROUTES
   =========================== */

/* Get ONLY pending apps */
app.get("/applications/pending", async (req, res) => {
  try {
    const apps = await Applications.find({ status: "pending" })
      .sort({ submittedAt: -1 })
      .toArray();

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch pending applications" });
  }
});

/* Get ONLY previous (accepted/denied) apps */
app.get("/applications/history", async (req, res) => {
  try {
    const apps = await Applications.find({ status: { $ne: "pending" } })
      .sort({ submittedAt: -1 })
      .toArray();

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch application history" });
  }
});

/* ===============================================
   GET APPLICATIONS BY USER EMAIL
   Used by forums + profile pages
   =============================================== */
app.get("/applications/user/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const apps = await Applications.find({ email }).sort({ submittedAt: -1 }).toArray();
    res.json(apps);
  } catch (err) {
    console.error("User application lookup failed:", err);
    res.status(500).json({ error: "Lookup failed" });
  }
});


/* ===========================
   DELETE APPLICATION (STAFF ONLY)
   =========================== */
app.delete("/applications/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure staff is performing this action
    const staff = await Users.findOne({ id: req.body.userId });
    if (!staff || !isStaff(staff)) {
      return res.status(403).json({ error: "Staff only" });
    }

    const result = await Applications.deleteOne({ id });

    if (!result.deletedCount) {
      return res.status(404).json({ error: "Application not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ APP DELETE ERROR:", err);
    res.status(500).json({ error: "Failed to delete application" });
  }
});

/* ===========================
   APPLICATIONS – REQUIRED ENDPOINT
   =========================== */

app.get("/applications", async (req, res) => {
  try {
    const apps = await Applications.find({})
      .sort({ submittedAt: -1 })
      .toArray();
    res.json(apps);
  } catch (err) {
    console.error("❌ Failed to load applications:", err);
    res.status(500).json({ error: "Failed to load applications" });
  }
});


/* ===========================
   USERS
   =========================== */

app.post("/users/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!username || username.length < 3)
      return res.status(400).json({ error: "Bad username" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Bad email" });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Bad password" });

    // =========================
    // CHECK IF ALREADY A REAL USER
    // =========================
    const exists = await Users.findOne({ email });
    if (exists)
      return res.status(409).json({ error: "Email already registered" });

    // =========================
    // REMOVE ANY OLD PENDING ACCOUNT
    // =========================
    await PendingUsers.deleteMany({ email });

    // =========================
    // CREATE VERIFICATION TOKEN
    // =========================
    const token = crypto.randomBytes(32).toString("hex");

    await PendingUsers.insertOne({
      username,
      email,
      password,        // stored temporarily UNTIL verification
      token,
      createdAt: new Date(),
      ip: getClientIP(req)
    });

    // =========================
    // SEND VERIFICATION EMAIL
    // =========================
    if (!brevoApi) {
      console.log("📨 DEV MODE — Verification email skipped:", email, token);
    } else {
      const { verifyEmail } = require("./emailTemplates");

      const mail = new Brevo.SendSmtpEmail();
      mail.sender = { name: FROM_NAME, email: FROM_EMAIL };
      mail.to = [{ email, name: username }];
      mail.subject = "Verify Your Shore Roleplay Account";
      mail.htmlContent = verifyEmail({ username, token });

      await brevoApi.sendTransacEmail(mail);
    }

    // =========================
    // RETURN SUCCESS (NO ACCOUNT CREATED YET)
    // =========================
    res.json({
      success: true,
      message:
        "Verification email sent. Your account will be created after email confirmation."
    });

  } catch (err) {
    console.error("❌ REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});


app.post("/users/login", async (req, res) => {
  try {
    const { email, password, hwid } = req.body;

    // Check user credentials
    const user = await Users.findOne({ email, password });
    if (!user)
      return res.status(401).json({ error: "Invalid email or password" });

    // 🚫 BLOCK UNVERIFIED ACCOUNTS
    if (!user.verified) {
      return res.status(403).json({
        error: "Please verify your email before logging in"
      });
    }

    // Update login metadata
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

    // Determine department membership
    const hasDept = await Applications.findOne({
      email: user.email,
      status: "accepted",
    });

    // Return authorized session
    return res.json({
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
    console.error("❌ LOGIN ERROR:", err);
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

/// VERIFICATION TOKENS

app.get("/users/verify/:token", async (req, res) => {
  try {
    const token = req.params.token;

    // 1) Find pending registration
    const pending = await PendingUsers.findOne({ token });

    if (!pending) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired verification link"
      });
    }

    // 2) Double-check no real account already exists
    const exists = await Users.findOne({ email: pending.email });
    if (exists) {
      // Cleanup stale pending registrations
      await PendingUsers.deleteOne({ _id: pending._id });
      return res.status(409).json({
        success: false,
        error: "Account already exists"
      });
    }

    // 3) Create real account now
    const userId = crypto.randomUUID();
    const hwid = generateHWID();

    await Users.insertOne({
      id: userId,
      username: pending.username,
      email: pending.email,
      password: pending.password, // 👈 You already store plain text passwords
                                 //    consider hashing later
      role: "user",
      staffTag: null,
      staffIcon: null,

      banned: false,
      banReason: null,
      banDate: null,

      createdAt: new Date().toISOString(),
      lastIP: pending.ip || null,
      lastLoginAt: null,
      hwid,
      verified: true, // 🚀 IMPORTANT
    });

    // 4) Remove pending entry
    await PendingUsers.deleteOne({ _id: pending._id });

    // 5) Respond with success
    return res.json({
      success: true,
      message: "Account verified successfully. You can now log in."
    });

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Server error during verification"
    });
  }
});



/* ===========================
   APPEALS SYSTEM
   =========================== */

/* CREATE APPEAL (User must be banned) */
app.post("/appeals", async (req, res) => {
  try {
    const { userId, username, reason } = req.body;

    if (!userId || !username || !reason || reason.trim().length < 20)
      return res.status(400).json({ error: "Reason must be at least 20 characters." });

    const user = await Users.findOne({ id: userId });

    if (!user)
      return res.status(404).json({ error: "User not found." });

    if (!user.banned)
      return res.status(403).json({ error: "User is not banned." });

    // Prevent multiple pending appeals
    const existing = await Appeals.findOne({ userId, status: "pending" });
    if (existing)
      return res.status(409).json({ error: "You already have a pending appeal." });

    await Appeals.insertOne({
      id: crypto.randomUUID(),
      userId,
      username,
      reason,
      createdAt: new Date().toISOString(),
      status: "pending",
      handledBy: null,
      handledAt: null
    });

    res.json({ success: true });
  } catch (err) {
    console.error("APPEAL CREATE ERROR:", err);
    res.status(500).json({ error: "Failed to submit appeal." });
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
    console.error("APPEAL LIST ERROR:", err);
    res.status(500).json({ error: "Failed to fetch appeals." });
  }
});

/* SET APPEAL DECISION (accept / deny) */
app.post("/appeals/:id/decision", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staffUser } = req.body; // staffUser.username or ID

    if (!["accepted", "denied"].includes(status))
      return res.status(400).json({ error: "Invalid status." });

    const appeal = await Appeals.findOne({ id });
    if (!appeal)
      return res.status(404).json({ error: "Appeal not found." });

    await Appeals.updateOne(
      { id },
      { $set: {
          status,
          handledBy: staffUser || "Unknown Staff",
          handledAt: new Date().toISOString()
        } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("APPEAL DECISION ERROR:", err);
    res.status(500).json({ error: "Failed to update appeal status." });
  }
});

/* UNBAN USER WHEN APPEAL ACCEPTED */
app.post("/appeals/:id/unban", async (req, res) => {
  try {
    const { id } = req.params;
    const appeal = await Appeals.findOne({ id });

    if (!appeal)
      return res.status(404).json({ error: "Appeal not found." });

    await Users.updateOne(
      { id: appeal.userId },
      { $set: { banned: false, banReason: null } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("APPEAL UNBAN ERROR:", err);
    res.status(500).json({ error: "Failed to unban user." });
  }
});

/* DELETE APPEAL (HA ONLY) */
app.delete("/appeals/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Appeals.deleteOne({ id });

    if (result.deletedCount === 0)
      return res.status(404).json({ success: false, error: "Appeal not found." });

    res.json({ success: true });
  } catch (err) {
    console.error("APPEAL DELETE ERROR:", err);
    res.status(500).json({ success: false, error: "Failed to delete appeal." });
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

    // fetch ALL accepted applications for the user
    const acceptedApps = await Applications.find(
      { email: user.email, status: "accepted" },
      { projection: { department: 1, _id: 0 } }
    ).toArray();

    const departments = acceptedApps.map(a => a.department);

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
      lastIP: user.lastIP || null,
      lastLoginAt: user.lastLoginAt || null,

      // 🆕 RETURN HWID SO FRONTEND CAN DISPLAY IT
      hwid: user.hwid || null,

      // 🚨 MULTIPLE DEPARTMENTS SUPPORT
      departments,

      // backward compatibility for old pages
      department: departments[0] || null
    });

  } catch (err) {
    console.log(err);
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

// Accepted department IDs (must match frontend)
const VALID_DEPARTMENTS = {
  "Police Department": "pd",
  "PD": "pd",
  "Sheriff's Office": "sd",
  "SO": "sd",
  "State Patrol": "sp",
  "State Police": "sp",
  "SP": "sp",
  "Fire & Rescue": "fire",
  "Fire Department": "fire",
  "FIRE": "fire",
  "EMS": "ems",
  "Civilian Media": "civ",
  "Civilian Operations": "civ",
  "CIV": "civ"
};

/* ---------- GET ALL GALLERY ITEMS ---------- */
/* ===========================
   GALLERY (ORIGINAL)
   =========================== */

app.get("/gallery", async (_, res) => {
  try {
    const items = await Gallery.find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json(items);
  } catch (err) {
    console.error("❌ GALLERY FETCH ERROR:", err);
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
      department,         // ← stored exactly how frontend sends it
      imageUrl,
      caption: caption || "",
      author,
      createdAt: new Date().toISOString(),
    };

    await Gallery.insertOne(item);
    res.json({ success: true, item });
  } catch (err) {
    console.error("❌ GALLERY POST ERROR:", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));

