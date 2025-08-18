// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import OpenAI from "openai";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "User-Agent": "hebrew-transcriber/1.0" },
});


async function transcribeWithRetry(filePath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        language: "he", 
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

  const ext = path.extname(req.file.originalname || "");
  const srcPath = req.file.path;
  const pathWithExt = ext ? `${srcPath}${ext}` : srcPath;

  try {
    if (ext) {
      fs.renameSync(srcPath, pathWithExt);
    }

    const transcript = await transcribeWithRetry(pathWithExt);

    fs.unlink(pathWithExt, () => {});
    res.json({ text: transcript.text });
  } catch (err) {
    console.error("OpenAI call failed:", err);
    try { fs.unlinkSync(pathWithExt); } catch {}
    res.status(502).json({ error: "OpenAI connection failed", detail: String(err) });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
