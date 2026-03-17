/**
 * voice-agent-browser.js
 * ─────────────────────────────────────────────────────────────
 * Browser Microphone  ←→  Deepgram Voice Agent API
 *
 * The browser connects to /ws/voice-agent (this server).
 * This server proxies to Deepgram Voice Agent.
 * API key stays on the server — never exposed to the browser.
 *
 * Audio format: linear16, 24 000 Hz (browser-friendly, no plugin needed)
 * ─────────────────────────────────────────────────────────────
 */

const url    = require("url");
const WS     = require("ws");
const { db } = require("../database");

const CHANNEL = "voice-agent-browser";
const DG_URL  = "wss://agent.deepgram.com/agent";

function getPrompt() {
  // Reuse the same env var as Twilio channel
  return process.env.VOICE_AGENT_PROMPT || `
You are the AI receptionist of Wagenbaas, an auto repair garage in Apeldoorn, Netherlands.

LANGUAGE: Respond in the visitor's language (NL / EN / DE / FR). Default to Dutch.

VOICE RULES:
- Keep responses to 1–2 sentences unless asked for more detail.
- No markdown, no bullet points — spoken audio only.
- Speak naturally and conversationally.

BUSINESS INFO:
- Address: Molenmakershoek 10, 7328 JK Apeldoorn
- Phone: +31 64 77 000 88
- Email: info@wagenbaas.nl
- Hours: Mon-Fri 08:30-18:00 | Sat 09:00-18:00 | Sunday closed

SERVICES: APK keuring, onderhoud, reparatie, banden, airco.

PRIMARY GOAL — BOOK THE APPOINTMENT:
Collect: name + phone + license plate + preferred date/time + service.
Ask max 2 questions at once. Suggest a specific time if unclear.

NEVER LOSE A LEAD: If not ready to book, collect name + phone for follow-up.
IF VISITOR WANTS A HUMAN: Ask name + phone, say someone will follow up shortly.
`.trim();
}

function buildSettings() {
  const sttModel = process.env.DEEPGRAM_AGENT_STT_MODEL  || "nova-3";
  const llmModel = process.env.DEEPGRAM_AGENT_LLM_MODEL  || "claude-haiku-4-5-20251001";
  const ttsModel = process.env.DEEPGRAM_AGENT_TTS_MODEL  || "aura-2-thalia-en";
  const temp     = parseFloat(process.env.DEEPGRAM_AGENT_TEMPERATURE || "0.3");
  const greeting = process.env.VOICE_AGENT_GREETING || "Goedendag, u bent verbonden met Wagenbaas. Hoe kan ik u helpen?";

  return {
    type: "Settings",
    audio: {
      // Browser sends linear16 PCM at 24 kHz
      input:  { encoding: "linear16", sample_rate: 24000 },
      // Deepgram returns linear16 24 kHz — browser decodes and plays
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      listen: {
        provider: {
          type:     "deepgram",
          model:    sttModel,
          language: "multi",
        },
      },
      think: {
        provider: {
          type:        "anthropic",
          model:       llmModel,
          temperature: temp,
        },
        prompt: getPrompt(),
      },
      speak: {
        provider: {
          type:  "deepgram",
          model: ttsModel,
        },
      },
      greeting: greeting,
    },
  };
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function register(app, { server } = {}) {
  if (!server) throw new Error("[voice-agent-browser] requires { server }");

  const wss = new WS.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url || "");
    if (pathname !== "/ws/voice-agent") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (browserWs) => {
    const sessionId = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let dgWs     = null;
    let keepAlive = null;

    const log = (msg) => console.log(`[VoiceAgent-Browser:${sessionId}] ${msg}`);

    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      log("ERROR: DEEPGRAM_API_KEY not set");
      browserWs.send(JSON.stringify({ type: "error", message: "Voice agent not configured — missing DEEPGRAM_API_KEY" }));
      browserWs.close();
      return;
    }

    // ── Connect to Deepgram ───────────────────────────────────────────────────
    dgWs = new WS(DG_URL, { headers: { Authorization: `Token ${key}` } });

    dgWs.on("open", () => {
      log("Deepgram Voice Agent connected — sending Settings");
      dgWs.send(JSON.stringify(buildSettings()));

      keepAlive = setInterval(() => {
        if (dgWs.readyState === WS.OPEN) {
          dgWs.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 5000);
    });

    dgWs.on("message", (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        // Raw PCM audio → forward to browser
        if (browserWs.readyState === WS.OPEN) {
          try { browserWs.send(data, { binary: true }); } catch {}
        }
        return;
      }

      // JSON event → forward to browser + log transcripts
      const raw = data.toString("utf8");
      const msg = safeJSON(raw);
      if (!msg) return;

      if (browserWs.readyState === WS.OPEN) {
        try { browserWs.send(raw); } catch {}
      }

      if (msg.type === "ConversationText" && msg.content) {
        const role = msg.role === "user" ? "user" : "agent";
        console.log(`[VoiceAgent-Browser transcript] ${role}: ${msg.content}`);
        try {
          db.insertMessage({
            $session_id: sessionId,
            $channel:    CHANNEL,
            $direction:  role === "user" ? "inbound" : "outbound",
            $from_id:    role === "user" ? sessionId : "wagenbaas-agent",
            $from_name:  role === "user" ? "Web Visitor" : "Wagenbaas AI",
            $content:    msg.content,
          });
        } catch {}
      }

      if (msg.type === "SettingsApplied") {
        log("Settings applied — agent ready");
      }
      if (msg.type === "Error") {
        log(`Deepgram error: ${msg.message || JSON.stringify(msg)}`);
      }
    });

    dgWs.on("error", (e) => {
      log(`Deepgram WS error: ${e.message}`);
      try { browserWs.send(JSON.stringify({ type: "error", message: e.message })); } catch {}
    });

    dgWs.on("close", (code) => {
      log(`Deepgram WS closed (code ${code})`);
      clearInterval(keepAlive);
      try { browserWs.close(); } catch {}
    });

    // ── Receive from browser ──────────────────────────────────────────────────
    browserWs.on("message", (data, isBinary) => {
      if (!dgWs || dgWs.readyState !== WS.OPEN) return;

      if (isBinary || Buffer.isBuffer(data)) {
        // Raw PCM audio from browser mic → forward to Deepgram
        try { dgWs.send(data, { binary: true }); } catch {}
        return;
      }

      // Text control message from browser
      const msg = safeJSON(data.toString("utf8"));
      if (!msg) return;

      if (msg.type === "UpdateInstructions" && msg.instructions) {
        // Allow frontend to inject context mid-call
        try {
          dgWs.send(JSON.stringify({
            type:         "UpdateInstructions",
            instructions: msg.instructions,
          }));
        } catch {}
      }
    });

    browserWs.on("close", () => {
      log("Browser WS closed");
      clearInterval(keepAlive);
      try { if (dgWs) dgWs.close(); } catch {}
    });

    browserWs.on("error", (e) => {
      try { log(`Browser WS error: ${e.message}`); } catch {}
    });
  });

  console.log("🎙️  Voice Agent Browser channel registered (WS /ws/voice-agent)");
}

module.exports = { register };
