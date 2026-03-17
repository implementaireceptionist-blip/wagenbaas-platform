const axios = require("axios");
const { getAIReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");

const CHANNEL = "sms";

async function sendSMS(to, text) {
  await axios.post("https://api.telnyx.com/v2/messages", {
    from: process.env.TELNYX_PHONE_NUMBER,
    to,
    text,
  }, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }
  });
}

function register(app) {
  // Telnyx webhook → set in Telnyx dashboard: Messaging → Webhooks → your URL/api/sms/inbound
  app.post("/api/sms/inbound", async (req, res) => {
    try {
      const event = req.body?.data;
      if (event?.event_type !== "message.received") return res.sendStatus(200);

      const payload = event.payload;
      const from    = payload.from?.phone_number || "";
      const text    = payload.text || "";
      if (!from || !text) return res.sendStatus(200);

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "inbound", $from_id: from, $from_name: from, $content: text });
      db.insertStat({ $event: "message_received", $channel: CHANNEL, $meta: from });

      // Get conversation history
      const history = db.sessionMessages(from).map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.content,
      }));

      const rawReply = await getAIReply(history, { channel: CHANNEL, knownPhone: from });
      const { appointment, callback, lead, declined } = extractData(rawReply);
      const reply = cleanReply(rawReply);

      db.insertMessage({ $session_id: from, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: reply });

      if (appointment) db.insertAppointment({ ...appointmentParams(appointment), $channel: CHANNEL });
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

      await sendSMS(from, reply);
      res.sendStatus(200);
    } catch (err) {
      console.error("SMS error:", err.message);
      res.sendStatus(200);
    }
  });

  console.log("📱 SMS channel registered");
}

function appointmentParams(a) {
  return { $name: a.name||"", $phone: a.phone||"", $email: a.email||"", $car_brand: a.car_brand||"", $car_model: a.car_model||"", $car_year: a.car_year||"", $license: a.license||"", $service: a.service||"", $pref_date: a.pref_date||"", $pref_time: a.pref_time||"", $notes: a.notes||"" };
}

module.exports = { register };
