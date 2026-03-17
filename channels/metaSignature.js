const crypto = require("crypto");

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyMetaSignature({ appSecret, signatureHeader, rawBody }) {
  if (!appSecret) return true; // optional
  const header = signatureHeader || "";
  const m = header.match(/^sha256=(.+)$/);
  if (!m) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody || Buffer.from("")).digest("hex");
  return timingSafeEqualHex(m[1], expected);
}

module.exports = { verifyMetaSignature };

