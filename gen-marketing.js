const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const SRC = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.USERPROFILE || 'C:/Users/rcris', 'Downloads', 'receptionist.jpg');
const OUT = path.join(process.env.USERPROFILE || 'C:/Users/rcris', 'Desktop', 'wagenbaas-no-missed-leads.png');

const W = 1080, H = 1080;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0.38" x2="0" y2="1">
      <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
      <stop offset="35%"  stop-color="#000" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.93"/>
    </linearGradient>
  </defs>

  <!-- gradient overlay -->
  <rect width="${W}" height="${H}" fill="url(#g)"/>

  <!-- orange accent line -->
  <rect x="80" y="648" width="72" height="5" fill="#ff6b1a" rx="2"/>

  <!-- brand tag -->
  <text x="80" y="692"
    font-family="Arial" font-size="22" font-weight="700"
    fill="#ff6b1a" letter-spacing="4">AI RECEPTIONIST — AVAILABLE 24/7</text>

  <!-- main headline line 1 -->
  <text x="80" y="798"
    font-family="Arial Black, Arial" font-size="96" font-weight="900"
    fill="#ffffff">No Missed</text>

  <!-- main headline line 2 — orange dot on period -->
  <text x="80" y="908"
    font-family="Arial Black, Arial" font-size="96" font-weight="900"
    fill="#ffffff">Leads<tspan fill="#ff6b1a">.</tspan></text>

  <!-- sub lines -->
  <text x="82" y="964"
    font-family="Arial" font-size="38" font-weight="600"
    fill="rgba(255,255,255,0.92)">Implement it</text>
  <text x="82" y="1010"
    font-family="Arial" font-size="38" font-weight="600"
    fill="rgba(255,255,255,0.92)">Now.</text>
</svg>`;

(async () => {
  try {
    const meta = await sharp(SRC).metadata();
    const scale = Math.max(W / meta.width, H / meta.height);
    const rw = Math.round(meta.width  * scale);
    const rh = Math.round(meta.height * scale);
    const left = Math.round((rw - W) / 2);
    const top  = Math.round((rh - H) / 2);

    await sharp(SRC)
      .resize(rw, rh)
      .extract({ left, top, width: W, height: H })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png({ quality: 95 })
      .toFile(OUT);

    console.log('✅ Saved:', OUT);
  } catch (e) {
    console.error('❌', e.message);
  }
})();
