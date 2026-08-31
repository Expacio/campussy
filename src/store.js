'use strict';
// File-backed cache + session store. Two goals from the brief:
//   • reset academia session every 6 hours
//   • cache aggressively so we rarely hit SRM (they rate-limit hard)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On serverless (Vercel) the project dir is read-only; only /tmp is writable
// (and ephemeral — fine for a cache, it just re-fetches after a cold start).
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'campussy') : path.join(__dirname, '..', '.data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only FS; cache becomes in-memory only */ }

const SIX_HOURS = 6 * 60 * 60 * 1000;

// TTLs tuned to how often each dataset really changes vs. SRM's rate limits.
const TTL = {
  timetable: 24 * 60 * 60 * 1000,   // timetable changes rarely
  unified:   24 * 60 * 60 * 1000,
  planner:   24 * 60 * 60 * 1000,
  attendance: 3 * 60 * 60 * 1000,   // refreshed a few times a day
  marks:      3 * 60 * 60 * 1000,
};

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {});
  }, 250);
}

// In-memory academia sessions keyed by an opaque session id (never persisted).
const sessions = new Map(); // sid -> { academia, user, createdAt }

function newSid() { return crypto.randomBytes(24).toString('hex'); }

function putSession(sid, data) {
  sessions.set(sid, { ...data, createdAt: Date.now() });
}
function getSession(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SIX_HOURS) { sessions.delete(sid); return null; } // 6h reset
  return s;
}
function dropSession(sid) { sessions.delete(sid); }

// Cache is namespaced per user (registration number or email hash) so users never
// see each other's data.
function ckey(userKey, kind) { return `${userKey}::${kind}`; }

function getCache(userKey, kind) {
  const e = cache[ckey(userKey, kind)];
  if (!e) return null;
  const ttl = TTL[kind] || SIX_HOURS;
  if (Date.now() - e.at > ttl) return { stale: true, value: e.value, at: e.at };
  return { stale: false, value: e.value, at: e.at };
}
function setCache(userKey, kind, value) {
  cache[ckey(userKey, kind)] = { at: Date.now(), value };
  persist();
}
function clearUser(userKey) {
  for (const k of Object.keys(cache)) if (k.startsWith(userKey + '::')) delete cache[k];
  persist();
}

module.exports = {
  SIX_HOURS, TTL, newSid, putSession, getSession, dropSession,
  getCache, setCache, clearUser,
};
