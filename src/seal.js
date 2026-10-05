'use strict';
// Stateless session sealing.
//
// On serverless (Vercel) there is no shared memory between invocations and /tmp
// is per-instance and ephemeral, so an in-memory session Map silently loses state
// whenever the next request lands on a different (or cold-started) lambda. That is
// fatal for the Student-Portal flow: the user spends 20–60s reading the captcha
// between `sp/begin` and `sp/login`, which is more than enough for the instance to
// be recycled, after which the captcha challenge is gone forever.
//
// The only state that reliably survives the gap between two requests is what we
// hand back to the browser. So we carry the session itself in a signed cookie: the
// payload is readable (base64url JSON) but tamper-proof (HMAC-SHA256). No password
// is ever placed in it — only the short-lived SRM/Zoho session cookies.
//
// Set SESSION_SECRET in the deployment env so the signature survives redeploys and
// is verifiable across instances; a dev fallback keeps `npm start` working locally.
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET
  || 'campussy-dev-secret-change-me-set-SESSION_SECRET-in-prod';

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(body) {
  return b64urlEncode(crypto.createHmac('sha256', SECRET).update(body).digest());
}

// seal(obj) -> "<base64url(json)>.<base64url(hmac)>"
function seal(obj) {
  const body = b64urlEncode(Buffer.from(JSON.stringify(obj), 'utf8'));
  return `${body}.${sign(body)}`;
}

// unseal(token) -> obj if the signature verifies and JSON parses, else null.
function unseal(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
}

module.exports = { seal, unseal };
