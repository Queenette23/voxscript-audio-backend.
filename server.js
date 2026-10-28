const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
// Render terminates TLS at its proxy. Without this, req.protocol is "http" and any
// audioUrl built from the request would be blocked as mixed content on your https site.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const COOKIE_FILE = process.env.YOUTUBE_COOKIES_FILE || "/etc/secrets/cookies.txt";
const BGUTIL_URL = "http://127.0.0.1:4416";
// Residential proxy for yt-dlp only, e.g. http://user:pass@host:port (set in Render > Environment, never in GitHub).
const YTDLP_PROXY = process.env.YTDLP_PROXY || "";
// yt-dlp refreshes ("rotates") cookies while it runs. We keep the refreshed copy here so the next
// request continues the same login instead of restarting from the original file every time.
const LIVE_COOKIE_FILE = path.join(os.tmpdir(), "voxscript-cookies-live.txt");
const YTDLP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_EXTRACTIONS = Number(process.env.MAX_CONCURRENT_EXTRACTIONS) || 1; // free plan = 512 MB RAM
// Optional: comma-separated list, e.g. "https://your-app.vercel.app". Empty = allow all.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true }));
app.use(express.json({ limit: "1mb" }));

const STORE = path.join(os.tmpdir(), "voxscript-audio");
fs.mkdirSync(STORE, { recursive: true });

// Errors that are safe and useful to show to the end user. Anything else is logged
// in full on the server and replaced with a generic message.
class PublicError extends Error {}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-5000) || `${command} exited with ${signal || "code " + code}`));
    });
  });
}

// Simple slot limiter so parallel requests can't exhaust memory on a small instance.
let activeSlots = 0;
const slotWaiters = [];
async function acquireSlot() {
  if (activeSlots < MAX_CONCURRENT_EXTRACTIONS) { activeSlots++; return; }
  await new Promise(resolve => slotWaiters.push(resolve)); // slot is handed over directly
}
function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) next(); else activeSlots--;
}

function isYouTubeUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com"].includes(h);
  } catch {
    return false;
  }
}

function publicUrl(req, id) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/audio/${encodeURIComponent(id)}`;
}

function classifyYtDlpError(message) {
  if (/sign in to confirm|not a bot/i.test(message)) {
    return { retry: false, text: "YouTube is blocking the server right now (bot check). Please try again later, or use the Upload media tab." };
  }
  if (/private video|members-only|join this channel|confirm your age|age-restricted/i.test(message)) {
    return { retry: false, text: "This video is private, members-only or age-restricted, so its audio can't be extracted." };
  }
  if (/video unavailable|not available in your country|has been removed|copyright/i.test(message)) {
    return { retry: false, text: "This video is unavailable, removed or region-blocked." };
  }
  if (/requested format is not available|failed to extract any player response|unable to extract/i.test(message)) {
    return { retry: true, text: "YouTube did not return an audio stream for this video. Please try again later, or use the Upload media tab." };
  }
  return { retry: false, text: "Could not extract audio from this YouTube video. Please try again later, or use the Upload media tab." };
}

function redact(text) {
  return YTDLP_PROXY ? String(text).split(YTDLP_PROXY).join("[proxy]") : String(text);
}

function persistCookies(tempFile) {
  try {
    const txt = fs.readFileSync(tempFile, "utf8");
    if (/Netscape HTTP Cookie File/i.test(txt.slice(0, 200))) fs.writeFileSync(LIVE_COOKIE_FILE, txt, { mode: 0o600 });
  } catch {}
}

function removeFilesForId(id) {
  for (const name of fs.readdirSync(STORE)) {
    if (name.startsWith(id)) { try { fs.rmSync(path.join(STORE, name), { force: true }); } catch {} }
  }
}

async function extractFullAudio(url) {
  const id = crypto.randomUUID();
  const out = path.join(STORE, `${id}.mp3`);
  // IMPORTANT: let yt-dlp pick the extension (%(ext)s). If -o ends in ".mp3", yt-dlp downloads
  // the raw webm/m4a stream to that exact name, then the MP3 converter sees "source == target"
  // and skips conversion, leaving non-MP3 data inside a .mp3 file.
  const template = path.join(STORE, `${id}.%(ext)s`);

  const baseArgs = [
    "--no-playlist",
    "--newline",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "128K",
    "--ffmpeg-location", "/usr/bin/ffmpeg",
    "--js-runtimes", "node",
    "--socket-timeout", "30",
    "--retries", "3",
    // Separate flag per extractor. (Putting the bgutil option after a ";" inside the youtube
    // flag assigns it to the wrong extractor, so it was never actually applied.)
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${BGUTIL_URL}`,
    "-o", template
  ];

  // Attempt 1 uses yt-dlp's own default client list (best maintained).
  // Attempt 2 adds mweb to that default list instead of replacing it.
  const attempts = [[], ["--extractor-args", "youtube:player_client=default,mweb"]];

  // Render Secret Files are read-only and yt-dlp wants to write its cookie jar,
  // so give it a private writable copy that is deleted afterwards.
  let tempCookieFile = null;
  const cookieArgs = [];
  const cookieSource = fs.existsSync(LIVE_COOKIE_FILE) ? LIVE_COOKIE_FILE : (fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null);
  if (cookieSource) {
    tempCookieFile = path.join(STORE, `${id}-cookies.txt`);
    fs.copyFileSync(cookieSource, tempCookieFile);
    fs.chmodSync(tempCookieFile, 0o600);
    cookieArgs.push("--cookies", tempCookieFile);
  }
  console.log(`[extract ${id.slice(0, 8)}] cookies: ${tempCookieFile ? (cookieSource === LIVE_COOKIE_FILE ? "yes (refreshed copy)" : "yes (original file)") : "NO (cookie file not found)"} | proxy: ${YTDLP_PROXY ? "yes" : "no"}`);
  if (YTDLP_PROXY) cookieArgs.push("--proxy", YTDLP_PROXY);

  await acquireSlot();
  let lastError = null;
  try {
    for (const [i, extra] of attempts.entries()) {
      try {
        await run("yt-dlp", [...baseArgs, ...cookieArgs, ...extra, "--", url], { timeout: YTDLP_TIMEOUT_MS, killSignal: "SIGKILL" });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`[extract ${id.slice(0, 8)}] attempt ${i + 1} failed:\n${redact(err.message)}`);
        if (!classifyYtDlpError(err.message).retry) break;
      }
    }
  } finally {
    releaseSlot();
    if (tempCookieFile) {
      if (!lastError) persistCookies(tempCookieFile); // success: keep the refreshed login
      else if (/no longer valid/i.test(lastError.message)) { try { fs.rmSync(LIVE_COOKIE_FILE, { force: true }); } catch {} } // bad copy: fall back to the original file
      try { fs.rmSync(tempCookieFile, { force: true }); } catch {}
    }
  }

  if (lastError) {
    removeFilesForId(id);
    throw new PublicError(classifyYtDlpError(lastError.message).text);
  }

  if (!fs.existsSync(out)) { removeFilesForId(id); throw new PublicError("The complete audio file was not created."); }
  const stat = fs.statSync(out);
  if (!stat.size) { removeFilesForId(id); throw new PublicError("The extracted audio file is empty."); }

  return { id, path: out, size: stat.size };
}

async function transcribeFile(filePath, language) {
  if (!GROQ_API_KEY) throw new PublicError("GROQ_API_KEY is not configured on Render.");

  const form = new FormData();
  form.append("model", "whisper-large-v3");
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }), path.basename(filePath));
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  form.append(
    "prompt",
    "Transcribe exactly what is audible in this audio. " +
    "This may be a song. Preserve sung lyrics, repeated words, repeated lines, chorus repetitions, " +
    "fillers, names, slang, wording, and other audible content. Do not summarize, paraphrase, translate, " +
    "clean up, censor, or invent words. Return the words as faithfully as the audio allows."
  );
  if (language && language !== "auto") form.append("language", language);

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PublicError(data?.error?.message || "Groq transcription failed.");
  }
  return data;
}

async function transcribeCompleteAudio(filePath, language) {
  const MAX_DIRECT_BYTES = 20 * 1024 * 1024; // stay below Groq's 25 MB free-tier file limit
  const size = fs.statSync(filePath).size;

  if (size <= MAX_DIRECT_BYTES) {
    return await transcribeFile(filePath, language);
  }

  // Keep the original full MP3 untouched for playback/download.
  // For transcription only, split it into consecutive 8-minute chunks (no overlap, so words on a boundary can be clipped) so long files
  // can still be transcribed without dropping the beginning or end.
  const chunkDir = fs.mkdtempSync(path.join(STORE, "chunks-"));
  const chunks = [];
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", filePath,
      "-f", "segment",
      "-segment_time", "480",
      "-reset_timestamps", "1",
      "-c", "copy",
      path.join(chunkDir, "chunk-%03d.mp3")
    ]);

    const files = fs.readdirSync(chunkDir)
      .filter(n => n.endsWith(".mp3"))
      .sort();

    if (!files.length) throw new PublicError("Could not split the long audio for transcription.");

    let combinedText = [];
    let allSegments = [];
    let allWords = [];
    let offset = 0;

    for (const name of files) {
      const full = path.join(chunkDir, name);
      const data = await transcribeFile(full, language);
      if (data.text) combinedText.push(data.text.trim());

      const duration = Number(data.duration) || 0;
      for (const seg of (data.segments || [])) {
        allSegments.push({
          ...seg,
          start: Number(seg.start || 0) + offset,
          end: Number(seg.end || 0) + offset
        });
      }
      for (const word of (data.words || [])) {
        allWords.push({
          ...word,
          start: Number(word.start || 0) + offset,
          end: Number(word.end || 0) + offset
        });
      }
      offset += duration || 480;
    }

    return {
      text: combinedText.join("\n"),
      language: language || "auto",
      duration: offset,
      segments: allSegments,
      words: allWords
    };
  } finally {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

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

    const result = await extractFullAudio(url);
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
    res.status(502).json({ error: error instanceof PublicError ? error.message : "YouTube audio extraction failed." });
  }
});

app.post("/transcribe", async (req, res) => {
  let result = null;
  try {
    const { url, language } = req.body || {};
    if (!url || !isYouTubeUrl(url)) {
      return res.status(400).json({ error: "Please enter a valid YouTube link." });
    }

    result = await extractFullAudio(url);
    const data = await transcribeCompleteAudio(result.path, language);

    return res.json({
      transcript: data.text || "",
      language: data.language || language || "auto",
      duration: data.duration || null,
      segments: data.segments || [],
      words: data.words || [],
      source: "youtube-full-audio-render-groq-whisper",
      audioUrl: publicUrl(req, result.id),
      downloadUrl: `${publicUrl(req, result.id)}?download=1`,
      extraction: {
        format: "full-audio-mp3",
        filename: `voxscript-${result.id}.mp3`,
        file_size: result.size,
        completeAudio: true
      }
    });
  } catch (error) {
    console.error("Transcription error:", error);
    return res.status(502).json({ error: error instanceof PublicError ? error.message : "Full-audio transcription failed." });
  }
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
  for (const name of fs.readdirSync(STORE)) {
    const file = path.join(STORE, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}, 15 * 60 * 1000).unref();


// Startup diagnostics: these lines show up in the Render logs and tell you immediately
// whether yt-dlp, the cookie file and the PO-token provider are what you think they are.
(async () => {
  try { const { stdout } = await run("yt-dlp", ["--version"]); console.log("yt-dlp version:", stdout.trim()); }
  catch (e) { console.error("yt-dlp is not runnable:", e.message); }

  try { console.log("Files in /etc/secrets:", fs.readdirSync("/etc/secrets")); }
  catch { console.log("/etc/secrets does not exist (no Secret Files attached)"); }

  if (fs.existsSync(COOKIE_FILE)) {
    const head = fs.readFileSync(COOKIE_FILE, "utf8").slice(0, 200);
    const okFormat = /Netscape HTTP Cookie File/i.test(head);
    console.log(`YouTube cookies found at ${COOKIE_FILE} (${fs.statSync(COOKIE_FILE).size} bytes)` +
      (okFormat ? "" : " - WARNING: first line is not '# Netscape HTTP Cookie File'"));
  } else {
    console.warn(`NO YouTube cookies at ${COOKIE_FILE} - requests will run without login.`);
  }

  console.log(YTDLP_PROXY ? "Proxy for yt-dlp: configured" : "Proxy for yt-dlp: none (requests leave from Render's own IP)");
  try {
    const r = await fetch(`${BGUTIL_URL}/ping`, { signal: AbortSignal.timeout(3000) });
    console.log("bgutil PO-token provider reachable, HTTP", r.status);
  } catch (e) {
    console.error("bgutil PO-token provider NOT reachable:", e.message, "(see /tmp/bgutil-provider.log output above)");
  }
})();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VoxScript Render backend listening on ${PORT}`);
});
