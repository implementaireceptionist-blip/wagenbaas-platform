const multer = require("multer");
const nodemailer = require("nodemailer");
const { getEmailReply } = require("../ai");
const { db } = require("../database");

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

      db.insertMessage({ $session_id: fromEmail, $channel: CHANNEL, $direction: "outbound", $from_id: "wagenbaas", $from_name: "Wagenbaas AI", $content: aiReply });

      await sendEmail(fromEmail, `Re: ${subject}`, aiReply);
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
