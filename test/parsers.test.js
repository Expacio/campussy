'use strict';
const fs = require('fs');
const path = require('path');
const { parseTimetable } = require('../src/parsers/timetable');
const { parseUnified } = require('../src/parsers/unified');
const { parsePlanner } = require('../src/parsers/planner');

const FIXDIR = path.join(__dirname, '..', 'fixtures');
// Fixtures are captured real SRM pages containing personal data — they are not
// committed to the repo. If absent, skip rather than fail.
if (!fs.existsSync(path.join(FIXDIR, 'timetable.html'))) {
  console.log('⚠ fixtures/ not present (they hold personal data and are gitignored).');
  console.log('  To run parser tests, drop captured page-embed HTML into fixtures/.');
  process.exit(0);
}
const fx = (f) => fs.readFileSync(path.join(FIXDIR, f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };

// --- Timetable ---
const tt = parseTimetable(fx('timetable.html'));
console.log('Timetable → student:', tt.student.name, '| reg:', tt.student.registrationNumber,
  '| sem:', tt.student.semester, '| courses:', tt.courses.length);
ok(tt.student.name, 'student name parsed');
ok(tt.courses.length >= 4, 'at least 4 courses');
ok(tt.courses.every(c => c.code && c.slot), 'every course has code + slot');
console.log('  sample:', tt.courses.slice(0, 3).map(c => `${c.code}[${c.slot}]`).join(', '));

// --- Unified grid ---
const uni = parseUnified(fx('unified.html'));
const dayOrders = Object.keys(uni.grid);
console.log('Unified → day-orders:', dayOrders.join(','), '| hours:', uni.hours.join(','));
ok(dayOrders.length >= 5, 'grid has >=5 day orders');
ok(uni.grid['1'] && Object.keys(uni.grid['1']).length, 'day 1 has hour->slot map');
console.log('  Day1:', JSON.stringify(uni.grid['1']));

// --- Planner ---
const pl = parsePlanner(fx('planner.html'), 'Academic_Planner_2026_27_ODD');
const dated = Object.values(pl.days);
const withDO = dated.filter(d => d.dayOrder);
console.log('Planner → months:', pl.months.join(','), '| dates:', dated.length, '| with day-order:', withDO.length);
ok(pl.months.length >= 5, 'planner detected months');
ok(withDO.length > 20, 'planner has many day-order dates');
const sample = pl.days['2026-08-19'] || withDO[0];
console.log('  sample 2026-08-19:', JSON.stringify(sample));

// --- Cross-link: today-style resolution ---
function classesFor(dayOrder) {
  const hourMap = uni.grid[String(dayOrder)] || {};
  const out = [];
  for (const [hour, slots] of Object.entries(hourMap)) {
    for (const s of slots) {
      const course = tt.courses.find(c => c.slots.includes(s));
      if (course) out.push({ hour: +hour, slot: s, code: course.code, title: course.title, room: course.room });
    }
  }
  return out.sort((a, b) => a.hour - b.hour);
}
const sampleDO = withDO[0].dayOrder;
const cls = classesFor(sampleDO);
console.log(`Cross-link → Day Order ${sampleDO} resolves ${cls.length} classes`);
ok(cls.length > 0, 'slot→course resolution works');
console.log('  ', cls.slice(0, 6).map(c => `H${c.hour}:${c.code}`).join('  '));

// Labs MUST resolve (the P9-P10 / P33-P34 / L51-L52 hyphenated slots).
const labCourses = tt.courses.filter(c => c.slots.some(s => /^[PL]\d/.test(s)));
ok(labCourses.length >= 3, 'lab courses have expanded P/L slots');
let labHits = 0;
for (let d = 1; d <= 5; d++) labHits += classesFor(d).filter(c => /^[PL]\d/.test(c.slot)).length;
ok(labHits >= 4, 'lab periods resolve across the week (was the main bug)');
console.log('  lab courses:', labCourses.map(c => c.code + '[' + c.slots.join(',') + ']').join(' '), '| lab periods placed:', labHits);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
