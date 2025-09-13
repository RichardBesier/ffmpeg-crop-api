// server.js (rollback version: black + white detection only)
import express from "express";
import axios from "axios";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const app = express();
const rawUpload = express.raw({ type: "*/*", limit: "200mb" });
app.use(express.json({ limit: "2mb" }));

// ------------------------------
// Utils
// ------------------------------
function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", d => (stdout += d.toString()));
    p.stderr.on("data", d => (stderr += d.toString()));
    p.on("close", code => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`))));
  });
}

async function bufferToTemp(buf) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cropapi-"));
  const file = join(dir, "in.mp4");
  await fs.writeFile(file, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return { dir, file };
}

function parseCrop(stderrTxt) {
  const m = [...stderrTxt.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!m.length) return null;
  const g = m[m.length - 1];
  const w = +g[1], h = +g[2], x = +g[3], y = +g[4];
  return { x, y, w, h, text: `crop=${w}:${h}:${x}:${y}` };
}

// ------------------------------
// Black background detector
// ------------------------------
async function detectDarkCrop(file, seconds = 4) {
  const vf = "format=gray,boxblur=10:1:cr=0:ar=0,cropdetect=limit=30:round=2:reset=0";
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(seconds),
      "-i", file,
      "-vf", vf,
      "-f", "null", "-"
    ]);
    return parseCrop(stderr);
  } catch { return null; }
}

// ------------------------------
// White background detector
// ------------------------------
async function detectWhiteCrop(file, seconds = 6) {
  const vf = "format=gray,boxblur=20:1:cr=0:ar=0,cropdetect=limit=10:round=2:reset=0";
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(seconds),
      "-i", file,
      "-vf", vf,
      "-f", "null", "-"
    ]);
    return parseCrop(stderr);
  } catch { return null; }
}

// ------------------------------
// Encode with crop
// ------------------------------
async function encodeWithCrop(inFile, cropText, outFile) {
  const vf = [
    cropText,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic"
  ].join(",");
  await sh("ffmpeg", [
    "-y", "-i", inFile,
    "-vf", vf,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-an", outFile
  ]);
}

// ------------------------------
// Routes
// ------------------------------

// Black route
app.post("/crop-upload", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });
    const { dir, file } = await bufferToTemp(req.body);
    const crop = await detectDarkCrop(file, 4);
    if (!crop) throw new Error("Could not detect crop");
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-black.mp4`);
    await encodeWithCrop(file, crop.text, outFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// White route
app.post("/crop-upload-white", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });
    const { dir, file } = await bufferToTemp(req.body);
    const crop = await detectWhiteCrop(file, 6);
    if (!crop) throw new Error("Could not detect crop");
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-white.mp4`);
    await encodeWithCrop(file, crop.text, outFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Crops a strip from the top (percentage)
app.post("/crop-strip-top", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file" });

    const percent = Number(req.query.percent || 5); // default 5%
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-strip.mp4`);

    // Full width; reduce height by %, offset down by the same %
    const vf = `crop=in_w:in_h*${(100 - percent) / 100}:0:in_h*${percent / 100}`;

    await sh("ffmpeg", [
      "-y", "-i", file,
      "-vf", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-an", outFile
    ]);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));
