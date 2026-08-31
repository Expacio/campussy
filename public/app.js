'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: 'include', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || r.statusText), { code: j.error, status: r.status });
  return j;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 3200); };
const ago = (ms) => { if (!ms) return 'never'; const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let STATE = {};

// ---------- Login ----------
$('#loginBtn').addEventListener('click', doLogin);
$('#acaPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const email = $('#acaEmail').value.trim(), pass = $('#acaPass').value;
  const err = $('#loginErr'), btn = $('#loginBtn');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Enter your Academia email and password.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Signing in to SRM…';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ academiaEmail: email, academiaPassword: pass }) });
    await boot();
  } catch (e) {
    err.textContent = e.message || 'Login failed.';
  } finally { btn.disabled = false; btn.textContent = 'Sign in to Academia'; }
}

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});
$('#refreshBtn').addEventListener('click', () => loadDashboard(true));

// ---------- Boot ----------
async function boot() {
  try {
    const me = await api('/api/me');
    STATE.me = me;
    $('#login').classList.add('hidden');
    $('#dash').classList.remove('hidden');
    renderWho(me.student, me);
    await loadDashboard(false);
  } catch (e) {
    $('#login').classList.remove('hidden');
    $('#dash').classList.add('hidden');
  }
}

function renderWho(s, me) {
  $('#whoName').textContent = s.name || s.registrationNumber || 'Student';
  const bits = [s.registrationNumber, s.program, s.department && s.department.replace(/\s*\(.*$/, ''), s.semester && ('Sem ' + s.semester)].filter(Boolean);
  $('#whoMeta').textContent = bits.join(' · ');
  const hrs = Math.max(0, me.sessionResetInMs / 3600000);
  $('#sessionChip').textContent = `session ${hrs.toFixed(1)}h left`;
}

// ---------- Tabs ----------
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
  const name = t.dataset.tab;
  $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== name));
}));

// ---------- Dashboard ----------
async function loadDashboard(force) {
  const todayView = $('[data-view="today"]');
  todayView.innerHTML = '<div class="empty"><span class="spin"></span> Loading your timetable…</div>';
  try {
    const d = await api('/api/dashboard' + (force ? '?force=1' : ''));
    STATE.dash = d;
    renderWho(d.student, STATE.me);
    // Academia data — always shown by default.
    renderToday(d);
    renderWeek(d);
    renderCourses(d);
    renderCalendar(d);
    // Student-Portal data — only surfaced if the user has already connected it.
    const hasSp = (d.attendance && d.attendance.courses && d.attendance.courses.length) ||
                  (d.marks && d.marks.courses && d.marks.courses.length);
    $$('.tab-sp').forEach(t => t.classList.toggle('hidden', !hasSp));
    if (hasSp) { renderAttendance(d); renderMarks(d); }
    renderSpPanel(d, hasSp);
    if (force) toast('Refreshed from SRM ✓');
    if (d.warnings && d.warnings.length) toast('Using cached data (SRM slow): ' + d.warnings[0]);
  } catch (e) {
    if (e.code === 'session_expired') { toast('Session expired — please log in again.'); setTimeout(() => location.reload(), 1200); return; }
    todayView.innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}<br><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
}

function classCard(c) {
  return `<div class="class ${c.isLab ? 'lab' : ''}">
    <div class="hour"><b>${c.hour}</b><span>hour</span></div>
    <div><div class="code">${esc(c.code)} ${c.isLab ? '<span class="mini">· LAB</span>' : ''}</div>
      <div class="title">${esc(c.title)}</div>
      <div class="meta">${esc(c.faculty || '')}</div></div>
    <div class="end"><div class="slot">${esc(c.slot)}</div><div class="room">${esc(c.room || '')}</div></div>
  </div>`;
}

function renderToday(d) {
  const t = d.today, v = $('[data-view="today"]');
  const now = new Date();
  const head = `<div class="dayhero">
    <span class="do">${t.dayOrder ? 'Day Order ' + t.dayOrder : (t.holiday ? 'Holiday' : 'No classes')}</span>
    <span class="date">${DOW[now.getDay()]}, ${now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}</span>
    ${t.event ? `<span class="badge event">${esc(t.event)}</span>` : ''}
    ${t.holiday ? `<span class="badge holiday">Holiday</span>` : ''}
  </div>`;
  if (!t.classes.length) {
    v.innerHTML = head + `<div class="empty">${t.holiday ? '🌴 Enjoy the day off — no classes today.' : t.dayOrder ? 'No classes mapped for this day order.' : 'Day order not published for today yet.'}</div>`;
    return;
  }
  v.innerHTML = head + `<div class="classlist">${t.classes.map(classCard).join('')}</div>`;
}

function renderWeek(d) {
  const v = $('[data-view="week"]');
  v.innerHTML = `<h2 class="section-title">Next 7 days</h2><p class="section-sub">Day orders + classes, resolved from the planner &amp; unified timetable.</p>` +
    d.week.map((day, i) => {
      const dt = new Date(day.date + 'T00:00:00');
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DOW[dt.getDay()];
      const badge = day.dayOrder ? `<span class="badge event">Day Order ${day.dayOrder}</span>`
        : day.holiday ? `<span class="badge holiday">Holiday</span>` : `<span class="mini">— not published —</span>`;
      const body = day.classes.length
        ? `<div class="classlist">${day.classes.map(classCard).join('')}</div>`
        : `<div class="empty">${day.holiday ? '🌴 Holiday' : day.event ? esc(day.event) : 'No classes'}</div>`;
      return `<div class="week-day"><h3>${label} <span class="mini">${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span> ${badge}</h3>${body}</div>`;
    }).join('');
}

function renderCourses(d) {
  const v = $('[data-view="courses"]');
  // Merge lab + theory rows of the same course code into one card.
  const byCode = new Map();
  for (const c of d.courses) {
    const m = byCode.get(c.code) || { code: c.code, title: c.title, faculty: c.faculty, category: c.category, credit: c.credit, slots: [], rooms: new Set() };
    m.slots.push(c.slot);
    if (c.room) m.rooms.add(c.room);
    if (!m.faculty && c.faculty) m.faculty = c.faculty;
    byCode.set(c.code, m);
  }
  const list = [...byCode.values()];
  v.innerHTML = `<h2 class="section-title">Your courses · Semester ${esc(d.student.semester || '')}</h2>
    <p class="section-sub">${list.length} registered courses · batch ${esc(d.batch)}</p>
    <div class="grid cards">${list.map(c => `<div class="stat">
      <div class="k">${esc(c.code)} · slot <b style="color:var(--accent2)">${esc(c.slots.join(' + '))}</b></div>
      <div class="v" style="font-size:16px;line-height:1.3;margin-top:8px">${esc(c.title)}</div>
      <div class="mini" style="margin-top:10px">${esc(c.faculty || '')}</div>
      <div class="mini">${esc(c.category || '')} · ${esc(c.credit || '?')} credits · ${esc([...c.rooms].join(', ') || '—')}</div>
    </div>`).join('')}</div>`;
}

function ringColor(p) { return p >= 85 ? 'var(--green)' : p >= 75 ? 'var(--accent2)' : p >= 65 ? 'var(--warn)' : 'var(--danger)'; }

function renderAttendance(d) {
  const v = $('[data-view="attendance"]');
  const a = d.attendance;
  if (!a || !a.courses || !a.courses.length) { v.innerHTML = spPrompt('attendance'); return; }
  const short = a.courses.filter(c => c.status === 'shortage').length;
  const overall = a.courses.filter(c => c.percent != null);
  const avg = overall.length ? (overall.reduce((s, c) => s + c.percent, 0) / overall.length).toFixed(1) : '—';
  v.innerHTML = `<h2 class="section-title">Attendance</h2>
    <p class="section-sub">Synced ${ago(a._cachedAt)} · from Student Portal</p>
    <div class="grid cards" style="margin-bottom:20px">
      <div class="stat"><div class="k">Average</div><div class="v" style="color:${ringColor(+avg)}">${avg}%</div></div>
      <div class="stat"><div class="k">Courses below 75%</div><div class="v" style="color:${short ? 'var(--danger)' : 'var(--green)'}">${short}</div></div>
      <div class="stat"><div class="k">Tracked courses</div><div class="v">${a.courses.length}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:1fr">
    ${a.courses.map(c => {
      const p = c.percent == null ? 0 : c.percent, rc = ringColor(p);
      const note = c.status === 'shortage'
        ? `<span class="tag-short">Need ~${c.needToAttend} more classes to reach 75%</span>`
        : c.canSkip > 0 ? `<span class="tag-safe">Can skip ${c.canSkip} and stay ≥75%</span>` : '';
      return `<div class="attn"><div>
        <div class="code">${esc(c.code)} <span class="muted" style="font-weight:400">${esc(c.title || '')}</span></div>
        <div class="sub">${c.attended ?? '?'} / ${c.conducted ?? '?'} hours · ${note}</div>
        <div class="bar"><i style="width:${p}%;background:${rc}"></i></div>
      </div>
      <div class="ring" style="--p:${p};--rc:${rc}"><i>${c.percent == null ? '—' : c.percent + '%'}</i></div></div>`;
    }).join('')}</div>`;
}

function renderMarks(d) {
  const v = $('[data-view="marks"]');
  const m = d.marks;
  if (!m || !m.courses || !m.courses.length) { v.innerHTML = spPrompt('marks'); return; }
  const labels = [...new Set(m.courses.flatMap(c => c.components.map(x => x.label)))];
  v.innerHTML = `<h2 class="section-title">Internal marks</h2>
    <p class="section-sub">Synced ${ago(m._cachedAt)} · from Student Portal</p>
    <div style="overflow:auto"><table class="mk"><thead><tr><th>Course</th>${labels.map(l => `<th>${esc(l)}</th>`).join('')}<th>Total</th><th>%</th></tr></thead>
    <tbody>${m.courses.map(c => {
      const by = Object.fromEntries(c.components.map(x => [x.label, x]));
      return `<tr><td><b>${esc(c.code)}</b><div class="mini">${esc(c.title || '')}</div></td>
        ${labels.map(l => `<td>${by[l] ? esc(by[l].scored) + (by[l].max ? '<span class="mini">/' + by[l].max + '</span>' : '') : '<span class="faint">—</span>'}</td>`).join('')}
        <td><b>${c.totalScored}</b>${c.totalMax ? '<span class="mini">/' + c.totalMax + '</span>' : ''}</td>
        <td style="color:${c.percent >= 50 ? 'var(--green)' : 'var(--warn)'}">${c.percent == null ? '—' : c.percent + '%'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- Calendar (academia planner) ----------
async function renderCalendar(d) {
  const v = $('[data-view="calendar"]');
  if (!STATE.planner) {
    try { STATE.planner = await api('/api/planner'); } catch { v.innerHTML = '<div class="empty">Calendar unavailable.</div>'; return; }
  }
  const days = STATE.planner.days || {};
  const today = new Date();
  const monthKey = STATE.calMonth || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = monthKey.split('-').map(Number);
  const first = new Date(y, m - 1, 1), lead = first.getDay(), dim = new Date(y, m, 0).getDate();
  const months = STATE.planner.months || [];
  const idx = months.indexOf(monthKey);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div></div>');
  for (let dd = 1; dd <= dim; dd++) {
    const iso = `${monthKey}-${String(dd).padStart(2, '0')}`;
    const info = days[iso];
    const isToday = iso === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const doN = info && info.dayOrder;
    const hol = info && info.holiday;
    cells.push(`<div class="cal-cell ${isToday ? 'cal-today' : ''} ${hol ? 'cal-hol' : ''}" title="${esc(info && info.event || '')}">
      <span class="cal-d">${dd}</span>
      ${doN ? `<span class="cal-do">DO${doN}</span>` : hol ? `<span class="cal-x">${info.event ? '•' : '—'}</span>` : ''}
    </div>`);
  }
  v.innerHTML = `<div class="cal-head">
      <button class="btn ghost" id="calPrev" ${idx <= 0 ? 'disabled' : ''}>‹</button>
      <h2 class="section-title" style="margin:0">${first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <button class="btn ghost" id="calNext" ${idx >= months.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <p class="section-sub">Day orders &amp; holidays from the academic planner.</p>
    <div class="cal-grid cal-dow">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<div class="cal-dowc">${x}</div>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>`;
  const nav = (delta) => { const ni = idx + delta; if (months[ni]) { STATE.calMonth = months[ni]; renderCalendar(d); } };
  $('#calPrev') && ($('#calPrev').onclick = () => nav(-1));
  $('#calNext') && ($('#calNext').onclick = () => nav(1));
}

// ---------- Student Portal: opt-in captcha login ----------
function spPrompt() { return ''; } // SP views only render when connected

async function renderSpPanel(d, hasSp) {
  const v = $('[data-view="sp"]');
  const status = hasSp
    ? `<div class="sp-ok">✓ Connected · attendance synced ${d.attendance ? ago(d.attendance._cachedAt) : '—'}, marks ${d.marks ? ago(d.marks._cachedAt) : '—'}. See the Attendance / Marks tabs.</div>`
    : '';
  v.innerHTML = `<h2 class="section-title">Marks &amp; Attendance <span class="mini">(optional)</span></h2>
    <p class="section-sub">These live on the SRM <b>Student Portal</b> — a separate login from Academia. Connect it below to see attendance &amp; internal marks.</p>
    ${status}
    <div class="card" style="max-width:460px">
      <div class="acc">
        <div class="acc-head"><span class="pill pill-green">SP</span> Student Portal login</div>
        <input id="spNet" type="text" maxlength="6" placeholder="NetID (e.g. am7799)" autocomplete="username" />
        <input id="spPass" type="password" placeholder="Student Portal password" autocomplete="current-password" />
        <div id="spCapWrap" class="hidden">
          <p class="mini" style="margin:8px 0 4px">Type the characters in the image (case-sensitive):</p>
          <img id="spCapImg" class="cap-img" alt="captcha" />
          <div style="display:flex;gap:8px;align-items:center">
            <input id="spCap" type="text" placeholder="Captcha" autocomplete="off" style="flex:1" />
            <button id="spCapReload" class="btn ghost" title="New captcha">↻</button>
          </div>
        </div>
        <button id="spGo" class="btn primary" style="margin-top:10px">Load captcha</button>
        <div id="spErr" class="err"></div>
      </div>
      <p class="fine">Your Student-Portal password is sent only to SRM to establish the session. The captcha is served straight from SRM for you to solve — Campussy stores no password.</p>
      ${hasSp ? '<button id="spRefresh" class="btn ghost" style="margin-top:6px">↻ Refresh marks &amp; attendance</button>' : ''}
    </div>`;

  const netEl = $('#spNet'), passEl = $('#spPass'), capWrap = $('#spCapWrap'), capImg = $('#spCapImg'),
        capEl = $('#spCap'), goBtn = $('#spGo'), err = $('#spErr');
  let stage = 'creds';

  async function loadCaptcha() {
    err.textContent = ''; goBtn.disabled = true; goBtn.innerHTML = '<span class="spin"></span> Loading captcha…';
    try {
      const r = await api('/api/sp/begin', { method: 'POST' });
      capImg.src = r.captcha; capWrap.classList.remove('hidden');
      stage = 'captcha'; goBtn.textContent = 'Connect'; capEl.value = ''; capEl.focus();
    } catch (e) { err.textContent = e.message; goBtn.textContent = 'Load captcha'; }
    finally { goBtn.disabled = false; }
  }
  async function submit() {
    err.textContent = '';
    if (!netEl.value.trim() || !passEl.value) { err.textContent = 'Enter your NetID and password.'; return; }
    if (!capEl.value.trim()) { err.textContent = 'Type the captcha.'; return; }
    goBtn.disabled = true; goBtn.innerHTML = '<span class="spin"></span> Connecting…';
    try {
      await api('/api/sp/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netid: netEl.value.trim(), password: passEl.value, captcha: capEl.value.trim() }) });
      toast('Student Portal connected ✓');
      await loadDashboard(false);
      document.querySelector('[data-tab=attendance]').click();
    } catch (e) {
      err.textContent = e.message;
      if (e.code === 'sp_login_failed' && /captcha/i.test(e.message)) await loadCaptcha(); // fresh captcha
      goBtn.disabled = false; goBtn.textContent = 'Connect';
    }
  }
  goBtn.onclick = () => (stage === 'creds' ? loadCaptcha() : submit());
  $('#spCapReload') && ($('#spCapReload').onclick = loadCaptcha);
  capEl && (capEl.onkeydown = (e) => { if (e.key === 'Enter') submit(); });
  $('#spRefresh') && ($('#spRefresh').onclick = async () => {
    try { await api('/api/sp/refresh', { method: 'POST' }); toast('Refreshed ✓'); loadDashboard(false); }
    catch (e) { toast(e.message); }
  });
}

boot();
