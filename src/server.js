'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const academia = require('./academia');
const store = require('./store');
const svc = require('./service');

const app = express();
app.use(express.json({ limit: '4mb' }));       // bookmarklet posts full HTML
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const userKeyOf = (s) => 'u_' + crypto.createHash('sha256')
  .update((s.user && s.user.registrationNumber) || s.academia.email).digest('hex').slice(0, 16);

function auth(req, res, next) {
  const sid = req.cookies.csid;
  const session = sid && store.getSession(sid);
  if (!session) return res.status(401).json({ error: 'session_expired', message: 'Session expired — please log in again.' });
  req.session = session;
  req.sid = sid;
  req.userKey = userKeyOf(session);
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
    const sid = store.newSid();
    // Fetch timetable once to learn identity + batch, prime the cache.
    const tmpKey = 'u_' + crypto.createHash('sha256').update(academiaEmail.trim()).digest('hex').slice(0, 16);
    let tt;
    try {
      const { parseTimetable } = require('./parsers/timetable');
      tt = parseTimetable(await academia.fetchPage(session.jar, 'My_Time_Table_2023_24'));
    } catch { tt = { student: {}, courses: [] }; }
    const user = tt.student || {};
    store.putSession(sid, { academia: session, user });
    const uk = userKeyOf({ academia: session, user });
    store.setCache(uk, 'timetable', tt);
    res.cookie('csid', sid, { httpOnly: true, sameSite: 'lax', maxAge: store.SIX_HOURS });
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
  if (req.cookies.csid) store.dropSession(req.cookies.csid);
  res.clearCookie('csid');
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

// 1) open a portal session and return the captcha image to display
app.post('/api/sp/begin', auth, async (req, res) => {
  try {
    const { challenge, captchaDataUri } = await sp.beginLogin();
    req.session.spChallenge = challenge; // held in-memory on the Campussy session
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
  if (!req.session.spChallenge) {
    return res.status(400).json({ error: 'no_challenge', message: 'Captcha session expired — reload the captcha.' });
  }
  try {
    const spSession = await sp.completeLogin(req.session.spChallenge, netid.trim(), password, captcha.trim());
    req.session.sp = spSession;               // authed portal cookie, in-memory only
    delete req.session.spChallenge;
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
    if (e.sessionExpired) { delete req.session.sp; return res.status(401).json({ error: 'sp_expired', message: 'Portal session expired — reconnect.' }); }
    res.status(502).json({ error: 'sp_refresh_failed', message: e.message });
  }
});

app.get('/api/sp/attendance', auth, (req, res) => res.json(svc.getSp(req.userKey, 'attendance') || { courses: [] }));
app.get('/api/sp/marks', auth, (req, res) => res.json(svc.getSp(req.userKey, 'marks') || { courses: [] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  🎓  Campussy running →  http://localhost:${PORT}\n`));
