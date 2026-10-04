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
    "--extractor-args", "youtube:player-client=mweb;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
    "-o", out,
    url
  ];

  // Render Secret Files are mounted outside the Git repository.
  // Never commit personal YouTube cookies to GitHub.
  if (YOUTUBE_COOKIE_FILE) {
    ytArgs.splice(1, 0, "--cookies", YOUTUBE_COOKIE_FILE);
  }

  await run("yt-dlp", ytArgs, { env: { ...process.env } });

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
    throw new Error(data?.error?.message || "Groq transcription failed.");
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
  // For transcription only, split it into overlapping 8-minute chunks so long files
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

    if (!files.length) throw new Error("Could not split the long audio for transcription.");

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
    return res.status(502).json({ error: error?.message || "Full-audio transcription failed." });
  }
});



async function downloadRemoteAudio(sourceUrl, ext="mp3") {
  if (!/^https?:\/\//i.test(sourceUrl)) throw new Error("Invalid source URL.");
  const id = crypto.randomUUID();
  const input = path.join(STORE, `${id}-input`);
  const output = path.join(STORE, `${id}.${ext}`);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Could not download source audio (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(input, buffer);
  return { id, input, output };
}

app.post("/process/noise-reduce", async (req, res) => {
  let job = null;
  try {
    job = await downloadRemoteAudio(req.body?.sourceUrl, "mp3");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", job.input,
      "-af", "afftdn=nr=12:nf=-30", "-codec:a", "libmp3lame", "-b:a", "192k", "-y", job.output
    ]);
    if (!fs.existsSync(job.output)) throw new Error("Noise-reduced audio was not created.");
    res.json({ id: job.id, audioUrl: `${PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`}/processed-audio/${encodeURIComponent(job.id)}`, filename: `voxscript-noise-reduced-${job.id}.mp3`, completeAudio: true });
  } catch (error) {
    console.error("Noise reduction error:", error);
    res.status(502).json({ error: error?.message || "Noise reduction failed." });
  } finally {
    if (job?.input) fs.rmSync(job.input, { force: true });
  }
});

app.get("/processed-audio/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{20,60}$/i.test(id)) return res.status(400).send("Invalid processed audio id.");
  const file = path.join(STORE, `${id}.mp3`);
  if (!fs.existsSync(file)) return res.status(404).send("Processed audio has expired or is unavailable.");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="voxscript-processed.mp3"`);
  res.sendFile(file);
});

app.post("/process/stems", async (req, res) => {
  const processor = (process.env.STEM_PROCESSOR_URL || "").replace(/\/$/, "");
  if (!processor) return res.status(503).json({ error: "Stem separation is configured for a separate GPU processor, but STEM_PROCESSOR_URL is not set yet." });
  try {
    const response = await fetch(`${processor}/separate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl: req.body?.sourceUrl }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: data?.error || "Stem separation processor failed." });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error?.message || "Could not reach the stem separation processor." });
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
