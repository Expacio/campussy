'use strict';
// Zoho Creator "page-embed" responses wrap the real page HTML inside one or more
// layers of JS string-escaping (document.write("...")). This decoder peels those
// layers, then hands clean HTML to the table parsers.

function unescapeOnce(s) {
  return s
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\-/g, '-')
    .replace(/\\\\/g, '\\');
}

// Peel until the escape markers stop shrinking (bounded to avoid loops).
function deepUnescape(s) {
  let prev = s;
  for (let i = 0; i < 8; i++) {
    const next = unescapeOnce(prev);
    if (next === prev) break;
    // stop if it stops containing escape markers
    if (!/\\x[0-9A-Fa-f]{2}|\\\/|\\n|\\\\/.test(next)) { prev = next; break; }
    prev = next;
  }
  return prev;
}

// Extract the largest coherent HTML region (the data table area) from a decoded blob.
function decodeEmbed(raw) {
  const decoded = deepUnescape(raw);
  return decoded;
}

module.exports = { decodeEmbed, deepUnescape, unescapeOnce };
