# 🎓 Campussy

A calm, unified dashboard for **SRM IST Chennai** students — timetable, day-orders,
attendance and internal marks in one place.

Campussy talks to the two systems SRM students already use:

- **Academia (Zoho Creator)** — `academia.srmist.edu.in` — timetable, the unified
  slot grid, and the academic-planner day-orders. Logged in automatically.
- **Student Portal** — `sp.srmist.edu.in` — internal marks & attendance. Logged in
  automatically too; the portal's image **captcha is shown to you to type** (a human
  solving their own captcha — no bypass), then your password is submitted to SRM.

Nothing is stored but a short-lived session. **No passwords are persisted.**

## What it does

- **Today / Week** — resolves the real day-order from the planner, then maps each
  hour's slot (from the batch's *Unified Time Table*) to your registered course,
  including **lab periods** (`P9-P10`, `L51-L52`, …) with the correct room and time.
- **Courses** — your registered courses with slots, faculty and rooms.
- **Calendar** — a month view of day-orders, holidays and events.
- **Attendance** — per-course %, with "can skip N" / "need N more" against the 75% rule.
- **Marks** — internal marks summary per course.

## How it works

| Concern | Approach |
|---|---|
| Academia login | Replicates the Zoho IAM flow (`lookup → password → redirect`), auto-clears the concurrent-session gate. |
| Academia data | `GET …/page-embed/<PageName>` → the response wraps HTML in layered JS/entity escaping, which `src/parsers/decode.js` peels. |
| Timetable | personal course→slot list × unified `(day-order, hour)→slot` grid × planner `date→day-order`, cross-linked in `src/service.js`. |
| Student Portal | `src/sp.js` opens a session, serves you the captcha, submits credentials, then fetches the marks/attendance report fragments. |
| Rate limits | SRM throttles hard, so responses are cached on disk (`src/store.js`) with stale-fallback; sessions reset every 6h. |
| Sessions | Carried in a signed (HMAC-SHA256) cookie, not server memory, so they survive Vercel's stateless serverless instances — including the gap while you read the Student-Portal captcha (`src/seal.js`). Only short-lived SRM/Zoho session cookies travel; never a password. Set `SESSION_SECRET` in the deployment env. |

## Run

```bash
npm install
npm start           # http://localhost:3000
```

Sign in with your Academia (Zoho) email + password. Optionally connect the Student
Portal from the **Marks & Attendance** tab.

## Deploying

**Host it on a persistent single-instance server — not serverless.** The Student-Portal
login is a two-step human-captcha flow (fetch the captcha, then submit), and SRM binds
that session to the **originating IP**. Serverless platforms (e.g. Vercel) egress from a
different IP on nearly every invocation, so the submit arrives from a different IP than
the captcha was issued to and SRM rejects it as a hijacked session — you get a spurious
*"Invalid credentials"*. (Academia login is unaffected because its whole handshake
happens inside one request, hence one IP.)

A single always-on instance handles both requests from one stable egress IP, so the
login works. The repo ships a **Render** blueprint (`render.yaml`, free tier,
single instance):

1. Push to GitHub, then on Render: **New → Blueprint** and pick this repo.
2. Render reads `render.yaml`, provisions the service, and auto-generates
   `SESSION_SECRET`. Done.

`npm start` already honours `$PORT`, so any persistent Node host (Render, Fly.io,
Railway, a plain VPS behind a reverse proxy) works the same way.

## Tests

```bash
npm test
```

Parser tests run against captured SRM fixtures. Those fixtures contain personal data,
so they are **not** committed (see `.gitignore`); the suite skips cleanly if they're
absent.

## Project layout

```
src/
  server.js          Express app + API
  academia.js        Zoho academia login + page fetch
  sp.js              Student Portal login (captcha) + report fetch
  service.js         caching + cross-linking (day-order → classes)
  store.js           disk cache (6h reset)
  seal.js            signed-cookie session sealing (serverless-safe)
  parsers/           decode.js, timetable.js, unified.js, planner.js, sp.js
public/              index.html, styles.css, app.js  (vanilla, no build step)
test/parsers.test.js
```

> Educational project for personal use with your own SRM account.
