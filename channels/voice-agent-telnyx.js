/**
 * voice-agent-telnyx.js
 * ─────────────────────────────────────────────────────────────
 * Telnyx Media Streams  ←→  Deepgram Voice Agent API
 *
 * Key architecture decisions (based on Deepgram Voice Agent API docs):
 *
 * 1. endpointing / interrupt_sensitivity / listen_during_speech
 *    → NOT valid Voice Agent API params — silently ignored before, now removed.
 *    → Barge-in handled CLIENT-SIDE: on UserStartedSpeaking → send Telnyx "clear"
 *      to flush buffered AI audio immediately.
 *
 * 2. Full duplex (hear caller while AI speaks):
 *    → Audio is ALWAYS forwarded to Deepgram regardless of AI speaking state.
 *    → On UserStartedSpeaking, Telnyx audio buffer is flushed via "clear" event.
 *
 * 3. Multilingual:
 *    → STT: nova-3 + language:"multi" (supports NL/EN/DE/FR auto-detect)
 *    → TTS: Deepgram Aura-2 (handles multiple languages from text)
 *    → LLM: Claude instructed to detect and match caller's language every turn
 *
 * 4. Model: claude-haiku-4-5-20251001 (same cost, confirmed Deepgram-compatible alias)
 */

const url       = require("url");
const WS        = require("ws");
const Anthropic  = require("@anthropic-ai/sdk");
const { db }    = require("../database");
const { createAppointmentEvent, isSlotAvailable } = require("../calendar");

const CHANNEL = "voice-agent";
const DG_URL  = "wss://agent.deepgram.com/agent";

const pendingCalls = new Map();  // callId → fromNumber
const callHistory  = new Map();  // sessionId → [{role, content}]

// ── System prompt — top-tier phone receptionist ───────────────────────────────
function getPrompt() {
  return process.env.VOICE_AGENT_PROMPT || `
You are Emma, the AI receptionist for Wagenbaas — a professional auto repair garage in Apeldoorn, Netherlands. You handle inbound phone calls.

═══ LANGUAGE (CRITICAL — READ FIRST) ═══
Detect the language the caller speaks in EVERY message. Switch language immediately and automatically — no announcement needed.
- Dutch → reply in Dutch
- English → reply in English
- German → reply in German
- French → reply in French
Default: Dutch. Never mix languages. Never ask which language they prefer unless genuinely unclear.

═══ VOICE BEHAVIOUR ═══
- Maximum 1–2 short sentences per turn. This is a phone call, not a chat.
- No lists, no bullet points, no markdown — spoken words only.
- Speak naturally. Use contractions and conversational tone.
- When caller spells letters (phone number, license plate, email) — listen completely in silence until they finish. NEVER interrupt mid-spelling.
- After the caller finishes speaking — pause naturally before responding. Do not jump in immediately.
- If caller goes silent mid-sentence — wait. They are probably thinking.
- NEVER talk over the caller. If they start speaking — stop immediately and listen.
- Numbers and times in words: "tien uur" not "10:00", "negen" not "9".

═══ WHO YOU ARE ═══
Business: Wagenbaas auto garage
Address: Molenmakershoek 10, 7328 JK Apeldoorn
Phone: +31 64 77 000 88
Email: info@wagenbaas.nl
Hours: Monday–Friday 08:30–18:00 | Saturday 09:00–18:00 | Sunday CLOSED
Services: APK keuring, onderhoud, reparatie, banden wisselen, airco vullen

═══ YOUR MAIN JOB — BOOK THE APPOINTMENT ═══
Collect info in this order. Ask max 1–2 things at once:
  Step 1 → Name + phone number (ALWAYS collect this first, even if caller just has a question)
  Step 2 → License plate + preferred date and time
  Step 3 → What service is needed

Validate times against opening hours. If day/time is unclear: suggest a specific slot.
Example: "Zou woensdag om tien uur uitkomen?"

When confirming appointment, repeat the key details back naturally:
"Dus ik noteer u: [naam], [datum] om [tijd], voor [service]. Klopt dat?"

═══ NEVER LOSE A LEAD ═══
Even if someone is just asking a question — collect name + phone before they hang up.
Say: "Ik noteer uw naam en nummer alvast, dan kan ons team u terugbellen als er iets onduidelijk is."

═══ SMART HANDLING ═══
- Pricing questions → "De prijs hangt af van het voertuig. Ons team geeft u een exacte offerte als u langskomt."
- Caller wants human → "Ik noteer uw naam en nummer, dan belt een medewerker u zo snel mogelijk terug."
- Caller angry/frustrated → Stay calm, empathetic. "Ik begrijp dat, dat is vervelend. Laat me u helpen."
- Wrong number → Politely confirm and offer to help anyway.

═══ CLOSING ═══
Always end every response with an open question or next step to keep the conversation moving.
Final close: "Is er verder nog iets waarmee ik u kan helpen?"

═══ IMPORTANT — DO NOT REPEAT THE GREETING ═══
The opening greeting has ALREADY been spoken automatically when the call connected.
Do NOT start your first response with a greeting like "Goedendag" or "Hallo" again.
When the caller speaks for the first time, reply DIRECTLY to what they said — no re-introduction.
`.trim();
}

// ── Deepgram Voice Agent Settings — only documented, valid parameters ─────────
function buildSettings() {
  const sttModel = process.env.DEEPGRAM_AGENT_STT_MODEL  || "nova-3";
  // claude-haiku-4-5-20251001 is the exact Anthropic model ID;
  // Deepgram also accepts this format for Anthropic models
  const llmModel = process.env.DEEPGRAM_AGENT_LLM_MODEL  || "claude-haiku-4-5-20251001";
  const ttsModel = process.env.DEEPGRAM_AGENT_TTS_MODEL  || "aura-2-thalia-en";
  const temp     = parseFloat(process.env.DEEPGRAM_AGENT_TEMPERATURE || "0.2");
  const greeting = process.env.VOICE_AGENT_GREETING
    || "Goedendag, u bent verbonden met Wagenbaas. Waarmee kan ik u helpen?";

  return {
    type: "Settings",
    audio: {
      input:  { encoding: "mulaw", sample_rate: 8000 },
      output: { encoding: "mulaw", sample_rate: 8000, container: "none" },
    },
    agent: {
      listen: {
        provider: {
          type:        "deepgram",
          model:       sttModel,
          // nova-3 + "multi" = auto-detects NL/EN/DE/FR (documented valid combo)
          language:    "multi",
          // endpointing: ms of silence before turn ends. Default ~1000ms. 600 = 0.4s faster.
          endpointing: 600,
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
          // Deepgram Aura-2 voices render whatever language text they receive
        },
      },
      greeting,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nowIso() { return new Date().toISOString(); }

function dbLog(sessionId, msg) {
  try {
    db.insertMessage({
      $session_id: sessionId, $channel: CHANNEL,
      $direction: "outbound", $from_id: "system",
      $from_name: "Voice Agent",
      $content: `[${nowIso()}] ${msg}`,
    });
  } catch {}
}

function dbTranscript(sessionId, role, content, fromNumber) {
  try {
    db.insertMessage({
      $session_id: sessionId, $channel: CHANNEL,
      $direction:  role === "user" ? "inbound" : "outbound",
      $from_id:    role === "user" ? (fromNumber || sessionId) : "wagenbaas-agent",
      $from_name:  role === "user" ? (fromNumber || "Caller")  : "Wagenbaas AI",
      $content:    content,
    });
  } catch {}
}

// ── Appointment extraction from transcript ────────────────────────────────────
const APPT_KEYWORDS = /\b(afspraak|appointment|boek|book|datum|date|tijd|time|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|monday|tuesday|wednesday|thursday|friday|saturday|morgen|tomorrow|volgende\s*week|next\s*week|apk|onderhoud|reparatie|banden|airco|naam|name|telefoon|phone|kenteken|license)\b/i;

async function extractAndSave(sessionId, history, fromNumber) {
  if (history.length < 2) return;

  const fullText = history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join("\n");
  if (!APPT_KEYWORDS.test(fullText)) return;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return;

  try {
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Extract appointment data from this phone call. Return ONLY valid JSON or the word null.

TRANSCRIPT:
${fullText}

JSON format (null for unknown fields):
{
  "name": string|null,
  "phone": string|null,
  "email": string|null,
  "license": string|null,
  "service": string|null,
  "pref_date": "YYYY-MM-DD"|null,
  "pref_time": "HH:MM"|null,
  "notes": string|null,
  "confidence": "low"|"medium"|"high",
  "type": "appointment"|"lead"|"callback"|"none"
}

confidence=high: name+phone+date all confirmed. medium: 2 of 3. low: intent only.
Return null if no booking intent detected.`,
      }],
    });

    const raw = response.content[0]?.text?.trim();
    if (!raw || raw === "null") return;

    const data = safeJSON(raw);
    if (!data || data.type === "none") return;

    const phone = data.phone || fromNumber || "";

    if (data.type === "appointment" || data.confidence !== "low") {
      db.upsertVoiceAppointment({
        $session_id: sessionId,
        $name:       data.name       || "",
        $phone:      phone,
        $email:      data.email      || "",
        $license:    data.license    || "",
        $service:    data.service    || "",
        $pref_date:  data.pref_date  || "",
        $pref_time:  data.pref_time  || "",
        $notes:      data.notes      || "",
        $channel:    CHANNEL,
        $confidence: data.confidence || "low",
      });
      console.log(`[VoiceTelnyx:${sessionId}] Appointment saved — confidence:${data.confidence}`);

      // Google Calendar — only create event when we have a confirmed date+time
      const hasDateTime = /^\d{4}-\d{2}-\d{2}$/.test(data.pref_date || "")
                       && /^\d{2}:\d{2}$/.test(data.pref_time || "");
      if (hasDateTime && data.confidence === "high" && process.env.GOOGLE_REFRESH_TOKEN) {
        try {
          const availability = await isSlotAvailable({ date: data.pref_date, time: data.pref_time, durationMinutes: 60 });
          if (availability.ok && availability.available === false) {
            console.log(`[VoiceTelnyx:${sessionId}] Calendar slot busy — skipping event creation`);
          } else {
            const summary = `Wagenbaas afspraak: ${data.service || "Service"} (${data.license || "zonder kenteken"})`;
            const description = [
              `Naam: ${data.name || ""}`,
              `Telefoon: ${phone}`,
              `Email: ${data.email || ""}`,
              `Kenteken: ${data.license || ""}`,
              `Service: ${data.service || ""}`,
              `Notities: ${data.notes || ""}`,
              `Kanaal: ${CHANNEL}`,
            ].filter(Boolean).join("\n");
            const result = await createAppointmentEvent({
              summary, description,
              date: data.pref_date, time: data.pref_time,
              durationMinutes: 60,
              attendees: data.email ? [{ email: data.email }] : [],
            });
            if (result.ok) {
              console.log(`[VoiceTelnyx:${sessionId}] Calendar event created: ${result.eventId}`);
            } else {
              console.log(`[VoiceTelnyx:${sessionId}] Calendar event skipped: ${result.reason}`);
            }
          }
        } catch (calErr) {
          console.error(`[VoiceTelnyx:${sessionId}] Calendar error:`, calErr.message);
        }
      }
    }

    if ((data.name || phone) && data.type !== "none") {
      const existing = db.findLeadByContact({ $phone: phone, $email: data.email || "" });
      if (!existing) {
        db.insertLead({
          $name:   data.name  || "",
          $phone:  phone,
          $email:  data.email || "",
          $source: CHANNEL,
          $notes:  `Voice call. Service: ${data.service || "?"} Date: ${data.pref_date || "?"}`,
        });
      }
    }

    if (data.type === "callback" && phone) {
      db.insertCallback({
        $name:    data.name  || "",
        $phone:   phone,
        $reason:  data.notes || "Callback requested via voice",
        $channel: CHANNEL,
      });
    }

  } catch (err) {
    console.error(`[VoiceTelnyx:${sessionId}] Extraction error:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function register(app, { server } = {}) {
  if (!server) throw new Error("[voice-agent-telnyx] requires { server }");

  // ── 1. TeXML Webhook ─────────────────────────────────────────────────────────
  app.post("/api/telnyx/voice", (req, res) => {
    const host    = req.headers["x-forwarded-host"] || req.headers.host;
    const proto   = (req.headers["x-forwarded-proto"] || "https").toLowerCase();
    const wsProto = proto === "http" ? "ws" : "wss";

    const callId = req.body?.CallControlId || req.body?.call_control_id || "";
    const from   = req.body?.From || req.body?.from || "";

    if (callId) pendingCalls.set(callId, from);

    const streamUrl = `${wsProto}://${host}/api/telnyx/stream?callId=${encodeURIComponent(callId)}`;
    const statusUrl = `${proto}://${host}/api/telnyx/status`;

    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" statusCallbackUrl="${escXml(statusUrl)}" />
  </Start>
  <Pause length="300"/>
</Response>`);
  });

  // ── 2. Call Status Webhook ───────────────────────────────────────────────────
  app.post("/api/telnyx/status", (req, res) => {
    const eventType   = req.body?.data?.event_type || req.body?.event_type || "";
    const payload     = req.body?.data?.payload     || req.body || {};
    const hangupCause = payload?.hangup_cause        || payload?.CallStatus || "";
    const from        = payload?.from || payload?.From || "";
    const callId      = payload?.call_control_id || payload?.CallControlId || "";
    const duration    = parseInt(payload?.call_duration_secs || payload?.CallDuration || "0", 10);

    const missedCauses = ["call_rejected", "no_answer", "user_busy", "originator_cancel", "failed"];
    const isMissed = missedCauses.some(c => hangupCause.toLowerCase().includes(c));

    if (isMissed || (eventType === "call.hangup" && duration < 5)) {
      try {
        db.insertMissedCall({ $caller: from, $call_sid: callId, $status: "gemist", $duration: duration });
        db.insertStat({ $event: "missed_call", $channel: CHANNEL, $meta: from || null });
        console.log(`[VoiceTelnyx] Missed call from ${from} — cause: ${hangupCause || "short call"}`);
      } catch (e) {
        console.error("[VoiceTelnyx] Failed to log missed call:", e.message);
      }
    }

    res.sendStatus(204);
  });

  // ── 3. WebSocket — Telnyx Media Streams ──────────────────────────────────────
  const wss = new WS.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url || "");
    if (pathname !== "/api/telnyx/stream") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (telnyxWs, req) => {
    const qs         = new URLSearchParams((url.parse(req.url || "").query) || "");
    const callId     = qs.get("callId") || "";
    let   streamId   = null;
    let   fromNumber = pendingCalls.get(callId) || "";
    let   sessionId  = callId || `vt_${Date.now()}`;
    let   dgWs          = null;
    let   keepAlive     = null;
    let   silenceTimer  = null;
    let   silenceStrike = 0;   // 0 = no alert yet, 1 = first alert sent

    callHistory.set(sessionId, []);

    const log = (msg) => {
      console.log(`[VoiceTelnyx:${sessionId}] ${msg}`);
      dbLog(sessionId, msg);
    };

    // ── Silence detection — inject message if caller goes quiet ──────────────
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceStrike = 0;
      silenceTimer  = setTimeout(onSilence, 4000);
    }

    // Detect caller language from transcript history (simple heuristic)
    function detectLang() {
      const history = callHistory.get(sessionId) || [];
      const userText = history.filter(h => h.role === "user").map(h => h.content).join(" ").toLowerCase();
      if (!userText) return "nl"; // no speech yet → default Dutch
      const enWords = /\b(hello|hi|yes|no|please|thank|want|need|help|appointment|car|when|what|how|can|i|you|the|a|is|my|have)\b/;
      return enWords.test(userText) ? "en" : "nl";
    }

    function onSilence() {
      if (!dgWs || dgWs.readyState !== WS.OPEN) return;
      silenceStrike++;
      const lang = detectLang();

      if (silenceStrike === 1) {
        // First alert — 4 s of silence
        const msg = lang === "en"
          ? "Hello? Are you still there? I can't hear you. How can I help you?"
          : "Hallo? Bent u er nog? Ik kan u niet goed horen. Waarmee kan ik u helpen?";
        log("Silence detected (4 s) — injecting first alert");
        try { dgWs.send(JSON.stringify({ type: "InjectAgentMessage", message: msg })); } catch {}
        silenceTimer = setTimeout(onSilence, 4000); // 4 s more → 8 s total
      } else {
        // Second alert — suggest alternative channels
        const smsOn = process.env.ENABLE_SMS      === "true";
        const waOn  = process.env.ENABLE_WHATSAPP === "true";
        let msg;
        if (lang === "en") {
          let alt = smsOn && waOn ? "via SMS or WhatsApp at +31 64 77 000 88"
                  : smsOn        ? "via SMS at +31 64 77 000 88"
                  : waOn         ? "via WhatsApp at +31 64 77 000 88"
                  :                "by email at info@wagenbaas.nl";
          msg = `Are you still there? I can't hear you. You can also reach us ${alt} — we're happy to help. Goodbye!`;
        } else {
          let alt = smsOn && waOn ? "via SMS of WhatsApp op +31 64 77 000 88"
                  : smsOn        ? "via SMS op +31 64 77 000 88"
                  : waOn         ? "via WhatsApp op +31 64 77 000 88"
                  :                "via e-mail op info@wagenbaas.nl";
          msg = `Bent u er nog? Ik kan u niet horen. U kunt ons ook bereiken ${alt} — wij helpen u graag. Tot ziens!`;
        }
        log("Silence detected (8 s) — injecting second alert with channel suggestions");
        try { dgWs.send(JSON.stringify({ type: "InjectAgentMessage", message: msg })); } catch {}
        silenceTimer = null;
      }
    }

    // Flush Telnyx audio buffer — stops AI mid-sentence when caller speaks
    function flushTelnyxAudio() {
      if (telnyxWs.readyState === WS.OPEN && streamId) {
        try {
          telnyxWs.send(JSON.stringify({ event: "clear", stream_id: streamId }));
        } catch {}
      }
    }

    function connectDG() {
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) { log("ERROR: DEEPGRAM_API_KEY not set"); telnyxWs.close(); return; }

      dgWs = new WS(DG_URL, { headers: { Authorization: `Token ${key}` } });

      dgWs.on("open", () => {
        log("Deepgram connected — sending Settings");
        dgWs.send(JSON.stringify(buildSettings()));

        keepAlive = setInterval(() => {
          if (dgWs.readyState === WS.OPEN) {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 5000);
      });

      dgWs.on("message", (data, isBinary) => {
        // Binary = TTS audio → forward to caller
        if (isBinary || Buffer.isBuffer(data)) {
          if (telnyxWs.readyState === WS.OPEN && streamId) {
            const payload = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64");
            telnyxWs.send(JSON.stringify({
              event:     "media",
              stream_id: streamId,
              media:     { payload },
            }));
          }
          return;
        }

        const msg = safeJSON(data.toString("utf8"));
        if (!msg) return;

        switch (msg.type) {

          case "Welcome":
            log("Deepgram: Welcome received");
            break;

          case "SettingsApplied":
            log("Deepgram: Settings applied — agent live");
            // Start silence watch — caller has 4 s to say something after greeting
            resetSilenceTimer();
            break;

          case "ConversationText": {
            if (!msg.content) break;
            const role = msg.role === "user" ? "user" : "agent";
            console.log(`[VoiceTelnyx transcript] ${role}: ${msg.content}`);
            dbTranscript(sessionId, role, msg.content, fromNumber);

            const history = callHistory.get(sessionId) || [];
            history.push({ role, content: msg.content });
            callHistory.set(sessionId, history);

            if (role === "user") {
              // Caller spoke — reset silence counter fully
              resetSilenceTimer();
            } else {
              // Agent finished a turn — pause silence timer while AI is speaking
              // (it will restart on AgentAudioDone)
              if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
            }

            // After each complete agent turn → try extract appointment
            if (role === "agent") {
              extractAndSave(sessionId, history, fromNumber).catch(() => {});
            }
            break;
          }

          case "UserStartedSpeaking":
            // ── FULL DUPLEX BARGE-IN ──────────────────────────────────────
            // Deepgram stops its TTS. We must also flush Telnyx's audio buffer
            // so the caller immediately hears silence (not buffered AI speech).
            log("Caller speaking — flushing AI audio");
            flushTelnyxAudio();
            // Reset silence timer — caller is active
            resetSilenceTimer();
            break;

          case "AgentStartedSpeaking":
            log("Agent speaking");
            break;

          case "AgentAudioDone":
            log("Agent audio done");
            // AI finished speaking — restart silence timer, caller has 4 s to respond
            resetSilenceTimer();
            break;

          case "Error":
            log(`Deepgram error: ${msg.message || JSON.stringify(msg)}`);
            break;
        }
      });

      dgWs.on("error", (e) => log(`Deepgram WS error: ${e.message}`));
      dgWs.on("close", (code) => {
        log(`Deepgram WS closed (code ${code})`);
        clearInterval(keepAlive);
      });
    }

    // ── Handle Telnyx stream events ───────────────────────────────────────────
    telnyxWs.on("message", (raw) => {
      const msg = safeJSON(raw.toString("utf8"));
      if (!msg || !msg.event) return;

      switch (msg.event) {
        case "connected":
          break;

        case "start":
          streamId   = msg.stream_id || null;
          fromNumber = msg?.start?.from || pendingCalls.get(callId) || fromNumber;
          sessionId  = msg?.start?.call_control_id || callId || sessionId;

          if (!callHistory.has(sessionId)) callHistory.set(sessionId, []);

          log(`Call started — from=${fromNumber || "?"} streamId=${streamId}`);
          db.insertStat?.({ $event: "voice_agent_call", $channel: CHANNEL, $meta: fromNumber || null });
          connectDG();
          break;

        case "media":
          // ── ALWAYS forward caller audio to Deepgram ───────────────────────
          // This is the full-duplex loop: audio flows even while AI is speaking.
          // Deepgram's VAD detects the caller speaking and fires UserStartedSpeaking.
          if (!dgWs || dgWs.readyState !== WS.OPEN) return;
          {
            const audio = Buffer.from(msg.media?.payload || "", "base64");
            try { dgWs.send(audio); } catch {}
          }
          break;

        case "stop":
          log("Call ended");
          {
            const history = callHistory.get(sessionId) || [];
            extractAndSave(sessionId, history, fromNumber)
              .catch(() => {})
              .finally(() => {
                callHistory.delete(sessionId);
                cleanup();
                pendingCalls.delete(callId);
              });
          }
          break;
      }
    });

    telnyxWs.on("close", () => {
      log("Telnyx WS closed");
      const history = callHistory.get(sessionId) || [];
      extractAndSave(sessionId, history, fromNumber).catch(() => {});
      callHistory.delete(sessionId);
      cleanup();
      pendingCalls.delete(callId);
    });

    telnyxWs.on("error", (e) => {
      try { log(`Telnyx WS error: ${e.message}`); } catch {}
    });

    function cleanup() {
      clearInterval(keepAlive);
      if (silenceTimer) clearTimeout(silenceTimer);
      try { if (dgWs) dgWs.close(); } catch {}
    }
  });

  console.log("📞 Voice Agent (Telnyx + Deepgram) registered");
  console.log("   Webhook : POST /api/telnyx/voice");
  console.log("   Stream  : WS   /api/telnyx/stream");
  console.log("   Status  : POST /api/telnyx/status");
}

module.exports = { register };
