// Voice channel (Telnyx + Deepgram + ElevenLabs)
// Full implementation available in Phase 2
// Enable with ENABLE_VOICE=true in .env

function register(app) {
  app.post("/api/voice/inbound", (req, res) => {
    // Telnyx TeXML response - answers call and streams to AI
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lotte" language="nl-NL">
    Goedendag, u bent verbonden met Wagenbaas. Een moment geduld.
  </Say>
  <Stream url="wss://${req.headers.host}/api/voice/stream"/>
</Response>`;
    res.type("text/xml").send(texml);
  });

  // WebSocket stream handler for real-time voice AI
  // Requires ws package and Deepgram/ElevenLabs setup
  // See README-VOICE.md for full setup instructions

  console.log("📞 Voice channel registered (basic mode - see README-VOICE.md for full setup)");
}

module.exports = { register };
