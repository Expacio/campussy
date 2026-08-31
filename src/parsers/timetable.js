'use strict';
const { decodeEmbed } = require('./decode');

// Collapse tags/whitespace inside a cell to plain text.
function txt(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// Parse the personal "My Time Table" embed → student info + course rows (with Slot).
// Columns: S.No, Course Code, Course Title, Credit, Regn.Type, Category,
//          Course Type, Faculty Name, Slot, GCR Code, Room No, Academic Year
function parseTimetable(raw) {
  const html = decodeEmbed(raw);

  // Student info sits in a labelled block; flatten to text and pull field-by-field.
  // e.g. "Registration Number: RA2511... Name: AKSHAY MISHRA Combo / Batch: 2/ 1
  //       Mobile: ... Program: B.Tech Department: CSE(SC)-(U1 Section) Semester: 3"
  const regPos = html.indexOf('Registration Number');
  const flat = regPos >= 0
    ? txt(html.slice(regPos, Math.min(regPos + 1200, html.indexOf('S.No', regPos) + 10 || regPos + 1200)))
    : txt(html.slice(0, 4000));
  const grab = (label, stop) => {
    const re = new RegExp(label + '\\s*:?\\s*(.*?)\\s*(?=' + stop + ')', 'i');
    const m = flat.match(re);
    return m ? m[1].replace(/&nbsp;/g, ' ').trim() : '';
  };
  const student = {
    registrationNumber: grab('Registration Number', 'Name\\s*:'),
    name: grab('Name', 'Combo|Batch|Mobile'),
    batch: grab('Batch', 'Mobile\\s*:'),
    mobile: grab('Mobile', 'Program\\s*:'),
    program: grab('Program', 'Department\\s*:'),
    department: grab('Department', 'Semester\\s*:'),
    semester: grab('Semester', 'Enrollment|Status|S\\.No|$').replace(/[^0-9].*$/, ''),
  };

  // The course table is malformed: header is a real <tr>, but data cells are bare
  // <td> sequences (no <tr> wrappers) and the GCR column is HTML-commented out.
  // Strategy: locate the header cells, then walk every following <td> in order,
  // starting a fresh record at each [S.No integer][course-code] boundary.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const hdrMatch = noComments.match(/<td[^>]*>\s*<strong>\s*S\.No[\s\S]*?Academic Year[\s\S]*?<\/td>/i);
  let headerCols = [];
  let after = noComments;
  if (hdrMatch) {
    headerCols = [...hdrMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1]).toLowerCase());
    after = noComments.slice(noComments.indexOf(hdrMatch[0]) + hdrMatch[0].length);
  }
  // Column order actually present (GCR removed): S.No, Course Code, Course Title,
  // Credit, Regn.Type, Category, Course Type, Faculty Name, Slot, Room No, Academic Year
  const order = ['sno', 'code', 'title', 'credit', 'regnType', 'category', 'courseType', 'faculty', 'slot', 'room', 'academicYear'];
  const NCOL = order.length;

  const cells = [...after.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1]));
  const courses = [];
  const seenCodes = new Set();
  for (let i = 0; i < cells.length - 1; i++) {
    // boundary: integer S.No followed by a course code
    if (/^\d{1,3}$/.test(cells[i]) && /^\d{2}[A-Z]{2,4}\d{3}/.test(cells[i + 1] || '')) {
      const rec = cells.slice(i, i + NCOL);
      if (rec.length < 9) continue;
      const o = {};
      order.forEach((k, j) => { o[k] = rec[j] || ''; });
      const dedupeKey = o.code + '|' + o.slot;
      if (seenCodes.has(dedupeKey)) { i += NCOL - 1; continue; } // ignore print-copy duplicate
      seenCodes.add(dedupeKey);
      const slotRaw = o.slot.trim();
      // Slots can be a single theory letter ("A"), a shared pair ("A / X"), or a
      // hyphenated lab-period range ("P9-P10-", "L51-L52-", "P47-"). Expand ALL of
      // these to individual grid tokens so lab periods resolve too.
      const slots = slotRaw.split(/[\/,\-]/).map(s => s.trim().toUpperCase()).filter(Boolean);
      // Flag as a lab session only when this entry occupies P/L lab periods. A
      // "Lab Based Theory" course also has a plain theory-letter row, which is a
      // normal lecture — not a lab.
      const isLab = slots.some(s => /^[PL]\d/i.test(s));
      courses.push({
        sno: o.sno, code: o.code, title: o.title, credit: o.credit,
        regnType: o.regnType, category: o.category, courseType: o.courseType,
        faculty: o.faculty.trim(),
        slot: slotRaw,
        slots,
        room: o.room, academicYear: o.academicYear,
        isLab,
      });
      i += NCOL - 1;
    }
  }
  return { student, courses };
}

module.exports = { parseTimetable };
