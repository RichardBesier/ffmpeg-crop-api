import express from "express";
import axios from "axios";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const app = express();

// JSON for /crop URL mode
app.use(express.json({ limit: "2mb" }));
// RAW body for binary upload mode (/crop-upload)
const rawUpload = express.raw({ type: "*/*", limit: "500mb" });

// ---------- helpers ----------
function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", d => (stdout += d.toString()));
    p.stderr.on("data", d => (stderr += d.toString()));
    p.on("close", code =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`))
    );
  });
}

async function downloadToTemp(url) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cropapi-"));
  const file = join(dir, "in.mp4");
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "video/*,application/octet-stream,*/*",
      "Referer": "https://www.instagram.com/"
    }
  });
  const ct = (resp.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("video")) throw new Error(`Source is not video. Content-Type: ${ct || "unknown"}`);
  await fs.writeFile(file, Buffer.from(resp.data));
  return { dir, file };
}

async function bufferToTemp(buf) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cropapi-"));
  const file = join(dir, "in.mp4");
  await fs.writeFile(file, buf);
  return { dir, file };
}

// Parse the LAST crop=W:H:X:Y from ffmpeg stderr
function parseCrop(stderrTxt) {
  const m = [...stderrTxt.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!m.length) return null;
  const last = m[m.length - 1];
  const w = +last[1], h = +last[2], x = +last[3], y = +last[4];
  return { w, h, x, y, text: `crop=${w}:${h}:${x}:${y}` };
}

// Run one detection pipeline (returns null on failure instead of throwing)
async function detectOnce(file, seconds, vf) {
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(seconds),
      "-i", file,
      "-vf", vf,
      "-f", "null", "-"
    ]);
    return parseCrop(stderr);
  } catch {
    return null;
  }
}

// Score crops: prefer removing more area but keep sane size
function scoreCrop(c, inW, inH) {
  if (!c) return -1;
  if (c.w < inW * 0.5 || c.h < inH * 0.5) return -1; // too aggressive
  const removed = (inW * inH) - (c.w * c.h);
  const top = c.y, left = c.x, bottom = inH - (c.y + c.h), right = inW - (c.x + c.w);
  const maxBar = Math.max(top, bottom, left, right);
  return removed + maxBar * 200; // overweight obvious big bars
}

// Get input dims
async function getDims(file) {
  const { stdout } = await sh("ffprobe", [
    "-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=s=x:p=0", file
  ]);
  const [w,h] = stdout.trim().split("x").map(n=>parseInt(n,10));
  return { w, h };
}

// ---- SMART DETECTOR: dark + bright + edges, with safe limits ----
async function detectCropSmart(file, seconds) {
  // Stay within ffmpeg limit range (0..65535). We'll test moderate values.
  const limits = [30, 45, 60, 75];

  let best = null, bestScore = -1;
  const { w: inW, h: inH } = await getDims(file);

  for (const lim of limits) {
    const pipelines = [
      // dark bars
      `format=gray,boxblur=24:1:cr=0:ar=0,cropdetect=limit=${lim}:round=2:reset=0`,
      // bright/white bars (invert)
      `format=gray,negate,boxblur=24:1:cr=0:ar=0,cropdetect=limit=${lim}:round=2:reset=0`,
      // any flat-color bars (edges)
      `format=gray,edgedetect=low=0.08:high=0.2,boxblur=6:1,cropdetect=limit=${lim}:round=2:reset=0`,
    ];

    const results = await Promise.all(pipelines.map(vf => detectOnce(file, seconds, vf)));
    for (const c of results) {
      const s = scoreCrop(c, inW, inH);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    if (bestScore > 0) break; // good enough, stop early
  }

  return best; // may be null; caller should handle
}

// ---- main processing (used by both routes) ----
async function processVideo(inFile, {
  probeSeconds = 4,
  targetW = 1080,
  targetH = 1920,
  downscale = true,          // set false to keep full res after crop
} = {}) {

  const crop = await detectCropSmart(inFile, probeSeconds);
  if (!crop) throw new Error("Could not detect crop");

  const outFile = join(tmpdir(), `cropapi-${Date.now()}-out.mp4`);

  const vf = [
    crop.text,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic",                 // even dims
    downscale ? `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease` : null,
  ].filter(Boolean).join(",");

  await sh("ffmpeg", [
    "-y","-i",inFile,
    "-vf",vf,
    "-r","30",
    "-c:v","libx264",
    "-preset","ultrafast",
    "-crf","23",
    "-pix_fmt","yuv420p",
    "-movflags","+faststart",
    "-x264-params","bframes=0:ref=1:rc-lookahead=0:keyint=60:min-keyint=60:scenecut=0",
    "-bf","0",
    "-threads","2",
    "-an",
    "-max_muxing_queue_size","9999",
    outFile
  ]);

  return outFile;
}

// -------- routes --------

// URL mode
app.post("/crop", async (req, res) => {
  try {
    const { url, probeSeconds = 4 } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const { dir, file } = await downloadToTemp(url);
    const outFile = await processVideo(file, { probeSeconds });

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Binary upload mode (recommended)
app.post("/crop-upload", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });

    const { dir, file } = await bufferToTemp(req.body);
    const outFile = await processVideo(file, { probeSeconds: 4 });

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));
