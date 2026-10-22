const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const COOKIE_FILE = "/etc/secrets/cookies.txt";
const YOUTUBE_COOKIE_FILE = fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null;

app.set("trust proxy", true);
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));

const STORE = path.join(os.tmpdir(), "voxscript-audio");
fs.mkdirSync(STORE, { recursive: true });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-5000) || `${command} exited with code ${code}`));
    });
  });
}

function isYouTubeUrl(value) {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com", "music.youtube.com"].includes(h);
  } catch {
    return false;
  }
}

function publicUrl(req, id) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/audio/${encodeURIComponent(id)}`;
}

async function extractFullAudio(url) {
  const id = crypto.randomUUID();
  const out = path.join(STORE, `${id}.mp3`);

  // yt-dlp gets the best available audio stream and FFmpeg converts it to one complete MP3.
  const ytArgs = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "128K",
    "--ffmpeg-location", "/usr/bin/ffmpeg",
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player-client=mweb",
    "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
    "-o", path.join(STORE, `${id}.%(ext)s`),
    url
  ];

  // Render Secret Files are read-only. yt-dlp may update its cookie jar, so
  // copy the secret to a writable temporary file and give that copy to yt-dlp.
  // Never commit personal YouTube cookies to GitHub.
  let tempCookieFile = null;
  try {
    if (YOUTUBE_COOKIE_FILE) {
      tempCookieFile = path.join(STORE, `${id}-cookies.txt`);
      fs.copyFileSync(YOUTUBE_COOKIE_FILE, tempCookieFile);
      ytArgs.splice(1, 0, "--cookies", tempCookieFile);
    }

    await run("yt-dlp", ytArgs, { env: { ...process.env } });
  } finally {
    if (tempCookieFile) {
      try { fs.rmSync(tempCookieFile, { force: true }); } catch {}
    }
  }

  if (!fs.existsSync(out)) throw new Error("The complete audio file was not created.");
  const stat = fs.statSync(out);
  if (!stat.size) throw new Error("The extracted audio file is empty.");

  return { id, path: out, size: stat.size };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function transcribeFile(filePath, language, attempt = 1) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured on Render.");
  const form = new FormData();
  form.append("model", "whisper-large-v3");
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }), path.basename(filePath));
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  form.append("prompt", "Verbatim transcript, including repeated words and lyrics.");
  if (language && language !== "auto") form.append("language", language);

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form
  });

  // Retry on rate limits / temporary Groq errors.
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    const wait = Math.min(Number(response.headers.get("retry-after")) || attempt * 15, 90);
    await sleep(wait * 1000);
    return transcribeFile(filePath, language, attempt + 1);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || "Groq transcription failed.");
  return data;
}

async function transcribeCompleteAudio(filePath, language, onProgress = () => {}) {
  const CHUNK = 300; // 5-minute pieces. The original full MP3 stays untouched for playback/download.
  const chunkDir = fs.mkdtempSync(path.join(STORE, "chunks-"));
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", filePath,
      "-f", "segment", "-segment_time", String(CHUNK), "-reset_timestamps", "1",
      "-c", "copy", path.join(chunkDir, "chunk-%03d.mp3")]);
    const files = fs.readdirSync(chunkDir).filter(n => n.endsWith(".mp3")).sort();
    if (!files.length) throw new Error("Could not split the audio for transcription.");

    const texts = [], segments = [], words = [], missing = [];
    let detected = null;
    for (let i = 0; i < files.length; i++) {
      const offset = i * CHUNK;
      onProgress(`Transcribing part ${i + 1} of ${files.length}…`);
      try {
        const d = await transcribeFile(path.join(chunkDir, files[i]), language);
        detected = detected || d.language;
        if (d.text) texts.push(d.text.trim());
        for (const s of d.segments || []) segments.push({ ...s, start: Number(s.start || 0) + offset, end: Number(s.end || 0) + offset });
        for (const w of d.words || []) words.push({ ...w, start: Number(w.start || 0) + offset, end: Number(w.end || 0) + offset });
      } catch (e) {
        missing.push({ part: i + 1, from: offset, error: e.message });
        texts.push(`[Part ${i + 1} (${fmt(offset)}–${fmt(offset + CHUNK)}) failed: ${e.message}]`);
      }
    }
    return { text: texts.join("\n"), language: detected || language || "auto",
             duration: files.length * CHUNK, segments, words, missing };
  } finally {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

// Only one heavy job at a time (Render free plan has little RAM).
let busy = false;
const jobs = new Map();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "VoxScript full-audio backend" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/extract", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !isYouTubeUrl(url)) {
      return res.status(400).json({ error: "Please enter a valid YouTube link." });
    }

    if (busy) return res.status(429).json({ error: "Server is busy with another job. Try again in a minute." });
    busy = true;
    let result;
    try { result = await extractFullAudio(url); } finally { busy = false; }
    const filename = `voxscript-${result.id}.mp3`;

    res.json({
      audioUrl: publicUrl(req, result.id),
      downloadUrl: `${publicUrl(req, result.id)}?download=1`,
      filename,
      fileSize: result.size,
      format: "mp3",
      completeAudio: true
    });
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(502).json({ error: error?.message || "YouTube audio extraction failed." });
  }
});

app.post("/transcribe", (req, res) => {
  const { url, language } = req.body || {};
  if (!url || !isYouTubeUrl(url)) return res.status(400).json({ error: "Please enter a valid YouTube link." });
  if (busy) return res.status(429).json({ error: "Server is busy with another job. Try again in a minute." });
  busy = true;

  const jobId = crypto.randomUUID();
  const job = { status: "running", progress: "Extracting audio from YouTube…", created: Date.now() };
  jobs.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      const ex = await extractFullAudio(url);
      job.audioUrl = publicUrl(req, ex.id);
      job.downloadUrl = `${job.audioUrl}?download=1`;
      job.filename = `voxscript-${ex.id}.mp3`;
      job.progress = "Audio ready. Starting transcription…";
      const d = await transcribeCompleteAudio(ex.path, language, m => { job.progress = m; });
      job.result = {
        transcript: d.text, language: d.language, duration: d.duration,
        segments: d.segments, words: d.words, missing: d.missing,
        source: "youtube-full-audio-render-groq-whisper",
        audioUrl: job.audioUrl, downloadUrl: job.downloadUrl,
        extraction: { format: "full-audio-mp3", filename: job.filename, file_size: ex.size, completeAudio: true }
      };
      job.status = "done";
    } catch (e) {
      console.error("Transcription error:", e);
      job.status = "error";
      job.error = e?.message || "Transcription failed.";
    } finally {
      busy = false;
    }
  })();
});

app.get("/job/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found (the server restarted)." });
  res.json(j);
});

app.get("/audio/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{20,60}$/i.test(id)) return res.status(400).send("Invalid audio id.");
  const file = path.join(STORE, `${id}.mp3`);
  if (!fs.existsSync(file)) return res.status(404).send("Audio file has expired or is unavailable.");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (req.query.download === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="voxscript-audio.mp3"`);
  }
  res.sendFile(file);
});

// Keep temporary audio storage from growing indefinitely.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, j] of jobs) if (j.created < cutoff) jobs.delete(id);
  for (const name of fs.readdirSync(STORE)) {
    const file = path.join(STORE, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VoxScript Render backend listening on ${PORT}`);
});
