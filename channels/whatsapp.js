const axios = require("axios");
const { getAIReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");
const { verifyMetaSignature } = require("./metaSignature");

const CHANNEL = "whatsapp";

async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

function register(app) {
  // Verify webhook (Meta requirement)
  app.get("/api/whatsapp/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.send(req.query["hub.challenge"]);
    } else {
      res.sendStatus(403);
    }
  });

  app.post("/api/whatsapp/webhook", async (req, res) => {
    try {
      if (!verifyMetaSignature({
        appSecret: process.env.FACEBOOK_APP_SECRET,
        signatureHeader: req.headers["x-hub-signature-256"],
        rawBody: req.rawBody,
      })) return res.sendStatus(403);

      res.sendStatus(200);
      const entry   = req.body?.entry?.[0];
      const changes = entry?.changes?.[0]?.value;
      const msg     = changes?.messages?.[0];
      if (!msg || msg.type !== "text") return;

      const from = msg.from;
      const text = msg.text?.body || "";
      const contactName = changes?.contacts?.[0]?.profile?.name || from;
      if (!from || !text.trim()) return;

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "inbound", $from_id: from, $from_name: contactName, $content: text });
      db.insertStat({ $event: "message_received", $channel: CHANNEL, $meta: from });

      const history = db.sessionMessages(from).map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.content,
      }));

      const rawReply = await getAIReply(history, { channel: CHANNEL, knownPhone: from });
      const { appointment, callback, lead, declined } = extractData(rawReply);
      const reply = cleanReply(rawReply);

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: reply });

      if (appointment) db.insertAppointment({ ...apptParams(appointment), $channel: CHANNEL });
      if (callback)    db.insertCallback({ $name: callback.name||"", $phone: callback.phone||"", $reason: callback.reason||"", $channel: CHANNEL });
      if (lead) {
        const baseLead = {
          $name:  lead.name  || "",
          $phone: lead.phone || from,
          $email: lead.email || "",
          $source: CHANNEL,
          $notes: lead.notes || "",
        };
        const existingLead = db.findLeadByContact({ $phone: baseLead.$phone, $email: baseLead.$email });
        if (existingLead) {
          db.updateLead({ ...baseLead, $id: existingLead.id });
        } else {
          db.insertLead(baseLead);
        }
      }
      if (declined) db.insertDeclined({ $name: declined.name||"", $phone: declined.phone||from, $email: declined.email||"", $reason: declined.reason||"", $channel: CHANNEL });

      await sendWhatsApp(from, reply);
    } catch (err) {
      console.error("WhatsApp error:", err.message);
    }
  });

  console.log("📱 WhatsApp channel registered");
}

function apptParams(a) {
  return { $name: a.name||"", $phone: a.phone||"", $email: a.email||"", $car_brand: a.car_brand||"", $car_model: a.car_model||"", $car_year: a.car_year||"", $license: a.license||"", $service: a.service||"", $pref_date: a.pref_date||"", $pref_time: a.pref_time||"", $notes: a.notes||"" };
}

module.exports = { register };
