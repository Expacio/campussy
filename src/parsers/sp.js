'use strict';
// Parsers for the SRM Student Portal (sp.srmist.edu.in) HRDSystem report fragments,
// fetched server-side after an automated login:
//   • studentAttendanceDetails.jsp  → Code | Description | Max.hours | Att.hours | Absent hours | Total Percentage
//   • studentInternalMarkDetails.jsp → Code | Description | Mark / Max. Mark

function txt(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function tableRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1])));
}
function tables(html) { return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]); }
function findTable(html, keywords) {
  return tables(html).find(t => { const low = t.toLowerCase(); return keywords.every(k => low.includes(k.toLowerCase())); });
}
function num(v) { if (v == null) return null; const m = String(v).match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; }
const isCode = (s) => /^\d{2}[A-Z]{2,4}\d{3}/.test(s || '');

// --- Attendance ---
function parseAttendance(html) {
  const table = findTable(html, ['code', 'percentage']) || findTable(html, ['code', 'absent']) ||
                findTable(html, ['att. hours']) || tables(html)[0];
  if (!table) return { courses: [] };
  const rows = tableRows(table).filter(r => r.length);
  const header = (rows[0] || []).map(h => h.toLowerCase());
  const find = (...ks) => header.findIndex(h => ks.some(k => h.includes(k)));
  const idx = {
    code: find('code'), title: find('description', 'title'),
    max: find('max. hour', 'max hour', 'conducted', 'total hour'),
    att: find('att. hour', 'attended', 'present hour'),
    abs: find('absent'), pct: find('percentage', '%'),
  };
  const courses = [];
  for (const r of rows.slice(1)) {
    const code = r[idx.code >= 0 ? idx.code : 0];
    if (!isCode(code)) continue;
    const conducted = num(r[idx.max]);
    let attended = num(r[idx.att]);
    const absent = num(r[idx.abs]);
    if (attended == null && conducted != null && absent != null) attended = conducted - absent;
    let percent = num((r[idx.pct] || '').replace('%', ''));
    if (percent == null && conducted) percent = +((attended / conducted) * 100).toFixed(2);
    // classes you can still miss and stay ≥75%, or must attend to reach it
    const canSkip = (conducted != null && attended != null) ? Math.floor(attended / 0.75 - conducted) : null;
    const needToAttend = (percent != null && percent < 75 && conducted != null && attended != null)
      ? Math.ceil((0.75 * conducted - attended) / 0.25) : 0;
    courses.push({
      code, title: idx.title >= 0 ? r[idx.title] : '',
      conducted, attended,
      absent: absent != null ? absent : (conducted != null && attended != null ? conducted - attended : null),
      percent,
      status: percent == null ? 'unknown' : percent >= 75 ? 'safe' : 'shortage',
      canSkip: canSkip != null && canSkip > 0 ? canSkip : 0,
      needToAttend,
    });
  }
  return { courses };
}

// --- Internal marks ---
function parseInternalMarks(html) {
  const table = findTable(html, ['code', 'mark']) || findTable(html, ['code', 'description']) || tables(html)[0];
  if (!table) return { courses: [] };
  const rows = tableRows(table).filter(r => r.length);
  const header = (rows[0] || []).map(h => h.toLowerCase());
  const codeIdx = Math.max(0, header.findIndex(h => h.includes('code')));
  const titleIdx = header.findIndex(h => h.includes('description') || h.includes('title'));
  const markIdx = header.findIndex(h => h.includes('mark'));
  const courses = [];
  for (const r of rows.slice(1)) {
    const code = r[codeIdx];
    if (!isCode(code)) continue;
    // mark cell looks like "4.20 / 5.00"
    const cell = markIdx >= 0 ? r[markIdx] : r.find(c => /\d+(\.\d+)?\s*\/\s*\d+/.test(c)) || '';
    const m = cell.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    const scored = m ? +m[1] : null, max = m ? +m[2] : null;
    courses.push({
      code, title: titleIdx >= 0 ? r[titleIdx] : '',
      totalScored: scored, totalMax: max,
      percent: (scored != null && max) ? +((scored / max) * 100).toFixed(1) : null,
      components: [], // per-test breakdown available via a separate detail call
    });
  }
  return { courses };
}

module.exports = { parseInternalMarks, parseAttendance };
