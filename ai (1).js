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

const BASE_PROMPT = `You are the AI receptionist of Wagenbaas, an auto repair garage in Apeldoorn, Netherlands.

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
- Always refer to appointments as: "Wednesday, March 19 at 2:00 PM"
- Use AM/PM format always (e.g. 8:30 AM, 6:00 PM)
- If no time given, suggest a specific slot: "How about Wednesday at 10:00 AM?"
- Validate: Sunday = closed. Outside hours = suggest nearest valid slot.

TIMETABLE — when asked about available slots, suggest:
Morning slots: 8:30 AM, 9:00 AM, 10:00 AM, 11:00 AM
Afternoon slots: 1:00 PM, 2:00 PM, 3:00 PM, 4:00 PM, 5:00 PM
(Mon–Fri and Saturday 9:00 AM–5:00 PM)

Once you have name + contact + valid date/time + service, append exactly:
AFSPRAAK_DATA:{"name":"...","phone":"...","email":"...","car_brand":"...","car_model":"...","car_year":"...","license":"...","service":"...","pref_date":"YYYY-MM-DD","pref_time":"HH:MM","notes":"..."}
Then say: "Done! Our team will confirm your appointment shortly."

CALLBACK ESCALATION — CRITICAL:
- If customer seems undecided, says "maybe later", "I'll think about it", "not sure", or hasn't committed after 3+ exchanges about booking → offer a callback:
  "Would you like us to call you back at a convenient time to discuss this further?"
- If customer wants a human or prefers a phone call → offer callback immediately
- If customer goes quiet or gives vague responses repeatedly → save as callback
- If customer explicitly does NOT want appointment AND does NOT want callback → save as DECLINED_DATA
CALLBACK_DATA:{"name":"...","phone":"...","reason":"..."}
Say: "Got it! A team member will call you back shortly."

DECLINED — if customer explicitly refuses both appointment AND callback:
DECLINED_DATA:{"name":"...","phone":"...","email":"...","reason":"..."}
(Still be polite: "No problem! Feel free to contact us anytime at +31 64 77 000 88.")

NEVER LOSE A LEAD — if not ready to book but has shared contact info:
LEAD_DATA:{"name":"...","phone":"...","email":"...","notes":"..."}

RULES:
- Short, direct replies — 1–3 sentences max
- After every answer, suggest booking or next step
- Never show DATA blocks to customer
- Never use emojis
- For pricing: "Prices depend on the vehicle — our team will give you an exact quote when you come in."`;

// Channel-specific additions appended to BASE_PROMPT
const CHANNEL_ADDITIONS = {
  sms:       "\n\nCHANNEL: SMS — The customer's phone number is already known from the SMS sender. NEVER ask for phone number. Do not ask for email unless the customer volunteers it.",
  whatsapp:  "\n\nCHANNEL: WhatsApp — The customer's phone number is already known. NEVER ask for phone number. Do not ask for email unless the customer volunteers it.",
  voice:     "\n\nCHANNEL: Phone call — The caller's phone number is already known from caller ID. NEVER ask for phone number or email.",
  "voice-agent": "\n\nCHANNEL: Phone call — The caller's phone number is already known from caller ID. NEVER ask for phone number or email.",
  facebook:  "\n\nCHANNEL: Facebook Messenger — Ask for phone number OR email (not both). One contact method is enough.",
  instagram: "\n\nCHANNEL: Instagram DM — Ask for phone number OR email (not both). One contact method is enough.",
  webchat:   "\n\nCHANNEL: Website chat — Ask for phone number OR email (not both). One contact method is enough.",
  email:     "\n\nCHANNEL: Email — The customer's email address is already known. NEVER ask for email. Do not ask for phone unless absolutely needed.",
};

function buildSystemPrompt(channel = "webchat", knownPhone = "", knownEmail = "") {
  let prompt = BASE_PROMPT + (CHANNEL_ADDITIONS[channel] || CHANNEL_ADDITIONS.webchat);
  if (knownPhone) prompt += `\n\nKNOWN CONTACT: Customer's phone number is ${knownPhone}. Use it directly in DATA blocks — do not ask for it again.`;
  if (knownEmail) prompt += `\n\nKNOWN CONTACT: Customer's email is ${knownEmail}. Use it directly in DATA blocks — do not ask for it again.`;
  return prompt;
}

const EMAIL_PROMPT = `You are the email receptionist of Wagenbaas auto garage in Apeldoorn, Netherlands.

Reply to inbound emails professionally and efficiently. Format your reply AS A PROPER EMAIL — with greeting, body, and sign-off.

LANGUAGE: Reply in the same language as the incoming email.

GOAL: Read the email, identify the issue or question quickly, and guide the customer toward booking an appointment. Be concise and helpful.

DO NOT ask for email address (you already have it). Do not ask for phone unless needed for urgent follow-up.

If the customer's email contains enough info to book an appointment (name + service + preferred date/time), include at the end:
AFSPRAAK_DATA:{"name":"...","phone":"...","email":"...","car_brand":"...","car_model":"...","car_year":"...","license":"...","service":"...","pref_date":"YYYY-MM-DD","pref_time":"HH:MM","notes":"..."}

If the customer wants info or is undecided, include:
LEAD_DATA:{"name":"...","phone":"...","email":"...","notes":"..."}

If the customer wants a callback:
CALLBACK_DATA:{"name":"...","phone":"...","reason":"..."}

BUSINESS INFO:
- Address: Molenmakershoek 10, 7328 JK Apeldoorn
- Phone: +31 64 77 000 88
- Hours: Mon–Fri 8:30 AM–6:00 PM | Sat 9:00 AM–6:00 PM | Sun CLOSED
- Services: MOT, maintenance, repairs, tires, airco

SIGN-OFF (always end with):
Met vriendelijke groet / Kind regards / Mit freundlichen Grüßen,
Team Wagenbaas
+31 64 77 000 88 | info@wagenbaas.nl`;

async function getAIReply(messages, options = {}) {
  const { channel = "webchat", knownPhone = "", knownEmail = "" } = options;
  const systemPrompt = buildSystemPrompt(channel, knownPhone, knownEmail);

  const safeMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "Beantwoord kort en vriendelijk. Vraag om naam, telefoonnummer en gewenste datum/tijd voor een afspraak bij de garage." }];

  try {
    if (AI_PROVIDER === "haiku" && anthropic) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: systemPrompt,
        messages: safeMessages,
      });
      return (response?.content?.[0]?.text || "").trim();
    }

    if (geminiModel) {
      const history = safeMessages.slice(0, -1).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const lastMsg = safeMessages[safeMessages.length - 1].content || "";
      const chat = geminiModel.startChat({
        history,
        systemInstruction: { role: "user", parts: [{ text: systemPrompt }] },
      });
      const result = await chat.sendMessage(lastMsg);
      return ((await result.response.text()) || "").trim();
    }

    return "The assistant is temporarily unavailable. Please try again or contact us at +31 64 77 000 88 or info@wagenbaas.nl.";
  } catch (err) {
    console.error("AI provider error:", err.message);
    return "Something went wrong. Please try again or reach us directly at +31 64 77 000 88 or info@wagenbaas.nl.";
  }
}

async function getEmailReply(fromName, fromEmail, subject, body) {
  const prompt = `From: ${fromName} <${fromEmail}>
Subject: ${subject}
Message:
${body}`;

  try {
    if (AI_PROVIDER === "haiku" && anthropic) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: EMAIL_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      return (response?.content?.[0]?.text || "").trim();
    }

    if (geminiModel) {
      const chat = geminiModel.startChat({
        systemInstruction: { role: "user", parts: [{ text: EMAIL_PROMPT }] },
      });
      const result = await chat.sendMessage(prompt);
      return ((await result.response.text()) || "").trim();
    }

    return `Dear ${fromName},\n\nThank you for your email. We will get back to you shortly.\n\nKind regards,\nTeam Wagenbaas\n+31 64 77 000 88 | info@wagenbaas.nl`;
  } catch (err) {
    console.error("Email AI error:", err.message);
    return `Dear ${fromName},\n\nThank you for your message. Please call us at +31 64 77 000 88.\n\nKind regards,\nTeam Wagenbaas`;
  }
}

function extractData(text) {
  const r = { appointment: null, lead: null, callback: null, declined: null };
  const a = text.match(/AFSPRAAK_DATA:(\{.*?\})/s);
  if (a) { try { r.appointment = JSON.parse(a[1]); } catch {} }
  const l = text.match(/LEAD_DATA:(\{.*?\})/s);
  if (l) { try { r.lead = JSON.parse(l[1]); } catch {} }
  const c = text.match(/CALLBACK_DATA:(\{.*?\})/s);
  if (c) { try { r.callback = JSON.parse(c[1]); } catch {} }
  const d = text.match(/DECLINED_DATA:(\{.*?\})/s);
  if (d) { try { r.declined = JSON.parse(d[1]); } catch {} }
  return r;
}

function cleanReply(text) {
  return text
    .replace(/AFSPRAAK_DATA:\{.*?\}/s, "")
    .replace(/LEAD_DATA:\{.*?\}/s, "")
    .replace(/CALLBACK_DATA:\{.*?\}/s, "")
    .replace(/DECLINED_DATA:\{.*?\}/s, "")
    .trim();
}

module.exports = { getAIReply, getEmailReply, extractData, cleanReply, AI_PROVIDER };
