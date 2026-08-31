'use strict';
const { decodeEmbed } = require('./decode');

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function txt(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// The Academic Planner is a matrix: rows = day-of-month (1..31), columns grouped
// into per-month blocks of 5: [DateNum, Weekday, Event, DayOrder, spare].
// We detect the month/year of each block from tokens like "Jul '26" in the page,
// then emit a { "YYYY-MM-DD": { dayOrder, weekday, event, holiday } } map.
function parsePlanner(raw, pageName = '') {
  let html = decodeEmbed(raw);
  // The calendar body is HTML-entity-encoded inside the decoded blob.
  html = html.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

  // Determine block months from tokens like "Jul '26","Aug '26"... in document order.
  const monthTokens = [...html.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*'?\s*(\d{2})\b/gi)]
    .map(m => ({ mon: MONTHS[m[1].toLowerCase()], yy: 2000 + parseInt(m[2], 10) }));
  // Keep the first contiguous run of distinct months (the header sequence).
  const blocks = [];
  const seen = new Set();
  for (const t of monthTokens) {
    const key = t.yy + '-' + t.mon;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(t);
    if (blocks.length >= 8) break;
  }

  const days = {};
  // The day-31 line (only Jul/Aug/Oct/Dec have 31 days) is emitted as orphaned
  // <td> cells right after a </tr> with no opening <tr>. Re-wrap those, then split
  // rows tolerantly (up to the next <tr> / </table>, not requiring a </tr>).
  html = html.replace(/<\/tr>(\s*<td)/gi, '</tr><tr>$1');
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)(?=<tr[^>]*>|<\/table|$)/gi)].map(m => m[1]);
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1]));
    if (cells.length < 20) continue;               // data rows are wide (blocks*5)
    const nBlocks = Math.floor(cells.length / 5);
    for (let b = 0; b < nBlocks && b < blocks.length; b++) {
      const base = b * 5;
      const dateNum = parseInt(cells[base], 10);
      const weekday = cells[base + 1];
      const event = cells[base + 2] && cells[base + 2] !== '-' ? cells[base + 2] : '';
      const doRaw = (cells[base + 3] || '').trim();
      if (!dateNum || dateNum < 1 || dateNum > 31) continue;
      const blk = blocks[b];
      const iso = `${blk.yy}-${String(blk.mon + 1).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`;
      const dayOrder = /^[1-9]$/.test(doRaw) ? parseInt(doRaw, 10) : null;
      days[iso] = {
        date: iso,
        weekday,
        dayOrder,
        event: event || null,
        holiday: dayOrder === null,
      };
    }
  }

  return { pageName, months: blocks.map(b => `${b.yy}-${String(b.mon + 1).padStart(2, '0')}`), days };
}

// Choose the correct planner page name for a given date.
// ODD sem ≈ Jun–Dec, EVEN sem ≈ Jan–May. Academic year label is AY_start.
function plannerPageFor(date = new Date()) {
  const m = date.getMonth(); // 0..11
  const y = date.getFullYear();
  if (m >= 5) return `Academic_Planner_${y}_${String((y + 1) % 100).padStart(2, '0')}_ODD`;
  return `Academic_Planner_${y - 1}_${String(y % 100).padStart(2, '0')}_EVEN`;
}

module.exports = { parsePlanner, plannerPageFor };
