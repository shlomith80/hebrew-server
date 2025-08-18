// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "User-Agent": "hebrew-transcriber/1.0" },
});

// פונקציית עזר עם retries במקרה של ECONNRESET
async function transcribeWithRetry(filePath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
      });
    } catch (err) {
      console.error(`⚠️ ניסיון ${i + 1} נכשל:`, err.message);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // backoff
    }
  }
}


app.get("/health", (req, res) => {
  res.json({ ok: true, hasKey: !!process.env.OPENAI_API_KEY });
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
 if (!req.file) {
    return res.status(400).json({ error: "Missing file field 'file'" });
  }

  // קח את הסיומת מהשם המקורי (למשל ".mp3")
  const ext = path.extname(req.file.originalname || "");
  const srcPath = req.file.path;
  const pathWithExt = ext ? `${srcPath}${ext}` : srcPath;

  try {
    // אם יש סיומת – שנה את שם הקובץ הזמני כך שתכלול אותה
    if (ext) {
      fs.renameSync(srcPath, pathWithExt);
    }

    const transcript = await transcribeWithRetry(pathWithExt);

    // ניקוי קובץ זמני
    fs.unlink(pathWithExt, () => {});
    res.json({ text: transcript.text });
  } catch (err) {
    console.error("❌ OpenAI call failed:", err);
    // ניקוי גם במקרה שגיאה
    try { fs.unlinkSync(pathWithExt); } catch {}
    res.status(502).json({ error: "OpenAI connection failed", detail: String(err) });
  }
});