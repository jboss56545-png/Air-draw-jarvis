// api/analyze.js — ASVIRO Secure Dual-Mode Gemini Backend (Mode A: Recognition, Mode B: Conversation)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ = 25;
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

function validateImage(imageBase64, mimeType) {
  if (!imageBase64) return { ok: false, empty: true };
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(mimeType)) return { ok: false, error: "Unsupported image MIME type." };
  if (typeof imageBase64 !== "string" || imageBase64.length < 100 || imageBase64.length > 4_000_000) {
    return { ok: false, error: "Invalid or oversized drawing image (max ~3MB)." };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!allowRequest(ip)) {
    return res.status(429).json({ success: false, error: "Rate limit exceeded. Please wait a minute." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: "GEMINI_API_KEY is not configured in Vercel Environment Variables."
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const mode = body.mode === "chat" ? "chat" : "analyze";
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18_000);

    // -------------------------------------------------------------------------
    // MODE A: Drawing Recognition
    // -------------------------------------------------------------------------
    if (mode === "analyze") {
      const imgCheck = validateImage(body.imageBase64, body.mimeType);
      if (!imgCheck.ok) {
        clearTimeout(timeoutId);
        return res.status(400).json({ success: false, error: imgCheck.error || "Drawing image is required." });
      }

      const prompt = [
        "You are ASVIRO ('Your Imagination. Your AI Companion.'), a friendly, intelligent, futuristic creative AI assistant.",
        "Analyze the user's air-drawing image carefully. Never pretend to recognize something if the sketch is too vague.",
        "Respond ONLY with valid JSON matching this schema:",
        "{",
        '  "object": "Main recognized object (or Unclear Sketch if unrecognizable)",',
        '  "category": "Animal | Object | Shape | Vehicle | Fruit | Nature | Abstract",',
        '  "explanation": "1-2 clear sentences describing what you see.",',
        '  "confidence": 0.0 to 1.0,',
        '  "mood": "happy | confused",',
        '  "reply": "Natural, warm 1-2 sentence response as ASVIRO speaking directly to the creator.",',
        '  "suggestion": "1 short creative idea of what to add next."',
        "}"
      ].join("\n");

      const gRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: body.mimeType, data: body.imageBase64 } }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 420, responseMimeType: "application/json" }
        })
      });
      clearTimeout(timeoutId);

      if (!gRes.ok) {
        return res.status(gRes.status === 429 ? 429 : 502).json({
          success: false,
          error: gRes.status === 429 ? "Gemini quota reached. Try again shortly." : `Gemini API error (${gRes.status}).`
        });
      }

      const payload = await gRes.json();
      const parsed = parseAiJson(payload?.candidates?.[0]?.content?.parts?.[0]?.text || "");
      if (!parsed || typeof parsed.object !== "string") {
        return res.status(502).json({ success: false, error: "AI returned an unreadable format. Please retry." });
      }

      const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
      const isUnclear = confidence < 0.45 || parsed.mood === "confused" || parsed.object.toLowerCase().includes("unclear");

      return res.status(200).json({
        success: true,
        mode: "analyze",
        object: parsed.object.slice(0, 60),
        category: String(parsed.category || "Sketch").slice(0, 32),
        explanation: String(parsed.explanation || "A hand-drawn air sketch.").slice(0, 280),
        confidence: Number(confidence.toFixed(2)),
        mood: isUnclear ? "confused" : "happy",
        reply: String(parsed.reply || `It looks like ${parsed.object}!`).slice(0, 280),
        suggestion: String(parsed.suggestion || "Try adding extra details around it!").slice(0, 180)
      });
    }

    // -------------------------------------------------------------------------
    // MODE B: Context-Aware Conversational Question (with real drawing image)
    // -------------------------------------------------------------------------
    const question = String(body.question || "").trim().slice(0, 500);
    if (!question) {
      clearTimeout(timeoutId);
      return res.status(400).json({ success: false, error: "Question cannot be empty." });
    }

    const imgCheck = validateImage(body.imageBase64, body.mimeType);
    if (!imgCheck.ok && !imgCheck.empty) {
      clearTimeout(timeoutId);
      return res.status(400).json({ success: false, error: imgCheck.error });
    }

    const lastObject = String(body.lastObject || "").slice(0, 60);
    const toolCtx = body.toolContext && typeof body.toolContext === "object"
      ? `Active tool: ${String(body.toolContext.tool || "brush").slice(0, 16)}, color: ${String(body.toolContext.color || "#00e5ff").slice(0, 20)}, size: ${Number(body.toolContext.size) || 9}px.`
      : "";
    const langHint = body.lang === "hi-IN" ? "Respond naturally in Hindi (or Hinglish if the user spoke English words) matching the user's language." : "Respond in natural, clear English (unless the user wrote in Hindi).";

    const systemInstruction = [
      "You are ASVIRO ('Your Imagination. Your AI Companion.'), a friendly, intelligent, curious futuristic creative AI assistant inside an air-drawing web studio.",
      "Rules:",
      "- Speak naturally like a helpful companion, never robotic.",
      "- Keep replies concise (1-3 clear sentences) so they sound great when read aloud.",
      "- If a drawing image is attached, inspect the ACTUAL image yourself rather than blindly trusting prior labels.",
      "- If you don't know or the drawing is ambiguous, say so honestly.",
      lastObject ? `Previous recognized object in session: "${lastObject}".` : "No object has been formally labeled yet.",
      toolCtx,
      langHint,
      "Return ONLY valid JSON: {\"reply\": \"...\", \"suggestion\": \"optional short tip or empty\", \"mood\": \"happy | thinking | confused\", \"recognizedObject\": \"optional updated object name if clearly visible\"}"
    ].filter(Boolean).join("\n");

    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const contents = history
      .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string")
      .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 350) }] }));

    const userParts = [{ text: question }];
    if (imgCheck.ok) {
      userParts.push({ inlineData: { mimeType: body.mimeType, data: body.imageBase64 } });
    }
    contents.push({ role: "user", parts: userParts });

    const gRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { temperature: 0.65, maxOutputTokens: 320, responseMimeType: "application/json" }
      })
    });
    clearTimeout(timeoutId);

    if (!gRes.ok) {
      return res.status(gRes.status === 429 ? 429 : 502).json({
        success: false,
        error: gRes.status === 429 ? "Gemini rate limit reached. Try again shortly." : `Conversation AI error (${gRes.status}).`
      });
    }

    const payload = await gRes.json();
    const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = parseAiJson(rawText);

    const reply = parsed?.reply
      ? String(parsed.reply).slice(0, 460)
      : rawText.trim().slice(0, 460);

    if (!reply) {
      return res.status(502).json({ success: false, error: "Empty response from ASVIRO AI." });
    }

    const mood = parsed?.mood === "confused" ? "confused" : "happy";
    return res.status(200).json({
      success: true,
      mode: "chat",
      reply,
      suggestion: parsed?.suggestion ? String(parsed.suggestion).slice(0, 160) : "",
      mood,
      recognizedObject: parsed?.recognizedObject ? String(parsed.recognizedObject).slice(0, 60) : ""
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ success: false, error: "ASVIRO AI request timed out." });
    }
    return res.status(500).json({ success: false, error: "Server error processing request." });
  }
                                   }
