const axios = require("axios");
const { getAIReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");

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
      res.sendStatus(200);
      const entry   = req.body?.entry?.[0];
      const changes = entry?.changes?.[0]?.value;
      const msg     = changes?.messages?.[0];
      if (!msg || msg.type !== "text") return;

      const from = msg.from;
      const text = msg.text?.body || "";
      const contactName = changes?.contacts?.[0]?.profile?.name || from;

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "inbound", $from_id: from, $from_name: contactName, $content: text });
      db.insertStat({ $event: "message_received", $channel: CHANNEL, $meta: from });

      const history = db.sessionMessages(from).map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.content,
      }));

      const rawReply = await getAIReply(history);
      const { appointment, callback, lead } = extractData(rawReply);
      const reply = cleanReply(rawReply);

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: reply });

      if (appointment) db.insertAppointment({ ...apptParams(appointment), $channel: CHANNEL });
      if (callback)    db.insertCallback({ $name: callback.name||"", $phone: callback.phone||"", $reason: callback.reason||"", $channel: CHANNEL });
      if (lead)        db.insertLead({ $name: lead.name||"", $phone: lead.phone||"", $email: lead.email||"", $source: CHANNEL, $notes: lead.notes||"" });

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
