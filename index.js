// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());

// ---- הגדרות אחסון להקלטות ----
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true }); // ודא שהתיקייה קיימת

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(8).toString("hex");
    const base = (file.originalname || "speech").replace(/[^\w\-]+/g, "_").slice(0, 40);
    // שמירה על סיומת אם קיימת, אחרת m4a
    const ext = (path.extname(file.originalname || "") || ".m4a").toLowerCase();
    cb(null, `${Date.now()}_${id}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // עד 25MB
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

// ---- Routes ----
app.get("/health", (_req, res) => {
  res.json({ ok: true, hasKey: !!process.env.OPENAI_API_KEY, uploadDir: UPLOAD_DIR });
});

// רשימת קבצים שנשמרו
app.get("/files", async (_req, res) => {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    files.sort(); // אופציונלי: לפי שם/זמן
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: "Cannot list files", detail: String(e) });
  }
});

// הורדה/הזרמה של קובץ
app.get("/files/:name", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  // הערכת תוכן בסיסית לפי סיומת
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".wav" ? "audio/wav" : ext === ".mp3" ? "audio/mpeg" : "audio/m4a";
  res.setHeader("Content-Type", type);
  fs.createReadStream(filePath).pipe(res);
});

// קבלת הקלטה, שמירה, תמלול (הקובץ נשאר שמור)
app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });
    const savedPath = req.file.path; // נשמר כבר ב-UPLOAD_DIR
    const result = await transcribeWithRetry(savedPath);
    res.json({ text: result.text || "", file: path.basename(savedPath) });
  } catch (err) {
    console.error("OpenAI call failed:", err);
    res.status(502).json({ error: "OpenAI connection failed", detail: String(err) });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}, saving files in: ${UPLOAD_DIR}`);
});
