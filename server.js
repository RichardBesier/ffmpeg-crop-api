import express from "express";
import axios from "axios";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Run a shell command and collect stdout/stderr
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

// Download with browser-like headers and verify it's actually a video
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
      "Accept": "video/*,application/octet-stream,*/*"
    }
  });
  const ct = (resp.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("video")) {
    throw new Error(`Source is not video. Content-Type: ${ct || "unknown"}`);
  }
  await fs.writeFile(file, Buffer.from(resp.data));
  return { dir, file };
}

// Pull the last "crop=W:H:X:Y" from ffmpeg stderr
function parseCrop(stderrTxt) {
  const matches = [...stderrTxt.matchAll(/crop=\d+:\d+:\d+:\d+/g)];
  return matches.length ? matches[matches.length - 1][0] : null;
}

app.post("/crop", async (req, res) => {
  try {
    const { url, probeSeconds = 3, limit = 30 } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const { dir, file: inFile } = await downloadToTemp(url);

    // 1) Detect crop box from the first N seconds
    const detect = await sh("ffmpeg", [
      "-y",
      "-ss", "0",
      "-t", String(probeSeconds),
      "-i", inFile,
      "-vf", `cropdetect=limit=${limit}:round=2:reset=0`,
      "-f", "null",
      "-"
    ]);
    const crop = parseCrop(detect.stderr);
    if (!crop) return res.status(422).json({ error: "Could not detect crop" });

    // 2) Apply crop safely:
    //    - force even dimensions to keep encoders happy
    //    - OPTIONAL downscale to height ~1280 for speed (remove ",scale=-2:1280" to keep full res)
    const outFile = join(dir, "out.mp4");
    const safeVf = `${crop},scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic,scale=-2:1280`;

    await sh("ffmpeg", [
      "-y",
      "-i", inFile,
      "-vf", safeVf,
      "-r", "30",                             // normalize fps / timestamps
      "-c:v", "libx264",
      "-preset", "ultrafast",                 // fastest on shared CPU
      "-crf", "23",                           // a bit more compression = faster
      "-pix_fmt", "yuv420p",                  // broad compatibility
      "-movflags", "+faststart",              // moov atom at start
      "-x264-params", "bframes=0:ref=1:rc-lookahead=0:keyint=60:min-keyint=60:scenecut=0",
      "-bf", "0",
      "-threads", "2",
      "-an",                                   // drop audio; switch to AAC if you want audio
      "-max_muxing_queue_size", "9999",
      outFile
    ]);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));
