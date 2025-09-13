// server.js
import express from "express";
import axios from "axios";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const app = express();

// JSON for small control payloads; uploads go through express.raw
app.use(express.json({ limit: "2mb" }));
const rawUpload = express.raw({ type: "*/*", limit: "200mb" });

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

async function downloadToTemp(url) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cropapi-"));
  const file = join(dir, "in.mp4");
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 120000, headers: { "User-Agent": "Mozilla/5.0" } });
  await fs.writeFile(file, Buffer.from(resp.data));
  return { dir, file };
}

async function bufferToTemp(buf) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cropapi-"));
  const file = join(dir, "in.mp4");
  await fs.writeFile(file, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return { dir, file };
}

// cropdetect parser: returns {x,y,w,h,text}
function parseCrop(stderrTxt) {
  const m = [...stderrTxt.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!m.length) return null;
  const g = m[m.length - 1];
  const w = +g[1], h = +g[2], x = +g[3], y = +g[4];
  return { x, y, w, h, text: `crop=${w}:${h}:${x}:${y}` };
}

// bbox metadata parser for motion detector
function parseBboxMeta(stderrTxt) {
  const xs = [...stderrTxt.matchAll(/lavfi\.bbox\.x=(\d+)/g)].map(m => +m[1]);
  const ys = [...stderrTxt.matchAll(/lavfi\.bbox\.y=(\d+)/g)].map(m => +m[1]);
  const ws = [...stderrTxt.matchAll(/lavfi\.bbox\.w=(\d+)/g)].map(m => +m[1]);
  const hs = [...stderrTxt.matchAll(/lavfi\.bbox\.h=(\d+)/g)].map(m => +m[1]);
  if (!xs.length || !ys.length || !ws.length || !hs.length) return null;
  const x = xs.at(-1), y = ys.at(-1), w = ws.at(-1), h = hs.at(-1);
  return (w > 0 && h > 0) ? { x, y, w, h, text: `crop=${w}:${h}:${x}:${y}` } : null;
}

// ------------------------------
// Detectors
// ------------------------------

// DARK bars (classic black borders). We keep this for the /crop-upload (black route).
async function detectDarkCrop(file, seconds = 4) {
  const vf = "format=gray,boxblur=10:1:cr=0:ar=0,cropdetect=limit=30:round=2:reset=0";
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y","-ss","0","-t",String(seconds),
      "-i",file, "-vf", vf, "-f","null","-"
    ]);
    return parseCrop(stderr);
  } catch { return null; }
}

// WHITE / light page (title header/footer). Multi-try with thresholds/blurs/limits.
async function detectWhiteCrop(file, seconds = 6) {
  const thresholds = [238, 242, 246, 250]; // raise if page is very bright; lower if off-white
  const blurs      = [18, 24, 30];         // higher hides small black text on white
  const limits     = [6, 8, 10, 14];

  const tryVF = async (vf) => {
    try {
      const { stderr } = await sh("ffmpeg", [
        "-y","-ss","0","-t",String(seconds),
        "-i",file, "-vf", vf, "-f","null","-"
      ]);
      return parseCrop(stderr);
    } catch { return null; }
  };

  // size & scoring
  const { stdout } = await sh("ffprobe", [
    "-v","error","-select_streams","v:0","-show_entries","stream=width,height",
    "-of","csv=s=x:p=0", file
  ]);
  const [inW,inH] = stdout.trim().split("x").map(n=>parseInt(n,10));
  const score = (c) => {
    if (!c) return -1;
    // don't allow wild over-crops
    if (c.w < inW*0.6 || c.h < inH*0.6) return -1;
    const removed = (inW*inH) - (c.w*c.h);
    const top=c.y, left=c.x, bottom=inH-(c.y+c.h), right=inW-(c.x+c.w);
    // favor trimming vertical white banners; we leave black pillars alone elsewhere
    return removed + Math.max(top,bottom)*400 + Math.max(left,right)*50;
  };

  let best=null, bestScore=-1;

  // thresholded page (preferred)
  for (const th of thresholds) {
    for (const b of blurs) {
      for (const lim of limits) {
        const vf = `format=gray,lut=y='val>${th}?0:255',boxblur=${b}:1:cr=0:ar=0,cropdetect=limit=${lim}:round=2:reset=0`;
        const c = await tryVF(vf);
        const s = score(c);
        if (s>bestScore) { best=c; bestScore=s; }
      }
    }
  }

  // invert fallback (sometimes lighter UI benefits)
  for (const b of blurs) {
    for (const lim of limits) {
      const vf = `format=gray,negate,boxblur=${b}:1:cr=0:ar=0,cropdetect=limit=${lim}:round=2:reset=0`;
      const c = await tryVF(vf);
      const s = score(c);
      if (s>bestScore) { best=c; bestScore=s; }
    }
  }

  return best;
}

// MOTION: crop to the moving region (ignores static headers/background)
async function detectMotionCrop(file, seconds = 12) {
  const vf =
    "tblend=all_mode=difference," +
    "format=gray," +
    "boxblur=20:1:cr=0:ar=0," +
    "lut=y='val>20?255:0'," +     // lower threshold for sensitivity
    "bbox=detect=0," +
    "metadata=mode=print:key=lavfi.bbox.;file=-";

  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(seconds),
      "-i", file,
      "-an",
      "-vf", vf,
      "-f", "null", "-"
    ]);

    // Collect all bboxes, not just the last
    const xs = [...stderr.matchAll(/lavfi\.bbox\.x=(\d+)/g)].map(m => +m[1]);
    const ys = [...stderr.matchAll(/lavfi\.bbox\.y=(\d+)/g)].map(m => +m[1]);
    const ws = [...stderr.matchAll(/lavfi\.bbox\.w=(\d+)/g)].map(m => +m[1]);
    const hs = [...stderr.matchAll(/lavfi\.bbox\.h=(\d+)/g)].map(m => +m[1]);

    if (!xs.length) return null;

    const x1 = Math.min(...xs);
    const y1 = Math.min(...ys);
    const x2 = Math.max(...xs.map((x,i)=>x+ws[i]));
    const y2 = Math.max(...ys.map((y,i)=>y+hs[i]));
    const w  = x2 - x1;
    const h  = y2 - y1;

    return (w>0 && h>0) ? { x:x1, y:y1, w, h, text:`crop=${w}:${h}:${x1}:${y1}` } : null;
  } catch {
    return null;
  }
}



// ------------------------------
// Pipelines
// ------------------------------
async function encodeWithCrop(inFile, cropText, outFile) {
  const vf = [
    cropText,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic" // keep encoder-friendly dims
  ].join(",");
  await sh("ffmpeg", [
    "-y","-i", inFile,
    "-vf", vf,
    "-c:v","libx264","-preset","ultrafast","-crf","23",
    "-pix_fmt","yuv420p","-movflags","+faststart",
    "-an",
    outFile
  ]);
}

// ------------------------------
// Routes
// ------------------------------

// Health
app.get("/", (_, res) => res.send("OK"));

// Legacy URL route (kept for compatibility). Uses black-bar detection.
app.post("/crop", async (req, res) => {
  try {
    const { url, probeSeconds = 4 } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const { dir, file } = await downloadToTemp(url);
    const crop = await detectDarkCrop(file, probeSeconds);
    if (!crop) throw new Error("Could not detect crop");

    const outFile = join(tmpdir(), `cropapi-${Date.now()}-out.mp4`);
    await encodeWithCrop(file, crop.text, outFile);

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// BLACK route (binary upload) — trims classic black bars
app.post("/crop-upload", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });

    const { dir, file } = await bufferToTemp(req.body);
    const crop = await detectDarkCrop(file, 4);
    if (!crop) throw new Error("Could not detect crop");

    const outFile = join(tmpdir(), `cropapi-${Date.now()}-black.mp4`);
    await encodeWithCrop(file, crop.text, outFile);

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// WHITE route (binary upload) — trims ONLY white/light page (title/footer). Keeps black pillars.
// Falls back to motion if white detection fails.
app.post("/crop-upload-white", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });

    const { dir, file } = await bufferToTemp(req.body);

    let crop1 = await detectWhiteCrop(file, 6);
    if (!crop1) {
      // fallback: crop to moving region (works regardless of page color)
      crop1 = await detectMotionCrop(file, 6);
    }
    if (!crop1) throw new Error("Could not detect white-page or motion crop");

    // first crop
    const tmp1 = join(tmpdir(), `cropapi-${Date.now()}-w1.mp4`);
    await encodeWithCrop(file, crop1.text, tmp1);

    // micro-pass to shave 1–2px white leftovers
    const crop2 = await detectWhiteCrop(tmp1, 2);
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-white.mp4`);
    if (crop2) {
      await encodeWithCrop(tmp1, crop2.text, outFile);
    } else {
      // if micro-pass finds nothing, move tmp1 to out
      await fs.copyFile(tmp1, outFile);
    }

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); await fs.rm(tmp1,{force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// MOTION route (binary upload) — crops to moving video region only
app.post("/crop-upload-motion", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "No file in body" });

    const { dir, file } = await bufferToTemp(req.body);
    const crop = await detectMotionCrop(file, 6);
    if (!crop) throw new Error("Could not detect motion region");

    const outFile = join(tmpdir(), `cropapi-${Date.now()}-motion.mp4`);
    await encodeWithCrop(file, crop.text, outFile);

    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async ()=>{ await fs.rm(dir,{recursive:true,force:true}); });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ------------------------------
app.listen(process.env.PORT || 8080, () => {
  console.log("Crop API running on", process.env.PORT || 8080);
});
