// server.js — crop black/white + utility endpoints + place-on-template
import express from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import multer from "multer";
import { createCanvas, loadImage, registerFont } from 'canvas';

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
    "-c:v", "libx264", "-crf", "18", "-preset", "ultrafast", // Changed to ultrafast
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-avoid_negative_ts", "make_zero",
    "-threads", "4", // Limit threads
    "-an",
    outFile
  ]);
}

// ------------------------------
// DETECTORS
// ------------------------------
async function detectDarkCrop(file, seconds = 2) { // Reduced from 4 to 2 seconds
  const vf = "format=gray,boxblur=16:1:cr=0:ar=0,cropdetect=limit=24:round=2:reset=0";
  try {
    const { stderr } = await sh("ffmpeg", [
      "-y", "-ss", "2", "-t", String(seconds), // Start at 2 seconds to skip intro
      "-i", file, "-vf", vf, "-f", "null", 
      "-avoid_negative_ts", "make_zero",
      "-threads", "4", // Limit threads to prevent overload
      "-"
    ]);
    return parseCrop(stderr);
  } catch { return null; }
}

async function detectWhiteCrop(file, seconds = 3) { // Reduced from 6 to 3 seconds
  const pipelines = [
    "format=gray,boxblur=28:1:cr=0:ar=0,lut=y='val>238?0:255',cropdetect=limit=6:round=2:reset=0",
    "format=gray,boxblur=34:1:cr=0:ar=0,lut=y='val>240?0:255',cropdetect=limit=8:round=2:reset=0"
    // Removed the slower pipelines to speed up processing
  ];
  for (const vf of pipelines) {
    try {
      const { stderr } = await sh("ffmpeg", [
        "-y", "-ss", "2", "-t", String(seconds), // Start at 2 seconds
        "-i", file, "-vf", vf, "-f", "null",
        "-avoid_negative_ts", "make_zero",
        "-threads", "4", // Limit threads
        "-"
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

// Crop a tiny strip from top (percent) - OPTIMIZED VERSION
app.post("/crop-strip-top", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No file" });
    const percent = Number(req.query.percent || 5);
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `cropapi-${Date.now()}-strip.mp4`);
    const vf = `crop=in_w:in_h*${(100 - percent) / 100}:0:in_h*${percent / 100}`;
    await sh("ffmpeg", [
      "-y", "-i", file, "-vf", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "ultrafast", // Changed to ultrafast
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-avoid_negative_ts", "make_zero", // Added timestamp fix
      "-threads", "4", // Added thread limit
      "-an", outFile
    ]);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');
    res.sendFile(outFile, async () => { await fs.rm(dir, { recursive: true, force: true }); });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Place a cropped video onto a 1080x1920 PNG template - OPTIMIZED VERSION
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

      // Create template video background with optimizations
      console.log("Creating template background...");
      const templateVideo = join(tDir, "template_bg.mp4");
      await sh("ffmpeg", [
        "-y",
        "-loop", "1", "-i", tFile,
        "-t", String(videoDuration),
        "-r", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-avoid_negative_ts", "make_zero", // Added timestamp fix
        "-threads", "4", // Added thread limit
        templateVideo
      ]);

      // Final composition with optimizations
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
        "-avoid_negative_ts", "make_zero", // Added timestamp fix
        "-threads", "4", // Added thread limit
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

// Canvas-based text rendering with actual colored emoji images
app.post("/add-text-canvas", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No image file in body" });
    
    const text = req.query.text || "";
    const top = Number(req.query.top || 300);
    
    if (!text.trim()) {
      return res.status(400).json({ error: "Query param 'text' is required" });
    }
    
    console.log(`Canvas: Adding text "${text}" at top: ${top}px`);
    
    // Save input image
    const { dir, file } = await bufferToTempWithExt(req.body, ".png");
    
    // Load the background image
    const backgroundImage = await loadImage(file);
    const canvas = createCanvas(backgroundImage.width, backgroundImage.height);
    const ctx = canvas.getContext('2d');
    
    // Draw background image
    ctx.drawImage(backgroundImage, 0, 0);
    
    // Configure text styling
    const fontSize = 44;
    const emojiSize = 48; // Slightly larger than text for visibility
    const padding = 80;
    const maxWidth = canvas.width - (padding * 2);
    const lineHeight = 56;
    
    // Register fonts
    try {
      registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'DejaVu Sans', weight: 'bold' });
    } catch (e) {
      console.log("Font registration failed, using default");
    }
    
    // Set font properties
    ctx.font = `bold ${fontSize}px "DejaVu Sans", sans-serif`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'top';
    
    // Function to get Twemoji URL for emoji
    function getEmojiUrl(emoji) {
      const codePoint = emoji.codePointAt(0).toString(16);
      return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codePoint}.png`;
    }
    
    // Function to detect emojis in text
    function parseTextWithEmojis(text) {
      const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu;
      const parts = [];
      let lastIndex = 0;
      let match;
      
      while ((match = emojiRegex.exec(text)) !== null) {
        // Add text before emoji
        if (match.index > lastIndex) {
          parts.push({
            type: 'text',
            content: text.slice(lastIndex, match.index)
          });
        }
        
        // Add emoji
        parts.push({
          type: 'emoji',
          content: match[0],
          url: getEmojiUrl(match[0])
        });
        
        lastIndex = emojiRegex.lastIndex;
      }
      
      // Add remaining text
      if (lastIndex < text.length) {
        parts.push({
          type: 'text',
          content: text.slice(lastIndex)
        });
      }
      
      return parts;
    }
    
    // Function to measure text width including emojis
    function measureTextWithEmojis(parts) {
      let width = 0;
      for (const part of parts) {
        if (part.type === 'text') {
          width += ctx.measureText(part.content).width;
        } else if (part.type === 'emoji') {
          width += emojiSize; // Approximate emoji width
        }
      }
      return width;
    }
    
    // Word wrapping with emoji support
    function wrapTextWithEmojis(text, maxWidth) {
      const words = text.split(' ');
      const lines = [];
      let currentLine = '';
      
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const parts = parseTextWithEmojis(testLine);
        const width = measureTextWithEmojis(parts);
        
        if (width <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            lines.push(word);
          }
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
      return lines;
    }
    
    // Function to render a line with emojis
    async function renderLineWithEmojis(line, x, y) {
      const parts = parseTextWithEmojis(line);
      let currentX = x;
      
      for (const part of parts) {
        if (part.type === 'text') {
          ctx.fillText(part.content, currentX, y);
          currentX += ctx.measureText(part.content).width;
        } else if (part.type === 'emoji') {
          try {
            // Download and draw emoji image
            const emojiImage = await loadImage(part.url);
            ctx.drawImage(emojiImage, currentX, y - 4, emojiSize, emojiSize);
            currentX += emojiSize;
          } catch (emojiError) {
            console.log(`Failed to load emoji ${part.content}, using fallback`);
            // Fallback: draw the emoji character
            ctx.fillText(part.content, currentX, y);
            currentX += ctx.measureText(part.content).width;
          }
        }
      }
    }
    
    // Wrap text and render each line
    const lines = wrapTextWithEmojis(text, maxWidth);
    console.log(`Canvas: Wrapped into ${lines.length} lines`);
    
    for (let i = 0; i < lines.length; i++) {
      const y = top + (i * lineHeight);
      await renderLineWithEmojis(lines[i], padding, y);
    }
    
    // Convert canvas to buffer
    const buffer = canvas.toBuffer('image/png');
    
    // Clean up
    await fs.rm(dir, { recursive: true, force: true });
    
    console.log("Canvas text rendering with colored emojis complete");
    
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", 'attachment; filename="canvas-text-overlay.png"');
    res.send(buffer);
    
  } catch (e) {
    console.error("Error in canvas text rendering:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Unified video manipulation endpoint
app.post("/manipulate-video", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No video file in body" });
    
    const effect = req.query.effect;
    const validEffects = ['zoom', 'speed', 'slow', 'mirror', 'crop-top', 'crop-bottom', 'crop-sides', 'bars-horizontal', 'bars-vertical', 'bars-top'];
    
    if (!effect || !validEffects.includes(effect)) {
      return res.status(400).json({ 
        error: `Invalid effect. Must be one of: ${validEffects.join(', ')}` 
      });
    }
    
    console.log(`Applying effect: ${effect}`);
    
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `manipulated-${Date.now()}-${effect}.mp4`);
    
    let ffmpegArgs = ["-y", "-i", file];
    
    // Apply the specific effect
    switch (effect) {
      case 'zoom':
        // 5% zoom in (scale up and crop center)
        ffmpegArgs.push(
          "-vf", "scale=iw*1.05:ih*1.05,crop=iw/1.05:ih/1.05:(iw-iw/1.05)/2:(ih-ih/1.05)/2"
        );
        break;
        
      case 'speed':
        // 5% speed up
        ffmpegArgs.push("-vf", "setpts=PTS/1.05");
        break;
        
      case 'slow':
        // 5% slow down
        ffmpegArgs.push("-vf", "setpts=PTS*1.05");
        break;
        
      case 'mirror':
        // Horizontal flip
        ffmpegArgs.push("-vf", "hflip");
        break;
        
      case 'crop-top':
        // Crop 5% from top
        ffmpegArgs.push("-vf", "crop=iw:ih*0.95:0:ih*0.05");
        break;
        
      case 'crop-bottom':
        // Crop 5% from bottom
        ffmpegArgs.push("-vf", "crop=iw:ih*0.95:0:0");
        break;
        
      case 'crop-sides':
        // Crop 2% from each side (4% total width reduction)
        ffmpegArgs.push("-vf", "crop=iw*0.96:ih:iw*0.02:0");
        break;
        
      case 'bars-horizontal':
        // Add thin black bars top and bottom (2% each)
        ffmpegArgs.push("-vf", "pad=iw:ih*1.04:0:ih*0.02:black");
        break;
        
      case 'bars-vertical':
        // Add thin black bars left and right (2% each)
        ffmpegArgs.push("-vf", "pad=iw*1.04:ih:iw*0.02:0:black");
        break;
        
      case 'bars-top':
        // Add thin black bar top only (2%)
        ffmpegArgs.push("-vf", "pad=iw:ih*1.02:0:ih*0.02:black");
        break;
    }
    
    // Add encoding settings with optimizations
    ffmpegArgs.push(
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-avoid_negative_ts", "make_zero",
      "-threads", "4",
      "-an", // Remove audio
      outFile
    );
    
    await sh("ffmpeg", ffmpegArgs);
    
    console.log(`Effect ${effect} applied successfully`);
    
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${effect}-manipulated.mp4"`);
    res.sendFile(outFile, async (err) => {
      if (err) console.error("Send file error:", err);
      await fs.rm(dir, { recursive: true, force: true });
      console.log("Cleanup complete");
    });
    
  } catch (e) {
    console.error("Error in video manipulation:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Store video and return clean URL
app.post("/store-video", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No video file in body" });
    
    console.log(`Storing video, size: ${req.body.length} bytes`);
    
    // Generate unique filename
    const videoId = `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const videoPath = join(tmpdir(), `${videoId}.mp4`);
    
    // Store the video file
    await fs.writeFile(videoPath, req.body);
    
    // Return clean URL
    const videoUrl = `https://ffmpeg-crop-api-production.up.railway.app/get-video/${videoId}`;
    
    console.log(`Video stored with ID: ${videoId}`);
    
    res.json({
      success: true,
      videoUrl: videoUrl,
      videoId: videoId,
      fileSize: req.body.length
    });
    
  } catch (e) {
    console.error("Error storing video:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve stored videos
app.get("/get-video/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    const videoPath = join(tmpdir(), `${videoId}.mp4`);
    
    // Check if video exists
    try {
      await fs.access(videoPath);
    } catch {
      return res.status(404).json({ error: "Video not found" });
    }
    
    console.log(`Serving video: ${videoId}`);
    
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="video.mp4"');
    res.sendFile(videoPath);
    
  } catch (e) {
    console.error("Error serving video:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Merge Instagram audio with uploaded video
app.post("/merge-instagram-audio", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No video file in body" });
    
    const instagramUrl = req.query.url;
    if (!instagramUrl) {
      return res.status(400).json({ error: "Instagram URL required as 'url' query parameter" });
    }
    
    console.log(`Merging Instagram audio from: ${instagramUrl}`);
    console.log(`Video size: ${req.body.length} bytes`);
    
    // Save input video
    const { dir: videoDir, file: videoFile } = await bufferToTemp(req.body);
    
    // Create temp directory for audio download
    const audioDir = await fs.mkdtemp(join(tmpdir(), "instagram-audio-"));
    const audioFile = join(audioDir, "audio.%(ext)s");
    
    try {
      // Step 1: Download audio from Instagram reel using yt-dlp
      console.log("Downloading Instagram audio...");
      await sh("yt-dlp", [
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0", // Best quality
        "-o", audioFile,
        instagramUrl
      ]);
      
      // Find the downloaded audio file (yt-dlp adds extension)
      const audioFiles = await fs.readdir(audioDir);
      const downloadedAudio = audioFiles.find(f => f.startsWith('audio.'));
      
      if (!downloadedAudio) {
        throw new Error("Failed to download audio from Instagram URL");
      }
      
      const actualAudioFile = join(audioDir, downloadedAudio);
      console.log(`Audio downloaded: ${downloadedAudio}`);
      
      // Step 2: Merge video with Instagram audio using FFmpeg
      console.log("Merging video with Instagram audio...");
      const outFile = join(tmpdir(), `merged-${Date.now()}.mp4`);
      
      await sh("ffmpeg", [
        "-y",
        "-i", videoFile,        // Input video (silent)
        "-i", actualAudioFile,  // Input audio from Instagram
        "-c:v", "copy",         // Copy video stream without re-encoding
        "-c:a", "aac",          // Encode audio as AAC
        "-map", "0:v:0",        // Map video from first input
        "-map", "1:a:0",        // Map audio from second input
        "-shortest",            // Stop at shortest stream length
        "-avoid_negative_ts", "make_zero",
        "-threads", "4",
        outFile
      ]);
      
      console.log("Audio merge complete");
      
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'attachment; filename="video-with-instagram-audio.mp4"');
      res.sendFile(outFile, async (err) => {
        if (err) console.error("Send file error:", err);
        // Cleanup
        await fs.rm(videoDir, { recursive: true, force: true });
        await fs.rm(audioDir, { recursive: true, force: true });
        console.log("Cleanup complete");
      });
      
    } catch (downloadError) {
      console.error("Download/merge error:", downloadError);
      // Cleanup on error
      await fs.rm(videoDir, { recursive: true, force: true });
      await fs.rm(audioDir, { recursive: true, force: true });
      throw downloadError;
    }
    
  } catch (e) {
    console.error("Error in Instagram audio merge:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Expand image to 1920x1080 with blurred background
app.post("/expand-image", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No image file in body" });
    
    console.log(`Expanding image to 1920x1080, input size: ${req.body.length} bytes`);
    
    // Save input image
    const { dir, file } = await bufferToTempWithExt(req.body, ".jpg");
    const bgFile = join(dir, "background.jpg");
    const fgFile = join(dir, "foreground.jpg");
    const outFile = join(tmpdir(), `expanded-${Date.now()}.jpg`);
    
    console.log("Step 1: Creating blurred background");
    // Step 1: Create blurred background (scale to fill 1920x1080 and blur)
    await sh("ffmpeg", [
      "-y",
      "-i", file,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=20",
      "-q:v", "2",
      "-threads", "2",
      bgFile
    ]);
    
    console.log("Step 2: Creating scaled foreground");
    // Step 2: Create scaled foreground (fit within 1920x1080)
    await sh("ffmpeg", [
      "-y",
      "-i", file,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease",
      "-q:v", "2",
      "-threads", "2",
      fgFile
    ]);
    
    console.log("Step 3: Compositing images");
    // Step 3: Overlay foreground on background
    await sh("ffmpeg", [
      "-y",
      "-i", bgFile,
      "-i", fgFile,
      "-filter_complex", "[0:v][1:v]overlay=(W-w)/2:(H-h)/2",
      "-q:v", "2",
      "-threads", "2",
      outFile
    ]);
    
    console.log("Image expansion complete");
    
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="expanded-1920x1080.jpg"');
    res.sendFile(outFile, async (err) => {
      if (err) console.error("Send file error:", err);
      await fs.rm(dir, { recursive: true, force: true });
      console.log("Cleanup complete");
    });
    
  } catch (e) {
    console.error("Error expanding image:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Extract audio from MP4 video as MP3
app.post("/extract-audio", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No video file in body" });
    
    console.log(`Extracting audio from video, input size: ${req.body.length} bytes`);
    
    // Save input video
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `extracted-audio-${Date.now()}.mp3`);
    
    // Extract audio using FFmpeg
    await sh("ffmpeg", [
      "-y",
      "-i", file,           // Input video file
      "-vn",                // Disable video stream
      "-acodec", "libmp3lame", // Use MP3 encoder
      "-ab", "192k",        // Audio bitrate 192kbps (good quality)
      "-ar", "44100",       // Sample rate 44.1kHz
      "-ac", "2",           // Stereo audio
      "-avoid_negative_ts", "make_zero",
      "-threads", "4",
      outFile
    ]);
    
    console.log("Audio extraction complete");
    
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="extracted-audio.mp3"');
    res.sendFile(outFile, async (err) => {
      if (err) console.error("Send file error:", err);
      await fs.rm(dir, { recursive: true, force: true });
      console.log("Cleanup complete");
    });
    
  } catch (e) {
    console.error("Error extracting audio:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Add this endpoint after your existing endpoints in server.js

app.post("/extract-screenshots", upload.single("video"), async (req, res) => {
  const tempDir = join(tmpdir(), `screenshots-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  
  try {
    console.log("Creating temp directory for screenshots");
    await fs.mkdir(tempDir, { recursive: true });

    const inputPath = join(tempDir, "input.mp4");
    await fs.writeFile(inputPath, req.file.buffer);

    console.log("Getting video duration");
    // First, get the video duration
    const durationPromise = new Promise((resolve, reject) => {
      const process = spawn("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        inputPath
      ]);

      let output = "";
      process.stdout.on("data", (data) => {
        output += data.toString();
      });

      process.on("close", (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(output);
            const duration = parseFloat(info.format.duration);
            resolve(duration);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`ffprobe failed with code ${code}`));
        }
      });
    });

    const duration = await durationPromise;
    console.log(`Video duration: ${duration} seconds`);

    // Calculate 5 evenly spaced timestamps (avoiding very start and end)
    const interval = duration / 6; // 6 intervals for 5 screenshots in the middle
    const timestamps = [];
    for (let i = 1; i <= 5; i++) {
      timestamps.push(interval * i);
    }

    console.log("Timestamps for screenshots:", timestamps);

    // Extract screenshots at calculated timestamps
    const screenshotPromises = timestamps.map((timestamp, index) => {
      return new Promise((resolve, reject) => {
        const outputPath = join(tempDir, `screenshot_${index + 1}.jpg`);
        
        const process = spawn("ffmpeg", [
          "-ss", timestamp.toString(),
          "-i", inputPath,
          "-vframes", "1",
          "-q:v", "2", // High quality
          "-y", // Overwrite output files
          "-threads", "4",
          "-preset", "ultrafast",
          outputPath
        ]);

        process.on("close", (code) => {
          if (code === 0) {
            console.log(`Screenshot ${index + 1} extracted successfully`);
            resolve(outputPath);
          } else {
            reject(new Error(`Screenshot extraction failed for timestamp ${timestamp}`));
          }
        });

        process.stderr.on("data", (data) => {
          console.log(`FFmpeg stderr: ${data}`);
        });
      });
    });

    console.log("Extracting all screenshots simultaneously");
    const screenshotPaths = await Promise.all(screenshotPromises);

    // Read all screenshot files
    const screenshots = await Promise.all(
      screenshotPaths.map(async (path, index) => {
        const buffer = await fs.readFile(path);
        return {
          filename: `screenshot_${index + 1}.jpg`,
          buffer: buffer,
          size: buffer.length
        };
      })
    );

    console.log("All screenshots extracted successfully");

    // For now, return the first screenshot as response
    // You can modify this to return all screenshots as needed
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", "attachment; filename=screenshot_1.jpg");
    res.send(screenshots[0].buffer);

  } catch (error) {
    console.error("Screenshot extraction failed:", error);
    res.status(500).json({ 
      error: "Screenshot extraction failed", 
      message: error.message 
    });
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log("Temp directory cleaned up");
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }
  }
});

// Crop 15% from top and 15% from bottom (keeps middle 70%)
app.post("/crop-top-bottom-15", rawUpload, async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: "No video file in body" });
    
    console.log(`Cropping 15% from top and bottom, input size: ${req.body.length} bytes`);
    
    const { dir, file } = await bufferToTemp(req.body);
    const outFile = join(tmpdir(), `cropped-tb15-${Date.now()}.mp4`);
    
    // Crop: keep middle 70% of height (15% from top, 15% from bottom)
    // crop=width:height:x:y
    // width = input width (iw)
    // height = 70% of input height (ih*0.7)
    // x = 0 (no horizontal crop)
    // y = 15% from top (ih*0.15)
    await sh("ffmpeg", [
      "-y",
      "-i", file,
      "-vf", "crop=iw:ih*0.7:0:ih*0.15",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-avoid_negative_ts", "make_zero",
      "-threads", "4",
      "-c:a", "copy", // Copy audio stream without re-encoding
      outFile
    ]);
    
    console.log("Cropping complete");
    
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="cropped-top-bottom-15.mp4"');
    res.sendFile(outFile, async (err) => {
      if (err) console.error("Send file error:", err);
      await fs.rm(dir, { recursive: true, force: true });
      console.log("Cleanup complete");
    });
    
  } catch (e) {
    console.error("Error cropping video:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Add this endpoint after your existing endpoints in server.js

app.post("/extract-screenshots", upload.single("video"), async (req, res) => {

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 8080, () => console.log("Crop API running"));