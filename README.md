# Wagenbaas Omnichannel AI Receptionist

## Deploy to Render.com

- Create a new **Web Service** from your Git repo (Render will detect `render.yaml`).
- In Render, set all required **Environment Variables** in the dashboard (API keys, tokens, `ADMIN_TOKEN`, and `ENABLE_*` flags).
- Persistent SQLite is stored at **`/data/wagenbaas.db`** via Render Disk (configured in `render.yaml` as `DB_PATH=/data/wagenbaas.db`).

## Voice (Telnyx + Deepgram + ElevenLabs)

This project supports a real-time AI phone receptionist using Telnyx media streaming (WebSocket), Deepgram streaming STT, and ElevenLabs TTS (MP3 sent back over the same Telnyx WebSocket).

### Required environment variables

- `ENABLE_VOICE=true`
- `DEEPGRAM_API_KEY=...`
- `ELEVENLABS_API_KEY=...`
- `ELEVENLABS_VOICE_ID=...`
- Optional: `VOICE_GREETING_NL=...`

### Telnyx setup (to test with your phone number)

1. Buy or port your number into Telnyx (e.g. `+40752859831`) and enable Voice.
2. Create a **TeXML application** (or set the Voice webhook URL on the number) and point it to:
   - **Voice URL**: `https://<your-domain>/api/voice/inbound`
   - Method: `POST`
3. Make sure your app is deployed on Render with a public HTTPS domain. WebSockets must be reachable at:
   - `wss://<your-domain>/api/voice/stream`

### Test

- Call your Telnyx number.
- You should hear the greeting, then you can speak normally.
- The system will transcribe via Deepgram, answer via AI, and speak back via ElevenLabs.

### Custom domain + SSL (Render)

- In Render: your service → **Settings** → **Custom Domains** → add your domain (e.g. `receptionist.yourdomain.com`).
- Point your DNS to Render (they show the exact CNAME/A records to add).
- Render automatically provisions and renews **SSL** once DNS is correct.

