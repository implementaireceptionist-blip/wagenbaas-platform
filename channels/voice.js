const url = require("url");
const WebSocket = require("ws");
const axios = require("axios");
const { getAIReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");

const CHANNEL = "voice";

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function base64ToBuf(b64) {
  return Buffer.from(b64 || "", "base64");
}

async function elevenlabsTtsMp3(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs not configured");
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_22050_32&optimize_streaming_latency=3`;
  const resp = await axios.post(endpoint, {
    text,
    model_id: "eleven_multilingual_v2",
  }, {
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    responseType: "arraybuffer",
    timeout: 15000,
    maxBodyLength: Infinity,
  });
  return Buffer.from(resp.data);
}

function deepgramUrlFor(format) {
  // Telnyx default is PCMU (mu-law) 8k; map to Deepgram params.
  const encoding = (format?.encoding || "PCMU").toUpperCase();
  const sampleRate = Number(format?.sample_rate || 8000) || 8000;
  const channels = Number(format?.channels || 1) || 1;
  const dgEnc = encoding === "PCMA" ? "alaw" : "mulaw";

  // Keep cheap + good: Nova-2. Language auto; you can enforce NL if you want.
  const qs = new URLSearchParams({
    encoding: dgEnc,
    sample_rate: String(sampleRate),
    channels: String(channels),
    model: "nova-2",
    punctuate: "true",
    interim_results: "true",
    endpointing: "200",
    vad_events: "true",
  });

  return `wss://api.deepgram.com/v1/listen?${qs.toString()}`;
}

function register(app, { server } = {}) {
  if (!server) throw new Error("Voice channel requires { server }");

  // TeXML webhook for incoming call
  app.post("/api/voice/inbound", (req, res) => {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().toLowerCase();
    const wsProto = proto === "http" ? "ws" : "wss";

    const greeting = (process.env.VOICE_GREETING_NL || "Goedendag, u bent verbonden met Wagenbaas. Ik ben de AI-receptioniste. Hoe kan ik u helpen?").trim();

    // Bidirectional media: we send MP3 back over the same WebSocket.
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lotte" language="nl-NL">${escapeXml(greeting)}</Say>
  <Start>
    <Stream url="${wsProto}://${host}/api/voice/stream" track="inbound_track" bidirectionalMode="mp3">
      <Parameter name="channel" value="voice" />
    </Stream>
  </Start>
  <Pause length="600"/>
</Response>`;

    res.type("text/xml").send(texml);
  });

  // WebSocket server (Telnyx media streaming)
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url || "");
    if (pathname !== "/api/voice/stream") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (telnyxWs) => {
    let streamId = null;
    let callControlId = null;
    let fromNumber = null;
    let toNumber = null;
    let mediaFormat = null;

    let dgWs = null;
    let conversation = [];

    let speaking = false; // we are currently playing TTS
    let lastMark = null;
    let lastUserUtteranceAt = 0;
    let pendingText = "";

    function logSys(msg) {
      const sid = fromNumber || callControlId || "unknown";
      db.insertMessage({
        $session_id: sid,
        $channel: CHANNEL,
        $direction: "outbound",
        $from_id: "system",
        $from_name: "Voice System",
        $content: `[${nowIso()}] ${msg}`,
      });
    }

    async function ensureDeepgram() {
      if (dgWs && dgWs.readyState === WebSocket.OPEN) return;
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) throw new Error("Deepgram not configured");

      const dgUrl = deepgramUrlFor(mediaFormat);
      dgWs = new WebSocket(dgUrl, {
        headers: { Authorization: `Token ${key}` },
      });

      dgWs.on("open", () => logSys("Deepgram connected"));
      dgWs.on("error", (e) => logSys(`Deepgram error: ${e.message}`));
      dgWs.on("close", () => logSys("Deepgram closed"));

      dgWs.on("message", async (data) => {
        const msg = safeJsonParse(data.toString("utf8"));
        if (!msg) return;

        // Deepgram responses include channel.alternatives[0].transcript
        const alt = msg?.channel?.alternatives?.[0];
        const transcript = (alt?.transcript || "").trim();
        const isFinal = !!msg?.is_final;

        if (!transcript) return;

        if (!isFinal) {
          // optional: keep last partial
          pendingText = transcript;
          return;
        }

        pendingText = "";
        lastUserUtteranceAt = Date.now();

        // Barge-in: if caller speaks while we were playing, stop audio.
        if (speaking) {
          try { telnyxWs.send(JSON.stringify({ event: "clear" })); } catch {}
          speaking = false;
        }

        const userText = transcript;
        const sid = fromNumber || callControlId || "unknown";

        db.insertMessage({
          $session_id: sid,
          $channel: CHANNEL,
          $direction: "inbound",
          $from_id: fromNumber || sid,
          $from_name: fromNumber || "Caller",
          $content: userText,
        });

        conversation.push({ role: "user", content: userText });
        conversation = conversation.slice(-20);

        let raw = await getAIReply(conversation);
        const parsed = extractData(raw);
        const replyText = cleanReply(raw);

        db.insertMessage({
          $session_id: sid,
          $channel: CHANNEL,
          $direction: "outbound",
          $from_id: "wagenbaas",
          $from_name: "Wagenbaas AI",
          $content: replyText,
        });

        // Persist structured data (no lost leads)
        if (parsed?.callback) {
          const cb = parsed.callback;
          db.insertCallback({
            $name: cb.name || "",
            $phone: cb.phone || fromNumber || "",
            $reason: cb.reason || "voice_call",
            $channel: CHANNEL,
          });
        }
        if (parsed?.lead) {
          const lead = parsed.lead;
          const baseLead = {
            $name: lead.name || "",
            $phone: lead.phone || fromNumber || "",
            $email: lead.email || "",
            $source: CHANNEL,
            $notes: lead.notes || "",
          };
          const existing = db.findLeadByContact({ $phone: baseLead.$phone, $email: baseLead.$email });
          if (existing) db.updateLead({ ...baseLead, $id: existing.id });
          else db.insertLead(baseLead);
        }

        conversation.push({ role: "assistant", content: replyText });
        conversation = conversation.slice(-20);

        // Keep it snappy: speak only a concise reply.
        const spoken = replyText.length > 550 ? replyText.slice(0, 550) : replyText;
        await speakMp3(spoken);
      });
    }

    async function speakMp3(text) {
      // Telnyx MP3 bidirectional: payload can be submitted once/sec. We send one clip per turn.
      speaking = true;
      const mp3 = await elevenlabsTtsMp3(text);
      const payload = mp3.toString("base64");
      try {
        telnyxWs.send(JSON.stringify({ event: "media", media: { payload } }));
        lastMark = `tts_${Date.now()}`;
        telnyxWs.send(JSON.stringify({ event: "mark", mark: { name: lastMark } }));
      } catch (e) {
        speaking = false;
        logSys(`Telnyx send error: ${e.message}`);
      }
    }

    telnyxWs.on("message", async (raw) => {
      const msg = safeJsonParse(raw.toString("utf8"));
      if (!msg || !msg.event) return;

      if (msg.event === "connected") return;

      if (msg.event === "start") {
        streamId = msg.stream_id;
        callControlId = msg?.start?.call_control_id || null;
        fromNumber = msg?.start?.from || null;
        toNumber = msg?.start?.to || null;
        mediaFormat = msg?.start?.media_format || null;

        const sid = fromNumber || callControlId || "unknown";
        logSys(`Call started from ${fromNumber || "?"} to ${toNumber || "?"} (encoding=${mediaFormat?.encoding || "?"})`);
        conversation = [];

        // Open Deepgram now
        try { await ensureDeepgram(); } catch (e) { logSys(e.message); }
        return;
      }

      if (msg.event === "media") {
        // inbound audio from Telnyx
        const payload = msg?.media?.payload;
        if (!payload) return;
        if (!dgWs || dgWs.readyState !== WebSocket.OPEN) {
          try { await ensureDeepgram(); } catch { return; }
        }
        const audio = base64ToBuf(payload);
        try { dgWs.send(audio); } catch {}
        return;
      }

      if (msg.event === "mark") {
        if (msg?.mark?.name && lastMark && msg.mark.name === lastMark) speaking = false;
        return;
      }

      if (msg.event === "stop") {
        logSys("Call stopped");
        try { dgWs && dgWs.close(); } catch {}
        try { telnyxWs.close(); } catch {}
      }
    });

    telnyxWs.on("close", () => {
      try { dgWs && dgWs.close(); } catch {}
    });

    telnyxWs.on("error", (e) => {
      try { logSys(`Telnyx WS error: ${e.message}`); } catch {}
    });
  });

  console.log("📞 Voice channel registered (Telnyx WS + Deepgram + ElevenLabs)");
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { register };
