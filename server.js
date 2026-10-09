const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const COOKIE_FILE = "/etc/secrets/cookies.txt";
const YOUTUBE_COOKIE_FILE = fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null;

app.use(cors({ origin: true }));
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
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"].includes(h);
  } catch { return false; }
}

function publicUrl(req, id) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/audio/${encodeURIComponent(id)}`;
}

async function extractFullAudio(url) {
  const id = crypto.randomUUID();
  const out = path.join(STORE, `${id}.mp3`);
  const ytArgs = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--extractor-args", "youtube:player-client=android,web",
    "--extractor-args", "youtube:player-skip=webpage,configs",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "128K",
    "--ffmpeg-location", "/usr/bin/ffmpeg",
    "-o", out,
    url
  ];
  let tempCookieFile = null;
  try {
    if (YOUTUBE_COOKIE_FILE) {
      tempCookieFile = path.join(STORE, `${id}-cookies.txt`);
      fs.copyFileSync(YOUTUBE_COOKIE_FILE, tempCookieFile);
      ytArgs.splice(1, 0, "--cookies", tempCookieFile);
    }
    await run("yt-dlp", ytArgs, { env: { ...process.env } });
  } finally {
    if (tempCookieFile) { try { fs.rmSync(tempCookieFile, { force: true }); } catch {} }
  }
  if (!fs.existsSync(out)) throw new Error("The complete audio file was not created.");
  const stat = fs.statSync(out);
  if (!stat.size) throw new Error("The extracted audio file is empty.");
  return { id, path: out, size: stat.size };
}

async function transcribeFile(filePath, language) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured on Render.");
  const form = new FormData();
  form.append("model", "whisper-large-v3");
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }), path.basename(filePath));
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  form.append("prompt", "Transcribe exactly what is audible. Preserve lyrics, repeats, fillers. Do not summarize
