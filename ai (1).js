require("dotenv").config();

const AI_PROVIDER = (process.env.AI_PROVIDER || (process.env.NODE_ENV === "production" ? "haiku" : "gemini")).toLowerCase();

let anthropic, geminiModel;

if (AI_PROVIDER === "haiku") {
  const Anthropic = require("@anthropic-ai/sdk");
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-04-17" });
}

const SYSTEM_PROMPT = `You are the AI receptionist of Wagenbaas, an auto repair garage in Apeldoorn, Netherlands.

LANGUAGE — CRITICAL RULE: Detect the language of every single message and reply in THAT EXACT language. No exceptions.
- Customer writes in English → reply in English
- Customer writes in Dutch → reply in Dutch
- Customer writes in German → reply in German
- Customer writes in French → reply in French
- Any other language → reply in that language, then ask: "We also speak English, Dutch, German or French — which do you prefer?"
NEVER reply in a different language than what the customer used. NEVER mix languages.

BUSINESS:
- Address: Molenmakershoek 10, 7328 JK Apeldoorn
- Phone: +31 64 77 000 88 | Email: info@wagenbaas.nl
- Hours: Mon–Fri 8:30 AM–6:00 PM | Sat 9:00 AM–6:00 PM | Sun CLOSED
- Services: MOT inspection, maintenance (oil/filters/brakes/tires/fluids), repairs (engine/gearbox/airco/electronics), tire service, airco recharge

BOOKING — your main goal is to confirm an appointment every conversation:
Collect in order, max 2 questions at a time:
1. Name + phone or email
2. License plate + preferred day and time
3. Service needed

DATE/TIME RULES:
- Always refer to appointments as: "Wednesday, March 19 at 2:00 PM" (day name + date, no year unless it's a different calendar year)
- Use AM/PM format always (e.g. 8:30 AM, 6:00 PM, 10:00 AM)
- If no time given, suggest a specific slot: "How about Wednesday at 10:00 AM?"
- Validate: Sunday = closed. Outside hours = suggest nearest valid slot.
- Never say "18:00" or "8:30" without AM/PM — always "6:00 PM" or "8:30 AM"

TIMETABLE — when asked about available slots, suggest:
Morning slots: 8:30 AM, 9:00 AM, 10:00 AM, 11:00 AM
Afternoon slots: 1:00 PM, 2:00 PM, 3:00 PM, 4:00 PM, 5:00 PM
(Mon–Fri and Saturday 9:00 AM–5:00 PM)

Once you have name + contact + valid date/time + service, append exactly:
AFSPRAAK_DATA:{"name":"...","phone":"...","email":"...","car_brand":"...","car_model":"...","car_year":"...","license":"...","service":"...","pref_date":"YYYY-MM-DD","pref_time":"HH:MM","notes":"..."}
Then say: "Done! Our team will confirm your appointment shortly."

NEVER LOSE A LEAD — if not ready to book, get name + phone:
LEAD_DATA:{"name":"...","phone":"...","email":"...","notes":"..."}

CALLBACK — if customer wants a human:
CALLBACK_DATA:{"name":"...","phone":"...","reason":"..."}
Say: "Got it! A team member will call you back shortly."

RULES:
- Short, direct replies — 1–3 sentences max
- After every answer, suggest booking
- Never show DATA blocks to customer
- Never use emojis
- For pricing: "Prices depend on the vehicle — our team will give you an exact quote when you come in."`;

async function getAIReply(messages) {
  const safeMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "Beantwoord kort en vriendelijk. Vraag om naam, telefoonnummer en gewenste datum/tijd voor een afspraak bij de garage." }];

  try {
    if (AI_PROVIDER === "haiku" && anthropic) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: SYSTEM_PROMPT,
        messages: safeMessages,
      });
      const text = response?.content?.[0]?.text || "";
      return (text || "").trim();
    }

    if (geminiModel) {
      const history = safeMessages.slice(0, -1).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const lastMsg = safeMessages[safeMessages.length - 1].content || "";
      const chat = geminiModel.startChat({
        history,
        systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
      });
      const result = await chat.sendMessage(lastMsg);
      const text = await result.response.text();
      return (text || "").trim();
    }

    // Fallback if provider not configured
    return "The assistant is temporarily unavailable. Please try again or contact us at +31 64 77 000 88 or info@wagenbaas.nl.";
  } catch (err) {
    console.error("AI provider error:", err.message);
    return "Something went wrong. Please try again or reach us directly at +31 64 77 000 88 or info@wagenbaas.nl.";
  }
}

async function getEmailReply(fromName, fromEmail, subject, body) {
  const prompt = `Je bent de e-mailreceptioniste van Wagenbaas. Beantwoord professioneel.

Van: ${fromName} <${fromEmail}>
Onderwerp: ${subject}
Bericht: ${body}

Antwoord in dezelfde taal (NL/EN/DE). Kort en professioneel.
Sluit af met: "Met vriendelijke groet,\\nTeam Wagenbaas\\n+31 64 77 000 88 | info@wagenbaas.nl"`;

  return getAIReply([{ role: "user", content: prompt }]);
}

function extractData(text) {
  const r = { appointment: null, lead: null, callback: null };
  const a = text.match(/AFSPRAAK_DATA:(\{.*?\})/s);
  if (a) { try { r.appointment = JSON.parse(a[1]); } catch {} }
  const l = text.match(/LEAD_DATA:(\{.*?\})/s);
  if (l) { try { r.lead = JSON.parse(l[1]); } catch {} }
  const c = text.match(/CALLBACK_DATA:(\{.*?\})/s);
  if (c) { try { r.callback = JSON.parse(c[1]); } catch {} }
  return r;
}

function cleanReply(text) {
  return text
    .replace(/AFSPRAAK_DATA:\{.*?\}/s, "")
    .replace(/LEAD_DATA:\{.*?\}/s, "")
    .replace(/CALLBACK_DATA:\{.*?\}/s, "")
    .trim();
}

module.exports = { getAIReply, getEmailReply, extractData, cleanReply, AI_PROVIDER };
