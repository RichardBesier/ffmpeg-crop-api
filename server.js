// server.js — SIMPLE ROLLBACK (black + white routes only)
import express from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import multer from "multer";

const app = express();
app.use(express.json({ limit: "2mb" }));

// RAW body for binary upload
const rawUpload = express.raw({ type: "*/*", limit: "500mb" });

// Multer instance for form-data uploads (needed by /place-on-template)
const upload = multer();

// ------------------------------
// helpers
// ------------------------------
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

async function encodeWithCrop(inFile, cropText, outFile) {
  const vf = [
    cropText,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic"
  ].join(",");
  await sh("ffmpeg", [
    "-y", "-i", inFile,
    "-vf", vf,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-an",
    outFile
  ]);
}

// Write a buffer to a temp file with a chosen extension
async function bufferToTempWithExt(buf, ext = ".bin") {
  const dir = await fs.mkdtemp(join(tmpdir(), "tpl-"));
  const file = join(dir, "f" + ext);
  await fs.writeFile(file, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return { dir, file };
}


// ------------------------------
// DETECTORS
// ------------------------------

// Works for BLACK/DARK bars
async function detectDarkCrop(file, seconds = 4) {
  // cropdetect finds BLACK borders, so we blur the image to remove noise
  const vf = "format=gray,boxblur=16:1:cr=0:ar=0,cropdetect=limit=24:round=2:reset=0";
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

// Works for WHITE/LIGHT backgrounds (e.g., meme title on white)
// Idea: blur hard to kill small text, then threshold so white page => pure black
async function detectWhiteCrop(file, seconds = 6) {
  const pipelines = [
    // strong blur to suppress text; then threshold near-white to black
    "format=gray,boxblur=28:1:cr=0:ar=0,lut=y='val>238?0:255',cropdetect=limit=6:round=2:reset=0",
    "format=gray,boxblur=34:1:cr=0:ar=0,lut=y='val>240?0:255',cropdetect=limit=8:round=2:reset=0",
    "format=gray,boxblur=40:1:cr=0:ar=0,lut=y='val>242?0:255',cropdetect=limit=10:round=2:reset=0",
    // fallback: bright inversion route sometimes helps
    "format=gray,negate,boxblur=22:1:cr=0:ar=0,cropdetect=limit=24:round=2:reset=0"
  ];

  let best = null;
  for (const vf of pipelines) {
    try {
      const { stderr } = await sh("ffmpeg", [
        "-y", "-ss", "0", "-t", String(seconds),
        "-i", file,
        "-vf", vf,
        "-f", "null", "-"
      ]);
      const c = parseCrop(stderr);
      if (c) { best = c; break; }
    } catch { /* try next */ }
  }
  return best;
}

// ------------------------------
// ROUTES
// ------------------------------

// Black/dark route
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
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// White/light route
app.post("/crop-upload-white", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });
    const { dir, file } = await bufferToTemp(req.body);

    const crop = await detectWhiteCrop(file, 6);
    if (!crop) throw new Error("Could not detect crop on white background");

    const outFile = join(tmpdir(), `cropapi-${Date.now()}-white.mp4`);
    await encodeWithCrop(file, crop.text, outFile);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/frame", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file" });

    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `frame-${Date.now()}.jpg`);

    await sh("ffmpeg", [
      "-y", "-i", file,
      "-ss", "00:00:02",   // grab frame at 2 seconds
      "-vframes", "1",
      outFile
    ]);

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", 'inline; filename="frame.jpg"');
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

    // full width; reduce height by %, y offset = same %
    const vf = `crop=in_w:in_h*${(100 - percent) / 100}:0:in_h*${percent / 100}`;

    await sh("ffmpeg", [
      "-y","-i",file,
      "-vf",vf,
      "-c:v","libx264","-crf","18","-preset","veryfast",
      "-pix_fmt","yuv420p","-movflags","+faststart",
      "-an", outFile
    ]);

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.post("/place-on-template", upload.fields([{ name: "template" }, { name: "video" }]), async (req, res) => {
  try {
    const top = Number(req.query.top ?? NaN);
    const bottom = Number(req.query.bottom ?? 0);
    if (!req.files?.template?.[0] || !req.files?.video?.[0]) {
      return res.status(400).json({ error: "Send 'template' (image) and 'video' (mp4) as form-data files." });
    }
    if (!Number.isFinite(top) || top < 0 || top > 1800) {
      return res.status(400).json({ error: "Query param 'top' (pixels) is required and must be reasonable." });
    }
    const safeBottom = Number.isFinite(bottom) && bottom >= 0 ? bottom : 0;

    // save inputs
    const { dir: tDir, file: tFile0 } = await bufferToTempWithExt(req.files.template[0].buffer, ".png");
    const { dir: vDir, file: vFile }  = await bufferToTempWithExt(req.files.video[0].buffer, ".mp4");

    // Normalize template to exact 1080x1920 in case it isn't already
    const tFile = join(tDir, "template_1080x1920.png");
    await sh("ffmpeg", [
      "-y", "-i", tFile0,
      "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
      "-frames:v", "1",
      tFile
    ]);

    const outFile = join(tmpdir(), `brand-${Date.now()}.mp4`);

    // available height under the header
    const availH = 1920 - top - safeBottom;
    if (availH <= 0) {
      return res.status(400).json({ error: "Invalid top/bottom: no space left for the video." });
    }

    // Build filter:
    // 1) scale video to width=1080, height=min(availH, ih*1080/iw) (i.e., fit within box)
    // 2) overlay onto normalized template at y=top
    // escape the comma for ffmpeg filtergraph: use "\," (double-slash in JS string)
const scaleExpr = `scale=1080:min(${availH}\\,ih*1080/iw):force_original_aspect_ratio=decrease`;
    const filter = `[1:v]${scaleExpr}[vid];[0:v][vid]overlay=0:${top},format=yuv420p`;

   await sh("ffmpeg", [
  "-y",

  // 0) Loop the PNG template as a video at 30 fps
  "-loop", "1", "-framerate", "30", "-i", tFile,   // background/template

  // 1) The cropped video
  "-i", vFile,

  // Build the scene:
  // - scale the video to 1080 wide, clamp height to <= availH, keep AR, set CFR 30 and fresh timestamps
  // - overlay video onto the looping template at y=top
  "-filter_complex",
  `[1:v]scale=1080:min(${availH}\\,ih*1080/iw):force_original_aspect_ratio=decrease,` +
  `fps=30,setpts=PTS-STARTPTS[vid];` +
  `[0:v]fps=30,format=rgba[bg];` +
  `[bg][vid]overlay=0:${top}:eval=init:shortest=1,format=yuv420p`,

  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "18",
  "-r", "30",
  "-movflags", "+faststart",

  // -shortest is fine to keep too, but overlay shortest=1 already gates it.
  "-shortest",
  "-an",

  outFile
]);





    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="branded.mp4"');
    res.sendFile(outFile, async () => {
      await fs.rm(tDir, { recursive: true, force: true });
      await fs.rm(vDir, { recursive: true, force: true });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});



app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));
