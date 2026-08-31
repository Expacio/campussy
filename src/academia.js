'use strict';
// Academia (Zoho Creator) client — replicates the browser login flow discovered
// during study: signin cookie → lookup → password → redirect. No anti-bot layer.
const https = require('https');
const { URL } = require('url');

const ORIGIN = 'https://academia.srmist.edu.in';
const CLIENT = '10002227248';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SERVICE_URL = 'https://academia.srmist.edu.in/portal/academia-academic-services';

// --- tiny cookie jar ---
class Jar {
  constructor() { this.c = new Map(); }
  setFrom(headers) {
    const sc = headers['set-cookie'] || [];
    for (const line of sc) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.c.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() { return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(k) { return this.c.get(k); }
}

function request(method, urlStr, { jar, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        ...(jar ? { 'Cookie': jar.header() } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      if (jar) jar.setFrom(res.headers);
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('academia request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// Log in and return a session (cookie jar + timestamp). Throws on bad credentials.
async function login(email, password) {
  const jar = new Jar();
  const signinUrl = `${ORIGIN}/accounts/p/${CLIENT}/signin?hide_fp=true&orgtype=40&service_language=en&dcc=true`;
  await request('GET', signinUrl, { jar });
  const csrf = jar.get('iamcsr');
  if (!csrf) throw new Error('Could not initialise academia session (no CSRF).');
  const common = {
    jar,
    headers: {
      'X-ZCSRF-TOKEN': `iamcsrcoo=${csrf}`,
      'Origin': ORIGIN,
      'Referer': signinUrl,
    },
  };
  const su = encodeURIComponent(SERVICE_URL);
  const now = Date.now();

  // 1) lookup
  const lookup = await request(
    'POST',
    `${ORIGIN}/accounts/p/${CLIENT}/signin/v2/lookup/${encodeURIComponent(email)}`,
    { ...common, headers: { ...common.headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `mode=primary&cli_time=${now}&servicename=ZohoCreator&serviceurl=${su}` }
  );
  let lj;
  try { lj = JSON.parse(lookup.body); } catch { throw new Error('Academia lookup failed.'); }
  if (!lj.lookup || !lj.lookup.identifier) {
    throw new Error(lj.localized_message || 'Academia account not found. Check the email.');
  }
  const { identifier, digest } = lj.lookup;

  // 2) password
  const pw = await request(
    'POST',
    `${ORIGIN}/accounts/p/${CLIENT}/signin/v2/primary/${identifier}/password?digest=${digest}&cli_time=${Date.now()}&servicename=ZohoCreator&serviceurl=${su}`,
    { ...common, headers: { ...common.headers, 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ passwordauth: { password } }) }
  );
  let pj;
  try { pj = JSON.parse(pw.body); } catch { throw new Error('Academia password step failed.'); }
  if (!pj.passwordauth || !pj.passwordauth.redirect_uri) {
    throw new Error(pj.localized_message || pj.message || 'Invalid academia password.');
  }

  // 3) clear any concurrent-session interstitial, then follow redirect to set app cookies
  let redirect = pj.passwordauth.redirect_uri;
  if (/block-sessions/.test(redirect)) {
    const base = redirect.match(/\/accounts\/p\/[^/]+/)[0];
    await request('DELETE', `${ORIGIN}${base}/webclient/v1/announcement/pre/blocksessions`, {
      ...common, headers: { ...common.headers, 'X-ZCSRF-TOKEN': `iamcsrcoo=${jar.get('iamcsr')}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    });
    redirect = SERVICE_URL;
  }
  await request('GET', redirect, { jar });
  await request('GET', SERVICE_URL, { jar });

  if (!jar.get('_z_identity') && !jar.get('_iamadt') && !jar.get('_iambdt')) {
    // Some tenants use a different session cookie name; verify by fetching a page.
    const probe = await fetchPage(jar, 'My_Time_Table_2023_24');
    if (!/Time Table/i.test(probe)) throw new Error('Academia session not established after login.');
  }
  return { jar, createdAt: now, email };
}

// Fetch a rendered page-embed by Creator page link name.
async function fetchPage(jar, pageName) {
  const url = `${ORIGIN}/srm_university/academia-academic-services/page-embed/${pageName}`;
  const res = await request('GET', url, { jar, headers: { 'Referer': SERVICE_URL } });
  if (res.status !== 200) throw new Error(`Academia page ${pageName} returned ${res.status}`);
  return res.body;
}

module.exports = { login, fetchPage };
