// api/analyze.js — Secure Gemini Vision Serverless Endpoint for Vercel
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ = 15;
const rateMap = new Map();

function allowRequest(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX_REQ) return false;
  entry.count += 1;
  return true;
}

function parseAiJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!allowRequest(ip)) {
    return res.status(429).json({ success: false, error: "Too many AI requests. Please wait a minute." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: "GEMINI_API_KEY is not configured. Add it in Vercel Project Settings -> Environment Variables."
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { imageBase64, mimeType } = body;

    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowedTypes.has(mimeType)) {
      return res.status(400).json({ success: false, error: "Unsupported image format." });
    }
    if (typeof imageBase64 !== "string" || imageBase64.length < 100 || imageBase64.length > 4_000_000) {
      return res.status(400).json({ success: false, error: "Invalid or oversized drawing image (max ~3MB)." });
    }

    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const prompt = [
      "You are ASVIRO AI, a friendly futuristic assistant inside an air-drawing web app.",
      "Examine the user's sketch carefully. Respond ONLY with a valid JSON object matching this schema:",
      "{",
      '  "object": "Main recognized object (or Unclear Sketch if unrecognizable)",',
      '  "category": "Animal | Object | Shape | Vehicle | Fruit | Nature | Abstract",',
      '  "explanation": "Short 1-2 sentence explanation of what you see in the drawing.",',
      '  "confidence": 0.0 to 1.0 number,',
      '  "mood": "happy | confused",',
      '  "reply": "Short friendly, enthusiastic character dialogue (1-2 sentences) reacting to the sketch.",',
      '  "suggestion": "One short creative idea of what to add next."',
      "}"
    ].join("\n");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18_000);

    const gRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: imageBase64 } }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 400,
          responseMimeType: "application/json"
        }
      })
    });
    clearTimeout(timeoutId);

    if (!gRes.ok) {
      if (gRes.status === 429) {
        return res.status(429).json({ success: false, error: "Gemini API rate limit reached. Try again shortly." });
      }
      return res.status(502).json({ success: false, error: `Gemini API error (${gRes.status}). Check your API key or model.` });
    }

    const payload = await gRes.json();
    const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = parseAiJson(rawText);

    if (!parsed || typeof parsed.object !== "string") {
      return res.status(502).json({ success: false, error: "AI returned an invalid response format. Please retry." });
    }

    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
    const isUnclear = confidence < 0.45 || parsed.mood === "confused" || parsed.object.toLowerCase().includes("unclear");

    return res.status(200).json({
      success: true,
      object: parsed.object.slice(0, 60),
      category: String(parsed.category || "Sketch").slice(0, 32),
      explanation: String(parsed.explanation || "A hand-drawn air sketch.").slice(0, 260),
      confidence: Number(confidence.toFixed(2)),
      mood: isUnclear ? "confused" : "happy",
      reply: String(parsed.reply || `I see a ${parsed.object}! Great air sketching!`).slice(0, 260),
      suggestion: String(parsed.suggestion || "Try adding more details or colors!").slice(0, 160)
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ success: false, error: "AI request timed out. Please try again." });
    }
    return res.status(500).json({ success: false, error: "Server error while analyzing drawing." });
  }
      }
