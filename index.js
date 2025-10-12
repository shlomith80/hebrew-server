// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import OpenAI from "openai";
import { Pool } from "pg";

const app = express();
app.use(cors());
// לא חובה ל-/transcribe (multer קורא את ה-body של multipart), אבל טוב לשאר ראוטים
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- אחסון הקלטות (Render Disk או לוקאלי) ----
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(8).toString("hex");
    const base = (file.originalname || "speech").replace(/[^\w\-]+/g, "_").slice(0, 40);
    const ext = (path.extname(file.originalname || "") || ".m4a").toLowerCase();
    cb(null, `${Date.now()}_${id}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio/* files are allowed"));
  },
});

// ---- OpenAI ----
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
}
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "User-Agent": "hebrew-transcriber/1.0" },
});

async function transcribeWithRetry(filePath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        language: "he",
      });
    } catch (err) {
      console.error(`⚠️ ניסיון ${i + 1} נכשל:`, err.message || err);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ---- Postgres ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // שימי כאן את External Database URL מרנדר (ב-Environment)
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL missing – DB features are disabled");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordings (
      id BIGSERIAL PRIMARY KEY,
      letter     TEXT NOT NULL,
      filename   TEXT NOT NULL,
      url        TEXT NOT NULL,
      transcript TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS recordings_created_at_idx ON recordings(created_at DESC);
  `);
}
initDb().catch((e) => console.error("DB init failed:", e));

// ---- helpers ----
function getPublicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}
function guessContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".aac") return "audio/m4a";
  return "audio/octet-stream";
}

// ---- Routes ----
app.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    if (process.env.DATABASE_URL) {
      await pool.query("select 1");
      dbOk = true;
    }
  } catch {}
  res.json({ ok: true, hasKey: !!process.env.OPENAI_API_KEY, uploadDir: UPLOAD_DIR, db: dbOk });
});

// רשימת קבצים בדיסק (לבדיקות)
app.get("/files", async (_req, res) => {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    files.sort();
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: "Cannot list files", detail: String(e) });
  }
});

// הורדה/הזרמה של קובץ
app.get("/files/:name", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", guessContentType(filePath));
  fs.createReadStream(filePath).pipe(res);
});

// קבלת הקלטה + אות -> תמלול -> שמירה ב-DB והחזרה ללקוח
// לקליינט: שלחו multipart/form-data עם: file (audio/*) + letter
app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

    const letter = (req.body?.letter || "").trim(); // ← האות שנשלחה מהאפליקציה
    const savedPath = req.file.path;                // נשמר כבר ב-UPLOAD_DIR
    const filename = path.basename(savedPath);

    // תמלול
    const tr = await transcribeWithRetry(savedPath);
    const transcript = tr?.text || "";

    // URL ציבורי לקובץ (עובד מאחורי פרוקסי של Render)
    const baseUrl = getPublicBaseUrl(req);
    const url = `${baseUrl}/files/${filename}`;

    // אם מוגדר DB – שמרי רשומה והחזירי אותה
    if (process.env.DATABASE_URL) {
      const q = await pool.query(
        `INSERT INTO recordings (letter, filename, url, transcript)
         VALUES ($1,$2,$3,$4)
         RETURNING id, letter, filename, url, transcript, created_at`,
        [letter, filename, url, transcript]
      );
      return res.json(q.rows[0]);
    }

    // ללא DB – החזר אובייקט בסיסי
    res.json({ id: null, letter, filename, url, transcript, created_at: new Date().toISOString() });
  } catch (err) {
    console.error("OpenAI call failed:", err);
    res.status(502).json({ error: "OpenAI connection failed", detail: String(err) });
  }
});

// (אופציונלי) רשימת רשומות מה-DB
app.get("/recordings", async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB not configured" });
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const rows = (await pool.query(
      `SELECT id, letter, filename, url, transcript, created_at
       FROM recordings
       ORDER BY created_at DESC
       LIMIT $1`, [limit]
    )).rows;
    res.json({ recordings: rows });
  } catch (e) {
    res.status(500).json({ error: "Query failed", detail: String(e) });
  }
});

// (אופציונלי) ההקלטה האחרונה
app.get("/last", async (_req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB not configured" });
    const rows = (await pool.query(
      `SELECT id, letter, filename, url, transcript, created_at
       FROM recordings
       ORDER BY created_at DESC
       LIMIT 1`
    )).rows;
    if (!rows.length) return res.status(404).json({ error: "No recordings" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Query failed", detail: String(e) });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}, saving files in: ${UPLOAD_DIR}`);
});
