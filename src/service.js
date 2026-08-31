'use strict';
const academia = require('./academia');
const store = require('./store');
const { parseTimetable } = require('./parsers/timetable');
const { parseUnified } = require('./parsers/unified');
const { parsePlanner, plannerPageFor } = require('./parsers/planner');
const { parseInternalMarks, parseAttendance } = require('./parsers/sp');

const UNIFIED_PAGE = { '1': 'Unified_Time_Table_2025_Batch_1', '2': 'Unified_Time_Table_2025_batch_2' };

// Fetch+parse an academia dataset with caching. `force` bypasses fresh cache.
async function cached(userKey, kind, session, loader, { force = false } = {}) {
  if (!force) {
    const hit = store.getCache(userKey, kind);
    if (hit && !hit.stale) return { ...hit.value, _cachedAt: hit.at, _fromCache: true };
  }
  try {
    const value = await loader(session);
    store.setCache(userKey, kind, value);
    return { ...value, _cachedAt: Date.now(), _fromCache: false };
  } catch (err) {
    // On failure (rate-limit etc.), fall back to stale cache if we have any.
    const stale = store.getCache(userKey, kind);
    if (stale) return { ...stale.value, _cachedAt: stale.at, _fromCache: true, _stale: true, _error: err.message };
    throw err;
  }
}

async function getTimetable(userKey, session, opts) {
  return cached(userKey, 'timetable', session, async (s) =>
    parseTimetable(await academia.fetchPage(s.academia.jar, 'My_Time_Table_2023_24')), opts);
}

async function getUnified(userKey, session, batch, opts) {
  const page = UNIFIED_PAGE[String(batch)] || UNIFIED_PAGE['1'];
  return cached(userKey, 'unified', session, async (s) =>
    parseUnified(await academia.fetchPage(s.academia.jar, page)), opts);
}

async function getPlanner(userKey, session, opts) {
  const page = plannerPageFor(new Date());
  return cached(userKey, 'planner', session, async (s) => {
    let html;
    try { html = await academia.fetchPage(s.academia.jar, page); }
    catch { html = await academia.fetchPage(s.academia.jar, fallbackPlanner(page)); }
    return parsePlanner(html, page);
  }, opts);
}
function fallbackPlanner(page) {
  // If the exact AY page 404s, try the previous odd/even planner.
  const m = page.match(/Academic_Planner_(\d+)_(\d+)_(ODD|EVEN)/);
  if (!m) return 'Academic_Planner_2025_26_ODD';
  return `Academic_Planner_${+m[1] - 1}_${String((+m[1]) % 100).padStart(2, '0')}_${m[3]}`;
}

// Cross-link: given a real date, resolve the day-order (from planner) and the list
// of classes that day (unified grid slot → personal course).
function localISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function classesForDate(date, timetable, unified, planner) {
  const iso = localISO(date); // avoid UTC shift (SRM/IST is UTC+5:30)
  const dayInfo = planner.days[iso];
  if (!dayInfo || !dayInfo.dayOrder) {
    return { date: iso, dayOrder: null, holiday: dayInfo ? dayInfo.holiday : null,
             event: dayInfo ? dayInfo.event : null, classes: [] };
  }
  const grid = unified.grid[String(dayInfo.dayOrder)] || {};
  const classes = [];
  for (const [hour, slots] of Object.entries(grid)) {
    for (const slot of slots) {
      const course = timetable.courses.find(c => c.slots.includes(slot));
      if (course) {
        classes.push({
          hour: +hour, slot, code: course.code, title: course.title,
          faculty: course.faculty, room: course.room, isLab: course.isLab,
          time: (unified.times && unified.times[+hour - 1]) || null,
        });
      }
    }
  }
  classes.sort((a, b) => a.hour - b.hour);
  return { date: iso, dayOrder: dayInfo.dayOrder, weekday: dayInfo.weekday,
           holiday: false, event: dayInfo.event, classes };
}

// SP data is fetched server-side with the user's authenticated portal cookie
// (obtained via the captcha login flow), then parsed + cached.
const sp = require('./sp');
async function refreshSp(userKey, spCookie) {
  const [attHtml, markHtml] = await Promise.all([
    sp.fetchAttendance(spCookie),
    sp.fetchMarks(spCookie),
  ]);
  const attendance = parseAttendance(attHtml);
  const marks = parseInternalMarks(markHtml);
  store.setCache(userKey, 'attendance', attendance);
  store.setCache(userKey, 'marks', marks);
  return { attendance, marks };
}
function getSp(userKey, kind) {
  const hit = store.getCache(userKey, kind);
  return hit ? { ...hit.value, _cachedAt: hit.at, _stale: hit.stale } : null;
}

module.exports = { getTimetable, getUnified, getPlanner, classesForDate, refreshSp, getSp };
