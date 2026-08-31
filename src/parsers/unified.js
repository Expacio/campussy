'use strict';
const { decodeEmbed } = require('./decode');

function txt(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/\\+/g, '').replace(/\s+/g, ' ').trim();
}

// Parse the Unified Time Table grid: rows = Day Order 1..N, columns = Hour 1..12,
// each cell holds the slot(s) active that hour, e.g. "A", "A / X", "P6".
// Returns { hours: [...], grid: { "1": { "1": ["A"], "2": ["A","X"], ... } } }
function parseUnified(raw) {
  const html = decodeEmbed(raw);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);

  // Header row: first cell mentions "Hour" / "Day Order", rest are hour numbers.
  let hours = null, headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = [...rows[i].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1]));
    if (cells.some(c => /day order/i.test(c))) {
      hours = cells.filter(c => /^\d{1,2}$/.test(c));
      headerIdx = i;
      break;
    }
  }

  const grid = {};
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = [...rows[i].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1]));
      if (!cells.length) continue;
      const label = cells[0];
      const m = label.match(/Day\s*(\d+)/i);
      if (!m) continue;
      const dayOrder = m[1];
      // Day rows carry 1–2 leading label cells (the label is repeated); the real
      // hour columns are the trailing `hours.length` cells.
      const hourCells = hours.length ? cells.slice(cells.length - hours.length) : cells.slice(1);
      const dayMap = {};
      hourCells.forEach((cell, hIdx) => {
        const hourNum = (hours && hours[hIdx]) || String(hIdx + 1);
        const slots = cell.split(/[\/,]/).map(s => s.trim().toUpperCase())
          .filter(s => s && s !== '-' && /^[A-Z]?P?\d*[A-Z]?$/i.test(s));
        if (slots.length) dayMap[hourNum] = slots;
      });
      if (Object.keys(dayMap).length) grid[dayOrder] = dayMap;
    }
  }

  // Also try to capture the hour time-ranges (e.g. "08:00-08:50") from the row above.
  const times = [];
  for (const r of rows.slice(0, headerIdx + 1)) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1]));
    for (const c of cells) {
      const mm = c.match(/\d{1,2}[:.]\d{2}\s*[-–toTO ]+\s*\d{1,2}[:.]\d{2}/);
      if (mm) times.push(mm[0].replace(/\s+/g, ' '));
    }
  }

  return { hours: hours || [], times, grid };
}

module.exports = { parseUnified };
