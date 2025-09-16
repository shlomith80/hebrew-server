// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import OpenAI from "openai";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { randomUUID } from "node:crypto";
import os from "node:os";

const app = express();

// Multer: קובץ זמני (על דיסק אפמרלי). אל תשימי כאן את DATA_DIR.
const upload = multer({ dest: "uploads/" });

app.use(cors());

// === בדיקת מפתח ===
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
}

// === לקוח OpenAI ===
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "User-Agent": "hebrew-transcriber/1.0" },
});

// === נתיבי עבודה ===
// DATA_DIR: דיסק קבוע (Render Disk) – כאן ישמרו הקלטות והמטא-דטה
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data", "letters");
// CONVERT_DIR: תיקייה זמנית להמרות (בדרך כלל /tmp ברנדר, אפמרלי)
const CONVERT_DIR = process.env.CONVERT_DIR || path.join(os.tmpdir(), "uploads_conv");

fs.mkdirSync(CONVERT_DIR, { recursive: true });

// === עזר: המרה ל-WAV 16kHz מונו PCM ===
const execFileAsync = promisify(execFile);
async function toWav16kMono(inPath, outPath) {
  await execFileAsync(ffmpegPath, [
    "-y", "-i", inPath,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    outPath
  ]);
  return outPath;
}

// === תמלול עם ריטריי ===
async function transcribeWithRetry(filePath, retries = 3) {
  const model = process.env.STT_MODEL || "whisper-1"; // אפשר להחליף ל-"gpt-4o-mini-transcribe"
  for (let i = 0; i < retries; i++) {
    try {
      return await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model,
        language: "he",
      });
    } catch (err) {
      console.error(`⚠️ ניסיון ${i + 1} נכשל:`, err.message);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // backoff
    }
  }
}

// === בריאות ===
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.OPENAI_API_KEY,
    dataDir: DATA_DIR
  });
});

// === API: /transcribe ===
// שדות נתמכים בטופס: file (חובה), label, speaker_id, session_id, recorded_at, save=1
app.post("/transcribe", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

  const label = (req.body.label || "").trim();           // למשל "א"
  const speakerId = (req.body.speaker_id || "").trim();  // למשל "child_001"
  const sessionId = (req.body.session_id || "").trim();
  const recordedAt = (req.body.recorded_at || "").trim();
  const doSave = req.body.save === "1" || (label && speakerId); // לשמור אם ביקשו מפורשות או אם יש תוויות

  const ext = path.extname(req.file.originalname || "");
  const srcPath = req.file.path;
  const srcWithExt = ext ? `${srcPath}${ext}` : srcPath;

  try {
    // נצרף סיומת אם הועברה (נוח ל-debug)
    if (ext) fs.renameSync(srcPath, srcWithExt);

    // 1) המרה ל-WAV תקני (ב-CONVERT_DIR הזמני)
    fs.mkdirSync(CONVERT_DIR, { recursive: true });
    const tmpWav = path.join(CONVERT_DIR, `${path.basename(srcWithExt)}.wav`);
    await toWav16kMono(srcWithExt, tmpWav);

    // 2) תמלול מה-WAV המומר
    const transcript = await transcribeWithRetry(tmpWav);

    // 3) שמירה לדאטהסט (על הדיסק הקבוע) אם צריך
    let savedPath = null;
    let meta = null;
    if (doSave) {
      const date = new Date().toISOString().slice(0, 10);      // YYYY-MM-DD
      const id = randomUUID();
      const outDir = path.join(DATA_DIR, speakerId || "unknown_speaker", label || "unknown_label", date);
      await fs.promises.mkdir(outDir, { recursive: true });
      savedPath = path.join(outDir, `${id}.wav`);

      // מזיזים את ה-WAV המומר לנתיב הקבוע (move)
      fs.renameSync(tmpWav, savedPath);

      // 4) רישום מטא-דטה לשורת JSONL (לידי DATA_DIR)
      meta = {
        id,
        path: savedPath,
        label: label || null,
        speaker_id: speakerId || null,
        session_id: sessionId || null,
        recorded_at: recordedAt || null,
        stored_at: new Date().toISOString()
      };
      const metaFile = path.join(DATA_DIR, "metadata.jsonl");
      await fs.promises.appendFile(metaFile, JSON.stringify(meta) + "\n", "utf8");
    } else {
      // אם לא שומרים — מנקים את הקובץ המומר
      try { fs.unlinkSync(tmpWav); } catch {}
    }

    // 5) ניקוי קובץ המקור הזמני
    try { fs.unlinkSync(srcWithExt); } catch {}

    // 6) תשובה
    res.json({
      ok: true,
      text: transcript?.text || "",
      saved: !!savedPath,
      wav_path: savedPath || undefined,
      label: label || undefined,
      speaker_id: speakerId || undefined,
      session_id: sessionId || undefined,
      metadata: meta || undefined
    });
  } catch (err) {
    console.error("Transcribe/store failed:", err);
    // ניקוי שאריות במקרה שגיאה
    try { fs.unlinkSync(srcWithExt); } catch {}
    res.status(502).json({ error: "Transcribe/store failed", detail: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📁 DATA_DIR: ${DATA_DIR}`);
});
