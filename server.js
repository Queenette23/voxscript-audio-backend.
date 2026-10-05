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
  } catch {
    return false;
  }
}

function publicUrl(req, id) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/audio/${encodeURIComponent(id)}`;
}

function parseDuration(value) {
  if (value == null) return null;
  const n = Number(String(value).trim());
  if (Number.isFinite(n)) return n;
  const parts = String(value).trim().split(":").map(Number);
  if (parts.some(x => !Number.isFinite(x))) return null;
  let total = 0;
  for (const part of parts) total = total * 60 + part;
  return total;
}

async function mediaDuration(filePath) {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  return parseDuration(r.stdout);
}

async function sourceDuration(url, cookieFile) {
  const args = ["--no-playlist", "--no-warnings", "--skip-download", "--print", "%(duration)s"];
  if (cookieFile) args.splice(3, 0, "--cookies", cookieFile);
  args.push(url);
  try {
    const r = await run("yt-dlp", args, { env: { ...process.env } });
    const lines = r.stdout.trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = parseDuration(lines[i]);
      if (d != null && d > 0) return d;
    }
  } catch (e) {
    console.warn("Source duration lookup failed; extraction will still be attempted:", e.message);
  }
  return null;
}

async function extractOnce(url, out, cookieFile, client) {
  const ytArgs = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "128K",
    "--ffmpeg-location", "/usr/bin/ffmpeg",
    "--js-runtimes", "node",
    "--extractor-args", `youtube:player-client=${client};youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416`,
    "-o", out,
    url
  ];
  if (cookieFile) ytArgs.splice(1, 0, "--cookies", cookieFile);
  await run("yt-dlp", ytArgs, { env: { ...process.env } });
}

async function extractFullAudio(url) {
  const id = crypto.randomUUID();
  const out = path.join(STORE, `${id}.mp3`);
  let tempCookieFile = null;

  try {
    // Render Secret Files are read-only. Work from a writable copy.
    if (YOUTUBE_COOKIE_FILE) {
      tempCookieFile = path.join(STORE, `${id}-cookies.txt`);
      fs.copyFileSync(YOUTUBE_COOKIE_FILE, tempCookieFile);
    }

    const expectedDuration = await sourceDuration(url, tempCookieFile);
    const clients = ["mweb", "web_safari"];
    let actualDuration = null;
    let lastError = null;

    for (const client of clients) {
      try {
        if (fs.existsSync(out)) fs.rmSync(out, { force: true });
        await extractOnce(url, out, tempCookieFile, client);
        if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
          throw new Error("The extracted audio file is empty.");
        }
        actualDuration = await mediaDuration(out);

        // Do not silently accept a truncated audio stream. Allow a small timing
        // tolerance because container metadata can differ by a fraction of a second.
        if (expectedDuration && actualDuration && actualDuration + 1.5 < expectedDuration) {
          throw new Error(`Extracted audio is incomplete (${Math.round(actualDuration)}s of ${Math.round(expectedDuration)}s).`);
        }
        break;
      } catch (e) {
        lastError = e;
        console.warn(`YouTube extraction attempt (${client}) failed:`, e.message);
      }
    }

    if (!fs.existsSync(out) || !fs.statSync(out).size) {
      throw lastError || new Error("The complete audio file was not created.");
    }
    actualDuration = await mediaDuration(out);
    if (expectedDuration && actualDuration && actualDuration + 1.5 < expectedDuration) {
      throw new Error(`YouTube audio extraction remained incomplete after retry (${Math.round(actualDuration)}s of ${Math.round(expectedDuration)}s).`);
    }

    const stat = fs.statSync(out);
    return {
      id,
      path: out,
      size: stat.size,
      expectedDuration,
      duration: actualDuration
    };
  } finally {
    if (tempCookieFile) {
      try { fs.rmSync(tempCookieFile, { force: true }); } catch {}
    }
  }
}

async function transcribeFile(filePath, language) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured on Render.");

  const form = new FormData();
  form.append("model", "whisper-large-v3");
  form.append(
    "file",
    new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }),
    path.basename(filePath)
  );
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  // Keep the instruction narrowly focused on faithful ASR. Do not feed a lyric
  // transcription into the prompt: that can make Whisper copy text that it did
  // not actually hear.
  form.append(
    "prompt",
    "Transcribe only audible speech and singing. Preserve the exact order, repeated words, repeated choruses, ad-libs, fillers, stutters, names, slang, and spoken dialogue. Do not summarize, paraphrase, translate, clean up, censor, or add commentary. Do not invent words when audio is unclear. Do not output video-outro phrases or other text unless they are actually audible."
  );

  if (language && language !== "auto") form.append("language", language);

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "Groq transcription failed.");
  }
  return data;
}

function normalizeWord(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/[“”"'‘’.,!?;:()[\]{}]/g, "")
    .replace(/[^a-z0-9À-ž'-]/gi, "");
}

function wordsFromText(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

// Remove only text that is repeated across the small audio overlap.
// This does NOT remove repeated lyrics inside the song unless the same words
// occur at the end of one chunk and the beginning of the next chunk.
function mergeChunkText(previous, next) {
  const a = wordsFromText(previous);
  const b = wordsFromText(next);
  if (!a.length) return next.trim();
  if (!b.length) return previous.trim();

  const max = Math.min(30, a.length, b.length);
  let best = 0;

  for (let n = max; n >= 3; n--) {
    let matches = 0;
    for (let i = 0; i < n; i++) {
      if (normalizeWord(a[a.length - n + i]) === normalizeWord(b[i])) matches++;
    }
    if (matches / n >= 0.82) {
      best = n;
      break;
    }
  }

  return [...a, ...b.slice(best)].join(" ").trim();
}

async function transcribeCompleteAudio(filePath, language) {
  const MAX_DIRECT_BYTES = 20 * 1024 * 1024;

  // Even when the MP3 is small enough for one Groq request, use short,
  // overlapping chunks. This is deliberate: songs can cause a single long
  // Whisper pass to skip verses or hallucinate outro phrases. Short passes
  // improve local attention and make missing sections easier to detect.
  const duration = await mediaDuration(filePath);
  if (!duration || duration <= 0) {
    throw new Error("Could not determine the audio duration before transcription.");
  }

  const CHUNK_SECONDS = 60;
  const OVERLAP_SECONDS = 4;
  const chunkDir = fs.mkdtempSync(path.join(STORE, "transcription-chunks-"));
  const chunkResults = [];

  try {
    const count = Math.ceil(duration / (CHUNK_SECONDS - OVERLAP_SECONDS));

    for (let i = 0; i < count; i++) {
      const start = Math.max(0, i * (CHUNK_SECONDS - OVERLAP_SECONDS));
      if (start >= duration) break;

      const remaining = duration - start;
      const length = Math.min(CHUNK_SECONDS, remaining);

      const chunkPath = path.join(chunkDir, `chunk-${String(i).padStart(3, "0")}.mp3`);

      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(start),
        "-i", filePath,
        "-t", String(length),
        "-vn",
        "-acodec", "libmp3lame",
        "-b:a", "128k",
        "-ar", "44100",
        chunkPath
      ]);

      if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size === 0) {
        throw new Error(`Transcription chunk ${i + 1} could not be created.`);
      }

      const data = await transcribeFile(chunkPath, language);
      if (!data.text || !data.text.trim()) {
        throw new Error(`Transcription returned no text for audio section ${i + 1} of ${count}.`);
      }

      chunkResults.push({
        index: i,
        start,
        duration: length,
        data
      });
    }

    if (!chunkResults.length) {
      throw new Error("No audio sections were transcribed.");
    }

    let combinedText = "";
    const allSegments = [];
    const allWords = [];

    for (const chunk of chunkResults) {
      combinedText = mergeChunkText(combinedText, chunk.data.text);

      for (const seg of (chunk.data.segments || [])) {
        allSegments.push({
          ...seg,
          start: Number(seg.start || 0) + chunk.start,
          end: Number(seg.end || 0) + chunk.start
        });
      }

      for (const word of (chunk.data.words || [])) {
        allWords.push({
          ...word,
          start: Number(word.start || 0) + chunk.start,
          end: Number(word.end || 0) + chunk.start
        });
      }
    }

    // We only declare the transcript complete if every planned audio section
    // returned usable transcription text.
    if (chunkResults.length < count) {
      throw new Error("Not every audio section was transcribed.");
    }

    return {
      text: combinedText,
      language: chunkResults.find(x => x.data.language)?.data.language || language || "auto",
      duration,
      segments: allSegments,
      words: allWords,
      transcription: {
        mode: "overlapping-chunks",
        chunk_seconds: CHUNK_SECONDS,
        overlap_seconds: OVERLAP_SECONDS,
        chunks_completed: chunkResults.length,
        chunks_expected: count,
        source_duration: duration
      }
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
      duration: result.duration,
      sourceDuration: result.expectedDuration,
      format: "mp3",
      completeAudio: true
    });
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(502).json({ error: error?.message || "YouTube audio extraction failed." });
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
      transcription: data.transcription || null,
      source: "youtube-full-audio-render-groq-whisper",
      audioUrl: publicUrl(req, result.id),
      downloadUrl: `${publicUrl(req, result.id)}?download=1`,
      extraction: {
        format: "full-audio-mp3",
        filename: `voxscript-${result.id}.mp3`,
        file_size: result.size,
        duration: result.duration,
        source_duration: result.expectedDuration,
        completeAudio: true
      }
    });
  } catch (error) {
    console.error("Transcription error:", error);
    return res.status(502).json({ error: error?.message || "Full-audio transcription failed." });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VoxScript Render backend listening on ${PORT}`);
});
