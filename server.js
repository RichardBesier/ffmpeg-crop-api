import express from "express";
import axios from "axios";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- helper to run shell cmds
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

// ---- download with browser-like headers & verify it's really video
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

// ---- parse "crop=W:H:X:Y" from ffmpeg stderr (use the last one)
function parseCrop(stderrTxt) {
  const matches = [...stderrTxt.matchAll(/crop=\d+:\d+:\d+:\d+/g)];
  return matches.length ? matches[matches.length - 1][0] : null;
}

app.post("/crop", async (req, res) => {
  try {
    const { url, probeSeconds = 6, limit = 30 } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const { dir, file: inFile } = await downloadToTemp(url);

    // 1) detect crop box from first N seconds
    const detect = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(probeSeconds),
      "-i", inFile,
      "-vf", `cropdetect=limit=${limit}:round=2:reset=0`,
      "-f", "null", "-"
    ]);
    const crop = parseCrop(detect.stderr);
    if (!crop) return res.status(422).json({ error: "Could not detect crop" });

    // 2) apply crop safely: force even dimensions, normalize FPS, QuickTime-friendly
    const outFile = join(dir, "out.mp4");
    const safeVf = `${crop},scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic`;

    await sh("ffmpeg", [
      "-y",
      "-i", inFile,
      "-vf", safeVf,
      "-r", "30",                    // stabilize timestamps
      "-c:v", "libx264",
      "-preset", "superfast",        // fast on shared CPU
      "-crf", "20",
      "-pix_fmt", "yuv420p",         // QuickTime/IG friendly
      "-movflags", "+faststart",     // moov at start
      "-an",                         // no audio; swap for AAC if you want audio
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
