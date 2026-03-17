const multer = require("multer");
const nodemailer = require("nodemailer");
const { getEmailReply, extractData, cleanReply } = require("../ai");
const { db } = require("../database");
const { createAppointmentEvent } = require("../calendar");

const CHANNEL = "email";
const upload = multer();

const transporter = nodemailer.createTransport({
  host: process.env.MAILGUN_SMTP_HOST || "smtp.mailgun.org",
  port: parseInt(process.env.MAILGUN_SMTP_PORT) || 587,
  auth: {
    user: process.env.MAILGUN_SMTP_USER || "",
    pass: process.env.MAILGUN_SMTP_PASS || "",
  },
});

const EMAIL_FROM  = process.env.EMAIL_FROM || "Wagenbaas <noreply@wagenbaas.nl>";
const EMAIL_OWNER = process.env.EMAIL_OWNER || "info@wagenbaas.nl";
const configured  = !!(process.env.MAILGUN_SMTP_USER && process.env.MAILGUN_SMTP_PASS);

async function sendEmail(to, subject, text) {
  if (!configured) return;
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, text });
}

function register(app) {
  // Mailgun: Routes → Create Route → Forward to /api/email/inbound
  app.post("/api/email/inbound", upload.none(), async (req, res) => {
    try {
      const fromRaw   = req.body.from || req.body.sender || "";
      const fromEmail = (fromRaw.match(/<(.+?)>/) || [, fromRaw])[1]?.trim() || fromRaw;
      const fromName  = fromRaw.replace(/<.+?>/, "").replace(/"/g, "").trim() || fromEmail;
      const subject   = req.body.subject || "(geen onderwerp)";
      const body      = req.body["body-plain"] || req.body["stripped-text"] || req.body.text || "";

      if (!fromEmail || !body) return res.sendStatus(200);

      db.insertMessage({ $session_id: fromEmail, $channel: CHANNEL, $direction: "inbound", $from_id: fromEmail, $from_name: fromName, $content: `[${subject}]\n${body}` });
      db.insertStat({ $event: "message_received", $channel: CHANNEL, $meta: fromEmail });

      const aiReply = await getEmailReply(fromName, fromEmail, subject, body.substring(0, 2000));

      const { appointment, lead, callback, declined } = extractData(aiReply);
      const cleanedReply = cleanReply(aiReply);

      if (appointment) {
        db.insertAppointment({ $name: appointment.name||fromName, $phone: appointment.phone||"", $email: appointment.email||fromEmail, $car_brand: appointment.car_brand||"", $car_model: appointment.car_model||"", $car_year: appointment.car_year||"", $license: appointment.license||"", $service: appointment.service||"", $pref_date: appointment.pref_date||"", $pref_time: appointment.pref_time||"", $notes: appointment.notes||"", $channel: CHANNEL });
        db.insertStat({ $event: "appointment_booked", $channel: CHANNEL, $meta: appointment.service||null });
        const hasDateTime = /^\d{4}-\d{2}-\d{2}$/.test(appointment.pref_date||"") && /^\d{2}:\d{2}$/.test(appointment.pref_time||"");
        if (hasDateTime && process.env.GOOGLE_REFRESH_TOKEN) {
          try {
            await createAppointmentEvent({
              summary: `Wagenbaas afspraak: ${appointment.service||"Service"} (${appointment.license||"zonder kenteken"})`,
              description: `Naam: ${appointment.name||fromName}\nEmail: ${fromEmail}\nService: ${appointment.service||""}\nKanaal: ${CHANNEL}`,
              date: appointment.pref_date, time: appointment.pref_time, durationMinutes: 60,
              attendees: [{ email: fromEmail }],
            });
          } catch {}
        }
      }
      if (lead) {
        const baseLead = { $name: lead.name||fromName, $phone: lead.phone||"", $email: lead.email||fromEmail, $source: CHANNEL, $notes: lead.notes||"" };
        const existing = db.findLeadByContact({ $phone: baseLead.$phone, $email: baseLead.$email });
        if (existing) db.updateLead({ ...baseLead, $id: existing.id });
        else db.insertLead(baseLead);
      }
      if (callback) db.insertCallback({ $name: callback.name||fromName, $phone: callback.phone||"", $reason: callback.reason||"", $channel: CHANNEL });
      if (declined) db.insertDeclined({ $name: declined.name||fromName, $phone: declined.phone||"", $email: declined.email||fromEmail, $reason: declined.reason||"", $channel: CHANNEL });

      db.insertMessage({ $session_id: fromEmail, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: cleanedReply });

      await sendEmail(fromEmail, `Re: ${subject}`, cleanedReply);
      await sendEmail(EMAIL_OWNER, `📧 Nieuw bericht van ${fromName}: ${subject}`, `Van: ${fromName} <${fromEmail}>\n\nBericht:\n${body}\n\n--- AI Antwoord ---\n${aiReply}`);

      res.sendStatus(200);
    } catch (err) {
      console.error("Email error:", err.message);
      res.sendStatus(200);
    }
  });

  console.log("📧 Email channel registered");
}

module.exports = { register, sendEmail, configured };
