'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const academia = require('./academia');
const store = require('./store');
const svc = require('./service');
const { seal, unseal } = require('./seal');
const { Jar } = academia;

const app = express();
// Behind Vercel/Render's TLS-terminating proxy so req.protocol reflects https
// and Secure cookies are emitted correctly.
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));       // bookmarklet posts full HTML
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const userKeyOf = (s) => 'u_' + crypto.createHash('sha256')
  .update((s.user && s.user.registrationNumber) || s.academia.email).digest('hex').slice(0, 16);

// Cookies must be Secure in production (served over https); on http://localhost
// `secure` would stop the browser from ever sending them back, so only set it when
// deployed (Vercel and Render both set a telltale env var).
const IS_PROD = !!(process.env.VERCEL || process.env.RENDER);
const cookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge });

// Persist the durable parts of a session into the signed `csid` cookie. Only the
// SRM/Zoho session cookies travel — never a password.
function writeSession(res, session) {
  res.cookie('csid', seal({
    v: 1,
    createdAt: session.createdAt,
    email: session.academia.email,
    cookies: session.academia.jar.toObject(),
    user: session.user,
    sp: session.sp ? { cookie: session.sp.cookie, username: session.sp.username, createdAt: session.sp.createdAt } : undefined,
  }), cookieOpts(store.SIX_HOURS));
}

function auth(req, res, next) {
  const p = unseal(req.cookies.csid);
  if (!p || !p.createdAt || Date.now() - p.createdAt > store.SIX_HOURS) {
    return res.status(401).json({ error: 'session_expired', message: 'Session expired — please log in again.' });
  }
  req.session = {
    createdAt: p.createdAt,
    academia: { jar: Jar.from(p.cookies), email: p.email, createdAt: p.createdAt },
    user: p.user || {},
    sp: p.sp,
  };
  req.userKey = userKeyOf(req.session);
  req.saveSession = () => writeSession(res, req.session);
  next();
}

// --- Auth ---
app.post('/api/login', async (req, res) => {
  const { academiaEmail, academiaPassword } = req.body || {};
  if (!academiaEmail || !academiaPassword) {
    return res.status(400).json({ error: 'missing', message: 'Academia email and password are required.' });
  }
  try {
    const session = await academia.login(academiaEmail.trim(), academiaPassword);
    // Fetch timetable once to learn identity + batch, prime the cache.
    let tt;
    try {
      const { parseTimetable } = require('./parsers/timetable');
      tt = parseTimetable(await academia.fetchPage(session.jar, 'My_Time_Table_2023_24'));
    } catch { tt = { student: {}, courses: [] }; }
    const user = tt.student || {};
    const full = { academia: session, user, createdAt: Date.now() };
    const uk = userKeyOf(full);
    store.setCache(uk, 'timetable', tt);
    writeSession(res, full);
    res.json({ ok: true, student: user, hasSp: !!svc.getSp(uk, 'attendance') });
  } catch (err) {
    // Academia error messages arrive HTML-encoded (and sometimes with markup).
    const clean = String(err.message || 'Login failed.')
      .replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    res.status(401).json({ error: 'login_failed', message: clean });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('csid');
  res.clearCookie('spch');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    student: req.session.user,
    sessionAgeMs: Date.now() - req.session.createdAt,
    sessionResetInMs: store.SIX_HOURS - (Date.now() - req.session.createdAt),
    hasSp: !!svc.getSp(req.userKey, 'attendance') || !!svc.getSp(req.userKey, 'marks'),
  });
});

// --- Academia datasets ---
app.get('/api/timetable', auth, async (req, res) => {
  try { res.json(await svc.getTimetable(req.userKey, req.session, { force: req.query.force === '1' })); }
  catch (e) { res.status(502).json({ error: 'fetch_failed', message: e.message }); }
});

app.get('/api/planner', auth, async (req, res) => {
  try { res.json(await svc.getPlanner(req.userKey, req.session, { force: req.query.force === '1' })); }
  catch (e) { res.status(502).json({ error: 'fetch_failed', message: e.message }); }
});

// Dashboard: today + upcoming days, fully cross-linked.
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const force = req.query.force === '1';
    const tt = await svc.getTimetable(req.userKey, req.session, { force });
    const batch = (tt.student && /(^|\W)1(\W|$)/.test(tt.student.batch || '')) ? '1'
      : (/(^|\W)2(\W|$)/.test((tt.student && tt.student.batch) || '') ? '2' : '1');
    const [uni, plan] = await Promise.all([
      svc.getUnified(req.userKey, req.session, batch, { force }),
      svc.getPlanner(req.userKey, req.session, { force }),
    ]);
    const base = new Date();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      days.push(svc.classesForDate(d, tt, uni, plan));
    }
    const att = svc.getSp(req.userKey, 'attendance');
    const marks = svc.getSp(req.userKey, 'marks');
    res.json({
      student: tt.student,
      batch,
      today: days[0],
      week: days,
      courses: tt.courses,
      attendance: att,
      marks,
      cache: { timetableAt: tt._cachedAt, unifiedAt: uni._cachedAt, plannerAt: plan._cachedAt,
               attendanceAt: att && att._cachedAt, marksAt: marks && marks._cachedAt },
      warnings: [tt._error, uni._error, plan._error].filter(Boolean),
    });
  } catch (e) {
    res.status(502).json({ error: 'dashboard_failed', message: e.message });
  }
});

// --- SP portal: automated login (captcha solved by the user) ---
const sp = require('./sp');

// 1) open a portal session and return the captcha image to display. The challenge
// (opaque SRM state, no secrets) rides back in a short-lived signed cookie so the
// begin→login handoff survives serverless — the user may take a while on the captcha.
app.post('/api/sp/begin', auth, async (req, res) => {
  try {
    const { challenge, captchaDataUri } = await sp.beginLogin();
    res.cookie('spch', seal(challenge), cookieOpts(15 * 60 * 1000));
    res.json({ ok: true, captcha: captchaDataUri });
  } catch (e) {
    res.status(502).json({ error: 'sp_begin_failed', message: e.message });
  }
});

// 2) submit NetID + password + typed captcha; on success fetch + cache the data
app.post('/api/sp/login', auth, async (req, res) => {
  const { netid, password, captcha } = req.body || {};
  if (!netid || !password || !captcha) {
    return res.status(400).json({ error: 'missing', message: 'NetID, password and captcha are required.' });
  }
  const challenge = unseal(req.cookies.spch);
  if (!challenge) {
    return res.status(400).json({ error: 'no_challenge', message: 'Captcha session expired — reload the captcha.' });
  }
  try {
    const spSession = await sp.completeLogin(challenge, netid.trim(), password, captcha.trim());
    req.session.sp = spSession;
    writeSession(res, req.session);      // persist the authed portal cookie into csid
    res.clearCookie('spch');             // single-use challenge
    const { attendance, marks } = await svc.refreshSp(req.userKey, spSession.cookie);
    res.json({ ok: true, attendance: attendance.courses.length, marks: marks.courses.length });
  } catch (e) {
    res.status(e.retryCaptcha ? 401 : 400).json({ error: 'sp_login_failed', message: e.message, retryCaptcha: !!e.retryCaptcha });
  }
});

// Re-fetch SP data using the stored portal cookie (falls back to cache on expiry).
app.post('/api/sp/refresh', auth, async (req, res) => {
  if (!req.session.sp) return res.status(400).json({ error: 'not_connected', message: 'Connect the Student Portal first.' });
  try {
    const { attendance, marks } = await svc.refreshSp(req.userKey, req.session.sp.cookie);
    res.json({ ok: true, attendance: attendance.courses.length, marks: marks.courses.length });
  } catch (e) {
    if (e.sessionExpired) { delete req.session.sp; writeSession(res, req.session); return res.status(401).json({ error: 'sp_expired', message: 'Portal session expired — reconnect.' }); }
    res.status(502).json({ error: 'sp_refresh_failed', message: e.message });
  }
});

app.get('/api/sp/attendance', auth, (req, res) => res.json(svc.getSp(req.userKey, 'attendance') || { courses: [] }));
app.get('/api/sp/marks', auth, (req, res) => res.json(svc.getSp(req.userKey, 'marks') || { courses: [] }));

// Run a real server for local dev / persistent hosts; on Vercel the app is
// imported as a serverless handler (see api/index.js) so we don't call listen().
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`\n  🎓  Campussy running →  http://localhost:${PORT}\n`));
}
module.exports = app;
