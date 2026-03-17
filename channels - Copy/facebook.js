const axios = require("axios");
const { getAIReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");
const CHANNEL = "facebook";

async function sendFB(recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_TOKEN}`,
    { recipient: { id: recipientId }, message: { text } }
  );
}

function register(app) {
  app.get("/api/facebook/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === process.env.FACEBOOK_VERIFY_TOKEN) {
      res.send(req.query["hub.challenge"]);
    } else res.sendStatus(403);
  });

  app.post("/api/facebook/webhook", async (req, res) => {
    try {
      res.sendStatus(200);
      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];
      if (!messaging?.message?.text) return;
      const senderId = messaging.sender.id;
      const text = messaging.message.text;

      db.insertMessage({ $session_id: senderId, $channel: CHANNEL, $direction: "inbound", $from_id: senderId, $from_name: senderId, $content: text });
      db.insertStat({ $event: "message_received", $channel: CHANNEL, $meta: senderId });

      const history = db.sessionMessages(senderId).map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.content,
      }));

      const rawReply = await getAIReply(history);
      const { appointment, callback, lead } = extractData(rawReply);
      const reply = cleanReply(rawReply);

      db.insertMessage({ $session_id: senderId, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: reply });

      if (appointment) db.insertAppointment({ $name: appointment.name||"", $phone: appointment.phone||"", $email: appointment.email||"", $car_brand: appointment.car_brand||"", $car_model: appointment.car_model||"", $car_year: appointment.car_year||"", $license: appointment.license||"", $service: appointment.service||"", $pref_date: appointment.pref_date||"", $pref_time: appointment.pref_time||"", $notes: appointment.notes||"", $channel: CHANNEL });
      if (callback) db.insertCallback({ $name: callback.name||"", $phone: callback.phone||"", $reason: callback.reason||"", $channel: CHANNEL });
      if (lead) db.insertLead({ $name: lead.name||"", $phone: lead.phone||"", $email: lead.email||"", $source: CHANNEL, $notes: lead.notes||"" });

      await sendFB(senderId, reply);
    } catch (err) { console.error("Facebook error:", err.message); }
  });
  console.log("📘 Facebook Messenger channel registered");
}

module.exports = { register };
