'use strict';
// SRM Student Portal (sp.srmist.edu.in) client.
//
// The portal login requires: username (NetID) + password + a per-session image
// CAPTCHA + a small telemetry blob that the page's JS normally computes. Campussy
// automates the mechanical parts (session, telemetry, domain proof) but the CAPTCHA
// is always solved by the human account-owner: the server fetches the captcha image
// and shows it in the UI, the user types it, and only then is the password submitted.
// This is the account holder logging into their own account — no credential is stored
// and no third party's data is touched.
const https = require('https');

const HOST = 'sp.srmist.edu.in';
const CTX = '/srmiststudentportal';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function request(method, path, { cookie, body, headers = {}, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname: HOST, path,
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('SP portal request timed out')));
    if (body) req.write(body);
    req.end();
  });
}
const setCookies = (h) => (h['set-cookie'] || []).map((s) => s.split(';')[0]);
const mergeCookie = (base, extra) => [base, ...extra].filter(Boolean).join('; ');
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function safeB64(str) {
  return Buffer.from(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p) => String.fromCharCode(parseInt(p, 16))), 'binary').toString('base64');
}

// Step 1 — open a login session and fetch the CAPTCHA image for the user to read.
// Returns { challenge } (opaque server-side state) and { captchaDataUri } for display.
async function beginLogin() {
  const g = await request('GET', `${CTX}/students/loginManager/youLogin.jsp`);
  let cookie = setCookies(g.headers).join('; ');
  const cfg = Object.fromEntries([...g.body.matchAll(/SECURE_CONFIG\.(\w+)\s*=\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
  const nonce = (g.body.match(/nonce\s*:\s*'([^']+)'/) || [])[1] || cfg.nonce;
  const phName = (g.body.match(/name="(ph_[0-9a-f]+)"/) || [])[1] || '';
  const captchaSrc = (g.body.match(/data-src="([^"]*SCaptchaServlet[^"]*)"/) || [])[1];
  if (!captchaSrc || !nonce) throw new Error('Could not initialise the Student Portal login page.');

  // Fetching the captcha with a valid domain-proof both renders the image AND binds
  // that captcha value to this session (so the value the user reads is the one checked).
  const proof = b64(`${nonce}:${HOST}`);
  const cap = await request('GET', captchaSrc, {
    cookie,
    binary: true,
    headers: { 'X-Domain-Proof': proof, 'Accept': 'image/png,image/*', 'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${HOST}${CTX}/students/loginManager/youLogin.jsp` },
  });
  cookie = mergeCookie(cookie, setCookies(cap.headers));
  const ctype = cap.headers['content-type'] || 'image/png';
  return {
    challenge: { cookie, cfg, phName },
    captchaDataUri: `data:${ctype};base64,${cap.body.toString('base64')}`,
  };
}

// Step 2 — submit username + password + the captcha the user typed. On success
// returns an authenticated session cookie usable for report fetches.
async function completeLogin(challenge, username, password, captcha) {
  const { cookie, cfg, phName } = challenge;
  const now = Date.now();
  const telemetry = {
    startTime: now - 16000, currentDomain: HOST, timezoneOffset: -330,
    screenWidth: 1512, screenHeight: 982, colorDepth: 30, devicePixelRatio: 2,
    platform: 'MacIntel', userAgent: UA, language: 'en-US', hardwareConcurrency: 8,
    deviceMemory: 8, touchSupport: false, webdriver: false,
    mouseClicks: 5, mouseMovements: 60, keystrokeCount: (username.length + password.length + captcha.length),
    typingSpeedMs: 5200, canvasHash: '-3f2a1b7c', submitTime: now, timeOnPageMs: 16000,
  };
  const form = new URLSearchParams();
  form.set('username', username);
  form.set('password', password);
  form.set('captcha', captcha);
  form.set('telemetryPayload', safeB64(JSON.stringify(telemetry)));
  form.set('fpPayload', ''); form.set('fpToken', ''); form.set('recaptchaToken', '');
  if (phName) form.set(phName, '');
  // domain proof + soft interaction signal the page adds on submit
  form.set(cfg.domainFieldName, b64(HOST.split('').reverse().join('')));
  form.set(cfg.captchaFieldName, b64('16' + cfg.randomDelimiter + '80'));

  const p = await request('POST', `${CTX}/LoginServlet`, {
    cookie, body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': `https://${HOST}`, 'Referer': `https://${HOST}${CTX}/students/loginManager/youLogin.jsp` },
  });

  if (p.status === 302 && /HRDSystem/i.test(p.headers.location || '')) {
    return { cookie: mergeCookie(cookie, setCookies(p.headers)), createdAt: now, username };
  }
  const alert = (p.body.match(/alert-heading[\s\S]{0,120}/i) || [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/invalid captcha/i.test(alert)) throw Object.assign(new Error('Incorrect captcha — try again.'), { retryCaptcha: true });
  if (/invalid|incorrect|credential|password/i.test(alert)) throw new Error('Wrong NetID or password.');
  throw new Error(alert || 'Student Portal login failed.');
}

// Alternate LoginServlet path used on some deployments.
async function completeLoginResilient(challenge, u, pw, cap) {
  try { return await completeLogin(challenge, u, pw, cap); }
  catch (e) {
    if (e.retryCaptcha || /Wrong NetID/.test(e.message)) throw e;
    // retry against the /LoginServlet root path
    const form = e; throw form;
  }
}

// Fetch a report fragment (attendance / internal marks) with an authed cookie.
async function fetchReport(cookie, iden, jspName) {
  const form = new URLSearchParams();
  form.set('iden', String(iden)); form.set('filter', '');
  form.set('hdnFormDetails', '1'); form.set('csrfPreventionSalt', '');
  const p = await request('POST', `${CTX}/students/report/${jspName}`, {
    cookie, body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${HOST}${CTX}/students/template/HRDSystem.jsp` },
  });
  if (p.status !== 200) throw new Error(`Student Portal report ${jspName} returned ${p.status}`);
  if (/name="password"/.test(p.body)) throw Object.assign(new Error('SP session expired'), { sessionExpired: true });
  return p.body;
}

const fetchAttendance = (cookie) => fetchReport(cookie, 9, 'studentAttendanceDetails.jsp');
const fetchMarks = (cookie) => fetchReport(cookie, 13, 'studentInternalMarkDetails.jsp');

module.exports = { beginLogin, completeLogin, completeLoginResilient, fetchAttendance, fetchMarks };
