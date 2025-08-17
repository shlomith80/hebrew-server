import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import cors from "cors";

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const file = fs.createReadStream(req.file.path);
    const transcript = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    fs.unlink(req.file.path, () => {}); // מוחק את הקובץ הזמני אחרי השימוש
    res.json({ text: transcript.text });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
