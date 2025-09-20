// server.js — crop black/white + utility endpoints + place-on-template
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

// Multer for multipart/form-data (used by /place-on-template)
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

async function bufferToTempWithExt(buf, ext = ".bin") {
  const dir = await fs.mkdtemp(join(tmpdir(), "tpl-"));
  const file = join(dir, "f" + ext);
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
  const vf = [cropText, "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic"].join(",");
  await sh("ffmpeg", [
    "-y", "-i", inFile,
    "-vf", vf,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-an",
    outFile
  ]);
}

// ------------------------------
// DETECTORS
// ------------------------------
async function detectDarkCrop(file, seconds = 4) {
  const vf = "format=gray,boxblur=16:1:cr=0:ar=0,cropdetect=limit=24:round=2:reset=0";
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "0", "-t", String(seconds),
      "-i", file, "-vf", vf, "-f", "null", "-"
    ]);
    return parseCrop(stderr);
  } catch { return null; }
}

async function detectWhiteCrop(file, seconds = 6) {
  const pipelines = [
    "format=gray,boxblur=28:1:cr=0:ar=0,lut=y='val>238?0:255',cropdetect=limit=6:round=2:reset=0",
    "format=gray,boxblur=34:1:cr=0:ar=0,lut=y='val>240?0:255',cropdetect=limit=8:round=2:reset=0",
    "format=gray,boxblur=40:1:cr=0:ar=0,lut=y='val>242?0:255',cropdetect=limit=10:round=2:reset=0",
    "format=gray,negate,boxblur=22:1:cr=0:ar=0,cropdetect=limit=24:round=2:reset=0"
  ];
  for (const vf of pipelines) {
    try {
      const { stderr } = await sh("ffmpeg", [
        "-y", "-ss", "0", "-t", String(seconds),
        "-i", file, "-vf", vf, "-f", "null", "-"
      ]);
      const c = parseCrop(stderr);
      if (c) return c;
    } catch {}
  }
  return null;
}

// ------------------------------
// ROUTES
// ------------------------------

// Black bars
app.post("/crop-upload", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No file in body" });
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

// White/light background
app.post("/crop-upload-white", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No file in body" });
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

// Single frame (JPG)
app.post("/frame", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No file" });
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `frame-${Date.now()}.jpg`);
    await sh("ffmpeg", ["-y", "-i", file, "-ss", "00:00:02", "-vframes", "1", outFile]);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", 'inline; filename="frame.jpg"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Crop a tiny strip from top (percent)
app.post("/crop-strip-top", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No file" });
    const percent = Number(req.query.percent || 5);
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-strip.mp4`);
    const vf = `crop=in_w:in_h*${(100 - percent) / 100}:0:in_h*${percent / 100}`;
    await sh("ffmpeg", [
      "-y", "-i", file, "-vf", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outFile
    ]);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Place a cropped video onto a 1080x1920 PNG template - WORKING VERSION
app.post("/place-on-template",
  upload.fields([{ name: "template" }, { name: "video" }]),
  async (req, res) => {
    try {
      const top = Number(req.query.top ?? NaN);
      const bottom = Number(req.query.bottom ?? 0);
      
      console.log(`Processing request: top=${top}, bottom=${bottom}`);
      
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

      console.log(`Files saved: template=${tFile0}, video=${vFile}`);

      // Get video duration
      const { stdout: durOut } = await sh("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1",
        vFile
      ]);
      const videoDuration = parseFloat(durOut || "0");
      console.log(`Video duration: ${videoDuration}s`);

      if (videoDuration <= 0) {
        throw new Error("Could not determine video duration");
      }

      // Normalize template to exact 1080x1920
      const tFile = join(tDir, "template_1080x1920.png");
      await sh("ffmpeg", [
        "-y", "-i", tFile0,
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(1080-iw)/2:(1920-ih)/2:color=black",
        "-frames:v", "1",
        tFile
      ]);

      // Calculate available space
      const availH = 1920 - top - safeBottom;
      console.log(`Available height: ${availH}px`);
      
      if (availH <= 0) {
        return res.status(400).json({ error: "Invalid top/bottom: no space left for the video." });
      }

      // Create template video background (like the working debug test)
      console.log("Creating template background...");
      const templateVideo = join(tDir, "template_bg.mp4");
      await sh("ffmpeg", [
        "-y",
        "-loop", "1", "-i", tFile,
        "-t", String(videoDuration),
        "-r", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        templateVideo
      ]);

      // Final composition using the same approach as the working debug test
      console.log("Final composition...");
      const outFile = join(tmpdir(), `brand-${Date.now()}.mp4`);
      
      await sh("ffmpeg", [
        "-y",
        "-i", templateVideo,  // Template background
        "-i", vFile,          // Input video
        "-filter_complex", `[1:v]scale=1080:${availH}:force_original_aspect_ratio=decrease[scaled];[0:v][scaled]overlay=0:${top}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-t", String(videoDuration),
        "-an",
        outFile
      ]);

      console.log("Processing complete!");

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'attachment; filename="branded.mp4"');
      res.sendFile(outFile, async (err) => {
        if (err) console.error("Send file error:", err);
        await fs.rm(tDir, { recursive: true, force: true });
        await fs.rm(vDir, { recursive: true, force: true });
        console.log("Cleanup complete");
      });
      
    } catch (e) {
      console.error("Error in place-on-template:", e);
      console.error("Stack:", e.stack);
      res.status(500).json({ error: String(e.message || e) });
    }
  }
);

// Minimal debug approach - just try to copy the video first
app.post("/place-on-template-debug",
  upload.fields([{ name: "template" }, { name: "video" }]),
  async (req, res) => {
    try {
      console.log("Starting minimal debug test...");
      
      const { dir: vDir, file: vFile } = await bufferToTempWithExt(req.files.video[0].buffer, ".mp4");
      console.log(`Video file saved: ${vFile}`);

      // Test 1: Can we just copy the video?
      const outFile1 = join(tmpdir(), `test1-${Date.now()}.mp4`);
      console.log("Test 1: Simple copy...");
      await sh("ffmpeg", [
        "-y", "-i", vFile,
        "-c", "copy", // Just copy, no re-encoding
        outFile1
      ]);
      console.log("Test 1: PASSED - Simple copy works");

      // Test 2: Can we re-encode the video?
      const outFile2 = join(tmpdir(), `test2-${Date.now()}.mp4`);
      console.log("Test 2: Simple re-encode...");
      await sh("ffmpeg", [
        "-y", "-i", vFile,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-an",
        outFile2
      ]);
      console.log("Test 2: PASSED - Re-encode works");

      // Test 3: Can we scale the video?
      const outFile3 = join(tmpdir(), `test3-${Date.now()}.mp4`);
      console.log("Test 3: Scale video...");
      await sh("ffmpeg", [
        "-y", "-i", vFile,
        "-vf", "scale=1080:1344",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-an",
        outFile3
      ]);
      console.log("Test 3: PASSED - Scale works");

      // Test 4: Try the simplest possible overlay with a black background
      const outFile4 = join(tmpdir(), `test4-${Date.now()}.mp4`);
      console.log("Test 4: Overlay on black background...");
      
      // Get duration first
      const { stdout: durOut } = await sh("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1",
        vFile
      ]);
      const duration = parseFloat(durOut || "5");
      console.log(`Duration: ${duration}s`);
      
      await sh("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", `color=black:s=1080x1920:d=${duration}:r=30`,
        "-i", vFile,
        "-filter_complex", "[1:v]scale=1080:1344[scaled];[0:v][scaled]overlay=0:300",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-t", String(duration),
        "-an",
        outFile4
      ]);
      console.log("Test 4: PASSED - Basic overlay works");

      // If we get here, return the working overlay
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'attachment; filename="test-overlay.mp4"');
      res.sendFile(outFile4, async (err) => {
        if (err) console.error("Send file error:", err);
        await fs.rm(vDir, { recursive: true, force: true });
        console.log("Debug test complete");
      });
      
    } catch (e) {
      console.error("Debug test failed at:", e.message);
      console.error("Stack:", e.stack);
      res.status(500).json({ error: `Debug failed: ${e.message}` });
    }
  }
);

// Add text to PNG image with proper emoji support
app.post("/add-text", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No image file in body" });
    
    // Get text from query parameter
    const text = req.query.text || "";
    const top = Number(req.query.top || 300); // Default position
    
    if (!text.trim()) {
      return res.status(400).json({ error: "Query param 'text' is required" });
    }
    
    console.log(`Adding text: "${text}" at top: ${top}px`);
    
    const { dir, file } = await bufferToTempWithExt(req.body, ".png");
    console.log(`Image saved to: ${file}`);
    
    // Output file
    const outFile = join(tmpdir(), `text-overlay-${Date.now()}.png`);
    
    // Manual text wrapping - split text into lines that fit within the width
    const padding = 80; // Equal padding on both sides
    const maxWidth = 1080 - (padding * 2); // 920px available width
    const avgCharWidth = 24; // Account for bold font being wider
    const maxCharsPerLine = Math.floor(maxWidth / avgCharWidth); // ~38 characters
    
    // Split text into words and wrap lines
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (testLine.length <= maxCharsPerLine) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Handle very long words by breaking them
          lines.push(word);
        }
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    
    console.log(`Lines: ${JSON.stringify(lines)}`);
    
    // Create multiple drawtext filters - one for each line with emoji support
    const lineHeight = 56; // Font size + line spacing
    const textFilters = lines.map((line, index) => {
      const escapedLine = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
      const yPos = top + (index * lineHeight);
      
      // Try emoji font first, with fallback to regular bold font
      return `drawtext=text='${escapedLine}':fontfile=/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf:fontsize=44:fontcolor=white:x=${padding}:y=${yPos}:enable='between(t,0,20)'`;
    });
    
    // If emoji font fails, fallback to regular font
    const fallbackFilters = lines.map((line, index) => {
      const escapedLine = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
      const yPos = top + (index * lineHeight);
      return `drawtext=text='${escapedLine}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=44:fontcolor=white:x=${padding}:y=${yPos}`;
    });
    
    // Try with emoji font first
    try {
      const emojiFilter = textFilters.join(',');
      await sh("ffmpeg", [
        "-y", "-i", file,
        "-vf", emojiFilter,
        "-frames:v", "1",
        outFile
      ]);
      console.log("Text overlay with emoji font complete");
    } catch (emojiError) {
      console.log("Emoji font failed, using fallback font");
      const fallbackFilter = fallbackFilters.join(',');
      await sh("ffmpeg", [
        "-y", "-i", file,
        "-vf", fallbackFilter,
        "-frames:v", "1",
        outFile
      ]);
      console.log("Text overlay with fallback font complete");
    }
    
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", 'attachment; filename="text-overlay.png"');
    res.sendFile(outFile, async (err) => {
      if (err) console.error("Send file error:", err);
      await fs.rm(dir, { recursive: true, force: true });
      console.log("Cleanup complete");
    });
    
  } catch (e) {
    console.error("Error in add-text:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));