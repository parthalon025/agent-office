// Access rules of the office server (audit #27 H1, L4, M3). Two tokens and a launch code:
// - The agent token opens only the agent routes (/hook, /hook/*, /mcp/*). Sessions send it in x-office-token.
//   It is kept in the token file of the office's port in the office folder (.office-token on 4317, files.mjs has the
//   names; hook.mjs and mcp.mjs read it) and reused across restarts.
// - The page token opens only the page routes (/events, /api/*). It is new at each server start, kept in server
//   memory, and written to one file outside the office folder (pageFile) for the user's own command-line tools
//   (probe.mjs, test/smoke.mjs, a second npm start). Only the user, SYSTEM and Administrators can read that file
//   (writeOwnerOnly). The browser gets it as an HttpOnly cookie, never as text.
// - A launch code is the one-time key in the link the server opens (#n=<code>). The page trades it for the cookie
//   with POST /launch. A code works once, for LAUNCH_TTL_MS.
// Neither token opens the other group. Tokens never come from the URL. Every compare is constant-time.
// Pure: no I/O and no clock of its own (both injected), so the route matrix runs without a server
// (test/auth.test.mjs). writeOwnerOnly is the one helper that writes; it gets the file system and icacls injected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from './files.mjs';

export const LAUNCH_TTL_MS = 5 * 60 * 1000;
export const AGENT_TOKEN_RE = /^[0-9a-f]{48}$/;
/**
 * The content security policy of every response (audit #27 M2, M3):
 * - frame-ancestors 'none': no page may show the office in a frame (clickjacking).
 * - script-src 'self': scripts come only from this server (React is vendored in public/vendor). No inline script,
 *   no eval. The page and the DS bundle need neither.
 * - style-src 'self' and font-src 'self': style sheets and fonts come only from this server (the fonts are vendored
 *   too). React sets styles through the DOM, which a CSP allows.
 * - object-src 'none' and base-uri 'self': no plugins, and no <base> that sends relative links elsewhere.
 * Images stay open on purpose: an agent reply can show a remote image, but only after a click (DS RichText).
 */
export const CSP = "frame-ancestors 'none'; script-src 'self'; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'";
/** On every response. */
export const SECURITY_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': CSP };
export const NO_ACCESS = 'Open the office with its launch link. Run npm start to get a new link.';
export const LINK_DEAD = 'This launch link does not work. It was used, or it is more than 5 minutes old. Run npm start to get a new link.';

export const newAgentToken = () => crypto.randomBytes(24).toString('hex');
export const newPageToken = () => crypto.randomBytes(32).toString('hex');
const newCode = () => crypto.randomBytes(16).toString('hex');

/**
 * True when given equals want. Constant-time: both sides are hashed to 32 bytes first, so a wrong length takes the
 * same time and never throws. False for a missing or non-text value, and when want is empty.
 */
export function tokenEqual(given, want) {
  if (typeof given !== 'string' || typeof want !== 'string' || !want) return false;
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(h(given), h(want));
}

/** One-time launch codes: mint() gives a code, take(code) is true once for a live code. */
export function createLaunchCodes({ now = Date.now, ttl = LAUNCH_TTL_MS, max = 20, make = newCode } = {}) {
  const codes = new Map(); // code -> expiry time
  const prune = () => { const t = now(); for (const [c, exp] of codes) if (exp <= t) codes.delete(c); };
  return {
    mint() {
      prune();
      while (codes.size >= max) codes.delete(codes.keys().next().value); // the oldest goes first
      const c = make();
      codes.set(c, now() + ttl);
      return c;
    },
    take(code) {
      prune();
      let hit = null;
      for (const c of codes.keys()) if (tokenEqual(code, c)) hit = c; // no early exit: every live code is compared
      if (hit === null) return false;
      codes.delete(hit);
      return true;
    },
    get size() { prune(); return codes.size; },
  };
}

export const ownHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`];
export const ownOrigins = (port) => ownHosts(port).map((h) => `http://${h}`);
export const launchUrl = (port, code) => `http://127.0.0.1:${port}/#n=${code}`;
/** The page cookie. The port is in the name: cookies do not keep ports apart, so two offices on two ports keep two cookies. */
export const cookieName = (port) => `ao_${port}`;
/** HttpOnly: page scripts never see the token. SameSite=Strict: no other site sends it. No Max-Age: it ends with the browser. */
export const pageCookie = (port, token) => `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;

/** Every value of a cookie in a Cookie header (a name can come more than once). */
export function cookieValues(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** The route group of a request: 'public', 'launch', 'agent', 'page', or null (not a route: 404). */
export function routeOf(method, pathname, isStatic = () => false) {
  if (method === 'GET' && (pathname === '/' || pathname === '/favicon.ico' || isStatic(pathname))) return 'public';
  if (pathname === '/launch' || pathname === '/remote/signin') return 'launch';
  if (pathname === '/hook' || pathname.startsWith('/hook/') || pathname.startsWith('/mcp/')) return 'agent';
  if (pathname === '/events' || pathname.startsWith('/api/')) return 'page';
  return null;
}

const isJson = (type) => /^application\/json\s*(;|$)/i.test(String(type || '').trim());
const deny = (status, error) => ({ ok: false, status, error });

/**
 * Checks a request before any route runs. req: { method, path, headers } with lower-case header names, as Node
 * gives them. site: { port, agentToken, pageToken, isStatic(path) }. Returns { ok: true, group } or
 * { ok: false, status, error }. The order:
 * 1. Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding).
 * 2. An Origin header must be the office's own origin. No Origin (hooks, MCP, command-line tools) is fine.
 * 3. Token routes and /launch: Sec-Fetch-Site, when a browser sends it, must be same-origin or none. A page on
 *    another port of 127.0.0.1 is same-site, so SameSite alone would send it the cookie.
 * 4. A POST must say application/json: a form or a plain-text post from another page cannot.
 * 5. The token of the group: the agent token in x-office-token for agent routes; the page token in x-office-token
 *    or the page cookie for page routes. Never from the URL (?t= opens nothing).
 */
export function checkRequest(req, site) {
  const h = req.headers || {};
  if (!ownHosts(site.port).includes(h.host)) return deny(403, 'Forbidden');
  if (h.origin !== undefined && !ownOrigins(site.port).includes(h.origin)) return deny(403, 'Forbidden: the request comes from another site.');
  const group = routeOf(req.method, req.path, site.isStatic);
  if (!group) return deny(404, 'Not found');
  if (group === 'public') return { ok: true, group };
  const fetchSite = h['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return deny(403, 'Forbidden: the request comes from another site.');
  if (req.method === 'POST' && !isJson(h['content-type'])) return deny(415, 'Send JSON: the content type must be application/json.');
  // The launch code is the local page's key; /remote/signin gives the cookie for an Access login and only the remote gate serves it.
  if (group === 'launch') return req.method === 'POST' && req.path === '/launch' ? { ok: true, group } : deny(404, 'Not found');
  const given = h['x-office-token'];
  if (group === 'agent') return tokenEqual(given, site.agentToken) ? { ok: true, group } : deny(401, 'Unauthorized');
  const cookies = cookieValues(h.cookie, cookieName(site.port));
  let pass = tokenEqual(given, site.pageToken);
  for (const c of cookies) pass = tokenEqual(c, site.pageToken) || pass; // compare all, no early exit
  return pass ? { ok: true, group } : deny(401, NO_ACCESS);
}

// ---------- remote access (#133, ADR 0008) ----------
// The owner can open the office at an address such as office.kurat0r.ai through a Cloudflare Tunnel and a Cloudflare
// Access application. Access signs every request it lets through with an RS256 token (header Cf-Access-Jwt-Assertion).
// The office does not trust the tunnel: it checks that token itself on every request whose Host is the remote host,
// with node:crypto only, against the team's certificate list. Anything it cannot prove is refused (fail closed).
// The server still listens on 127.0.0.1 only. The agent routes never answer a remote request.
export const REMOTE_NAMES = ['OFFICE_REMOTE_HOST', 'OFFICE_REMOTE_TEAM', 'OFFICE_REMOTE_AUD', 'OFFICE_REMOTE_EMAILS'];
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const REMOTE_SIGNIN = '/remote/signin';
const HOSTNAME_RE = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@,*]+@[^\s@,*]+\.[^\s@,*]+$/;
const isIp = (h) => /^\d+(\.\d+){3}$/.test(h);
const TOKEN_MAX = 8192;
const CERTS_MAX = 262144;
export const CERTS_REFRESH_GAP_MS = 60 * 1000;
export const CERTS_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remote settings from the environment: OFFICE_REMOTE_HOST (the public host name), OFFICE_REMOTE_TEAM (the Access team
 * domain, <name>.cloudflareaccess.com), OFFICE_REMOTE_AUD (the application audience tag), OFFICE_REMOTE_EMAILS (the
 * allowed emails, comma separated). All four are needed. OFFICE_REMOTE_PORT (default 4317) is the one port that honors
 * them; a branch office never does. OFFICE_REMOTE_CERTS_URL is for tests: a loopback http address for the certificate list.
 * Returns { on: true, state: 'on', host, team, issuer, certsUrl, aud, emails, port }, or { on: false, state, missing, reason }:
 * state 'off' (not set up, or another port) or 'incomplete' (set up in part or wrong: the reason says what).
 */
export function remoteConfig(env = process.env, { port, branch = false } = {}) {
  const val = (n) => String(env[n] ?? '').trim();
  const off = (reason) => ({ on: false, state: 'off', missing: [], reason });
  const incomplete = (reason, missing = []) => ({ on: false, state: 'incomplete', missing, reason });
  const asked = REMOTE_NAMES.some((n) => val(n));
  let remotePort = DEFAULT_PORT;
  if (val('OFFICE_REMOTE_PORT')) {
    remotePort = /^\d{1,5}$/.test(val('OFFICE_REMOTE_PORT')) ? Number(val('OFFICE_REMOTE_PORT')) : 0;
    if (!(remotePort >= 1 && remotePort <= 65535)) return asked ? incomplete('OFFICE_REMOTE_PORT is not a port number.') : off('Remote access is not set up.');
  }
  if (!asked) return off('Remote access is not set up.');
  if (branch || port !== remotePort) return off(`Remote access is not used on port ${port}.`);
  const missing = REMOTE_NAMES.filter((n) => !val(n));
  if (missing.length) return incomplete(`missing ${missing.join(', ')}.`, missing);
  const host = val('OFFICE_REMOTE_HOST').toLowerCase(), team = val('OFFICE_REMOTE_TEAM').toLowerCase();
  if (!HOSTNAME_RE.test(host) || isIp(host)) return incomplete('OFFICE_REMOTE_HOST must be a host name such as office.example.com, with no port and no address.');
  if (!HOSTNAME_RE.test(team) || isIp(team)) return incomplete('OFFICE_REMOTE_TEAM must be the Access team domain, such as myteam.cloudflareaccess.com.');
  const aud = val('OFFICE_REMOTE_AUD');
  if (/\s/.test(aud)) return incomplete('OFFICE_REMOTE_AUD must be the application audience tag, with no spaces.');
  const emails = val('OFFICE_REMOTE_EMAILS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length || !emails.every((e) => EMAIL_RE.test(e))) return incomplete('OFFICE_REMOTE_EMAILS must list email addresses, separated by commas.');
  let certsUrl = `https://${team}/cdn-cgi/access/certs`;
  if (val('OFFICE_REMOTE_CERTS_URL')) {
    let u = null;
    try { u = new URL(val('OFFICE_REMOTE_CERTS_URL')); } catch { /* checked below */ }
    if (!u || u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return incomplete('OFFICE_REMOTE_CERTS_URL is only for tests and must be an http address on 127.0.0.1.');
    certsUrl = u.href;
  }
  return { on: true, state: 'on', host, team, issuer: `https://${team}`, certsUrl, aud, emails, port: remotePort };
}

/** What the info route says about remote access: the state and the address, never the audience tag or the emails. */
export const remoteInfo = (cfg) => ({ state: cfg.state, host: cfg.on ? cfg.host : undefined, missing: cfg.missing || [], reason: cfg.reason });

/** True when the Host header is the remote host (the one address Access serves). Exactly that name, no port, any case. */
export const isRemoteHost = (host, cfg) => !!cfg && cfg.on === true && typeof host === 'string' && host.toLowerCase() === cfg.host;

/** Reads the certificate list: https (or the loopback http of a test), status 200, at most 256 KB, JSON. Rejects on anything else. */
export function fetchCerts(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const get = u.protocol === 'https:' ? https.get : u.protocol === 'http:' && u.hostname === '127.0.0.1' ? http.get : null;
    if (!get) return reject(new Error('The certificate list must come over https.'));
    const req = get(u, { agent: false, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The certificate list answered ${res.statusCode}.`)); }
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > CERTS_MAX) { req.destroy(new Error('The certificate list is too large.')); return; } parts.push(c); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The certificate list timed out.')));
    req.on('error', reject);
  });
}

/** The RSA signing keys of a certificate list (its `keys`, as JWKs), by key id. Throws when there is none we can use. */
function parseKeys(doc) {
  const out = new Map();
  const list = doc && Array.isArray(doc.keys) ? doc.keys : [];
  for (const jwk of list) {
    try {
      if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid || out.has(jwk.kid)) continue;
      if ((jwk.use !== undefined && jwk.use !== 'sig') || (jwk.alg !== undefined && jwk.alg !== 'RS256')) continue;
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      if (key.asymmetricKeyType !== 'rsa' || !(key.asymmetricKeyDetails?.modulusLength >= 2048)) continue;
      out.set(jwk.kid, key);
    } catch { /* a key we cannot read is no key */ }
  }
  if (!out.size) throw new Error('The certificate list has no usable key.');
  return out;
}

/**
 * The team's signing keys, kept in memory. get(kid) gives the key or null. The list is read again when a key id is
 * unknown and the last try was a minute ago or more (so a flood of odd ids reads it once a minute), and when the cache is
 * an hour old. Each read replaces the list whole, so a key Cloudflare removed is gone after it. A read that fails keeps
 * the keys for now, but never past an hour: with no readable list, nothing passes. Reads at the same time share one fetch.
 */
export function createAccessKeys({ url, fetchJson = fetchCerts, now = Date.now, gapMs = CERTS_REFRESH_GAP_MS, maxAgeMs = CERTS_MAX_AGE_MS }) {
  let keys = new Map(), loadedAt = -Infinity, lastTry = -Infinity, inflight = null;
  const fresh = () => now() - loadedAt < maxAgeMs;
  function refresh() {
    lastTry = now();
    inflight = (async () => {
      try { keys = parseKeys(await fetchJson(url)); loadedAt = now(); } catch { /* keep what we have, for now */ } finally { inflight = null; }
    })();
    return inflight;
  }
  return {
    async get(kid) {
      if (fresh() && keys.has(kid)) return keys.get(kid);
      if (inflight) await inflight;
      else if (now() - lastTry >= gapMs) await refresh();
      return fresh() ? keys.get(kid) ?? null : null;
    },
  };
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const asObject = (b64) => { try { const v = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

/**
 * Checks an Access token: RS256 only, signed by a key of the team's list (by key id), the team issuer, the audience tag,
 * not expired (no allowance), not before now (a minute of clock drift), and an allowed email. Anything else, and any
 * error, is { ok: false, reason } (the reason is for logs and tests, never for the client). A good token gives
 * { ok: true, email, exp } with exp in seconds.
 */
export async function verifyAccessToken(token, cfg, keys, now = Date.now) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (typeof token !== 'string' || token.length > TOKEN_MAX) return fail('no token');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64URL_RE.test(p))) return fail('not a token');
    const head = asObject(parts[0]);
    if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string' || !head.kid) return fail('not an RS256 token with a key id');
    const key = await keys.get(head.kid);
    if (!key) return fail('unknown key');
    const sig = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, sig)) return fail('bad signature');
    const c = asObject(parts[1]);
    if (!c) return fail('no claims');
    const t = now() / 1000;
    if (c.iss !== cfg.issuer) return fail('wrong issuer');
    const auds = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) ? c.aud : [];
    if (!auds.includes(cfg.aud)) return fail('wrong audience');
    if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || !(c.exp > t)) return fail('expired');
    if (c.nbf !== undefined && (typeof c.nbf !== 'number' || !(c.nbf <= t + 60))) return fail('not yet valid');
    if (typeof c.email !== 'string' || !cfg.emails.includes(c.email.toLowerCase())) return fail('email not allowed');
    return { ok: true, email: c.email.toLowerCase(), exp: c.exp };
  } catch { return fail('error'); }
}

/**
 * The page cookie for a remote sign-in. Secure (the address is https), and it ends with the Access token: Max-Age and
 * Expires are the token's expiry. expSec is the token's exp (seconds), nowMs the clock.
 */
export function remoteCookie(port, token, expSec, nowMs) {
  const maxAge = Math.max(0, Math.floor(expSec - nowMs / 1000));
  return `${pageCookie(port, token)}; Secure; Max-Age=${maxAge}; Expires=${new Date(expSec * 1000).toUTCString()}`;
}

/**
 * The request gate for a request whose Host is the remote host (async: the keys may need a read). In order:
 * 1. A valid Access token in Cf-Access-Jwt-Assertion, for every route. No token, a bad one or an unreadable key list: 403.
 * 2. An Origin header must be https://<remote host>.
 * 3. The agent group (hooks, MCP, the OpenClaw gate) refuses every remote request: 403.
 * 4. As for a local request: Sec-Fetch-Site, JSON on a POST, then the route group. The launch code is not served here (404);
 *    POST /remote/signin is, and its answer carries { remote: { email, exp } } for the cookie. A page route needs the
 *    remote page cookie or token (site.remote.pageToken) as well and carries the same remote field.
 */
export async function checkRemoteRequest(req, site) {
  const h = req.headers || {}, cfg = site.remote.config;
  let who;
  try { who = await verifyAccessToken(h[ACCESS_HEADER], cfg, site.remote.keys, site.now || Date.now); } catch { who = { ok: false }; }
  if (!who.ok) return deny(403, 'Forbidden');
  if (h.origin !== undefined && h.origin !== `https://${cfg.host}`) return deny(403, 'Forbidden: the request comes from another site.');
  const group = routeOf(req.method, req.path, site.isStatic);
  if (!group) return deny(404, 'Not found');
  if (group === 'agent') return deny(403, 'Forbidden');
  if (group === 'public') return { ok: true, group };
  const fetchSite = h['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return deny(403, 'Forbidden: the request comes from another site.');
  if (req.method === 'POST' && !isJson(h['content-type'])) return deny(415, 'Send JSON: the content type must be application/json.');
  const remote = { email: who.email, exp: who.exp };
  if (group === 'launch') return req.method === 'POST' && req.path === REMOTE_SIGNIN ? { ok: true, group, remote } : deny(404, 'Not found');
  const cookies = cookieValues(h.cookie, cookieName(site.port));
  // The remote page token is its own secret (site.remote.pageToken), never the local page token: a remote cookie opens
  // nothing on the local host, and the local token opens nothing here.
  const want = site.remote.pageToken;
  let pass = tokenEqual(h['x-office-token'], want);
  for (const c of cookies) pass = tokenEqual(c, want) || pass;
  return pass ? { ok: true, group, remote } : deny(401, NO_ACCESS);
}

/** The gate the server uses: the remote gate for the remote host (when remote access is on), else the local gate. */
export function gateRequest(req, site) {
  const cfg = site.remote?.config;
  if (cfg?.on && isRemoteHost((req.headers || {}).host, cfg)) return checkRemoteRequest(req, site);
  return Promise.resolve(checkRequest(req, site));
}

/**
 * Where the page token is kept for the user's own tools: outside the office folder, so an agent working in the
 * office folder cannot read it with an in-folder Read. %LOCALAPPDATA%\AgentOffice on Windows, ~/.agent-office
 * elsewhere. The name matches the secret rule in risk.mjs, so a read of it by an agent is never low risk.
 */
export function pageFile(env = process.env, port = 4317, home = os.homedir()) {
  const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'AgentOffice') : path.join(home, '.agent-office');
  return path.join(base, `office-page-${Number(port) | 0}.json`);
}

/**
 * Page files of offices that are gone (#126). Nothing else owns the file's life, and `taskkill /F` runs no exit
 * handler, so an office sweeps once at start: every `office-page-<port>.json` next to `file` whose port has no
 * listener is removed. The own port, any other name, and a non-number port stay. A listener that is not an office
 * keeps its file (safe). Reads, probes and removes are injected; nothing throws. Returns the names removed.
 */
export async function stalePageFiles({ file, port, readdir, isListening, unlink }) {
  const dir = path.dirname(file);
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = /^office-page-(\d+)\.json$/.exec(name);
    const n = m ? Number(m[1]) : NaN;
    if (!m || !Number.isSafeInteger(n) || n < 1 || n > 65535 || n === (Number(port) | 0)) continue;
    try {
      if (await isListening(n)) continue;
      await unlink(path.join(dir, name));
      removed.push(name);
    } catch { /* one file that stays is not a failed start */ }
  }
  return removed;
}

/** Remove this office's own page file at exit, only while it still holds this process's token (a newer office on the port keeps its file). */
export function removeOwnPageFile(file, token, { readFile, unlink } = { readFile: (f) => fs.readFileSync(f, 'utf8'), unlink: (f) => fs.unlinkSync(f) }) {
  try {
    if (!tokenEqual(JSON.parse(readFile(file))?.token, token)) return false;
    unlink(file);
    return true;
  } catch { return false; }
}

/**
 * The principals a limited file keeps next to the current user, as well-known SIDs (the same in every Windows
 * language): SYSTEM and the Administrators group. They can take ownership of any file and read it anyway, so to
 * deny them protects nothing, and it breaks backup and antivirus. Everyone else goes: Users, Authenticated Users,
 * Everyone, other accounts, the logon session.
 */
export const KEEP_SIDS = ['S-1-5-18', 'S-1-5-32-544'];

/**
 * icacls arguments that remove inherited entries and give full control to the current user, SYSTEM and
 * Administrators. The user is userSid when it is known (from readAcl), else USERDOMAIN\USERNAME. /grant:r replaces
 * only the grants of those three: other explicit entries stay (writeOwnerOnly checks for them).
 */
export function ownerOnlyArgs(file, env = process.env, userSid = null) {
  let who = userSid ? `*${userSid}` : null;
  if (!who) {
    const user = String(env.USERNAME || '').trim();
    if (!user) throw new Error('USERNAME is not set.');
    const domain = String(env.USERDOMAIN || '').trim();
    who = `${domain ? domain + '\\' : ''}${user}`;
  }
  return [file, '/inheritance:r', '/grant:r', `${who}:F`, ...KEEP_SIDS.map((s) => `*${s}:F`)];
}

/**
 * Windows PowerShell script that prints the DACL of the file in env AO_ACL_FILE by SID, with .NET only: no account
 * names (they change with the language of Windows; SDDL even writes a RID-500 account as LA) and no module cmdlets.
 * Lines: `me|<SID of the process user>`, `dacl|<protected True/False>|<owner SID>`,
 * `ace|<SID>|<Allow/Deny>|<rights>|<inherited True/False>`. parseAcl reads them.
 */
export const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$S = [System.Security.Principal.SecurityIdentifier]',
  '$a = [System.IO.File]::GetAccessControl($env:AO_ACL_FILE)',
  "'me|' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "'dacl|' + $a.AreAccessRulesProtected + '|' + $a.GetOwner($S).Value",
  "foreach ($r in $a.GetAccessRules($true, $true, $S)) { 'ace|' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.FileSystemRights + '|' + $r.IsInherited }",
].join('\n');

/** ACL_SCRIPT output -> { me, protected, owner, aces: [{ sid, type, rights, inherited }] }. Throws on odd output. */
export function parseAcl(out) {
  const acl = { me: null, protected: null, owner: null, aces: [] };
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const p = line.trim().split('|');
    if (p[0] === 'me') acl.me = p[1];
    else if (p[0] === 'dacl') Object.assign(acl, { protected: p[1] === 'True', owner: p[2] });
    else if (p[0] === 'ace' && p.length === 5) acl.aces.push({ sid: p[1], type: p[2], rights: p[3], inherited: p[4] === 'True' });
  }
  if (!/^S-1-/.test(String(acl.me)) || acl.protected === null) throw new Error('could not read its permissions');
  return acl;
}

/**
 * What keeps a file from being limited, as short texts; [] when it is limited: inheritance off, the owner is the
 * user, SYSTEM or Administrators, and exactly one explicit allow entry with full control for each of the three.
 * Never a count alone: an entry list of the right length can still be inherited.
 */
export function aclProblems(acl) {
  const keep = new Set([acl.me, ...KEEP_SIDS]);
  const out = [];
  if (acl.protected !== true) out.push('inheritance is on');
  if (!keep.has(acl.owner)) out.push(`the owner is ${acl.owner}`);
  for (const a of acl.aces) {
    if (a.inherited) out.push(`inherited entry for ${a.sid}`);
    else if (!keep.has(a.sid) || a.type !== 'Allow') out.push(`${a.type} entry for ${a.sid}`);
    else if (a.rights !== 'FullControl') out.push(`${a.sid} has ${a.rights}`);
  }
  for (const s of keep) if (!acl.aces.some((a) => a.sid === s && a.type === 'Allow' && !a.inherited)) out.push(`no entry for ${s}`);
  if (!out.length && acl.aces.length !== keep.size) out.push(`${acl.aces.length} entries, not ${keep.size}`);
  return out;
}

/**
 * Writes a file that only the current user, SYSTEM and Administrators can read, and returns null, or a warning text
 * that names the file and what is wrong when the limit could not be set (the file is written anyway; best effort).
 * Elsewhere: mode 0600. deps: { fs, icacls(args), readAcl(file) -> parseAcl result, platform, env }.
 * On Windows, before the text goes in:
 * 1. Make the file if it is missing. A new file has the folder's inherited entries, or, in a folder with nothing to
 *    inherit, explicit entries from the process token's default DACL (a normal user: the user, SYSTEM and the logon
 *    session; an elevated administrator, as on GitHub's runner: SYSTEM, Administrators, sometimes OWNER RIGHTS).
 * 2. icacls /inheritance:r /grant:r for the three, then readAcl and aclProblems. /inheritance:r removes inherited
 *    entries only, so explicit ones can be left.
 * 3. If anything is wrong: /inheritance:d (inherited entries become explicit, inheritance off), /remove every SID
 *    that is not one of the three or has a deny entry, the limit again (the user by SID now), and check again.
 * No step gives anyone access they did not have, so the file is never emptied and never opens up (no /reset).
 * A later plain write keeps the ACL. Only a failed icacls or PowerShell (or no USERNAME) is best effort. A bug in
 * the caller (a TypeError or ReferenceError, for example an import that is gone) is thrown, never turned into a
 * warning.
 */
export function writeOwnerOnly(file, text, { fs, icacls, readAcl, platform = process.platform, env = process.env }) {
  let warning = null;
  if (platform === 'win32') {
    fs.closeSync(fs.openSync(file, 'a')); // make it if missing; keep what is there until the limit is set
    try {
      icacls(ownerOnlyArgs(file, env));
      let acl = readAcl(file);
      if (aclProblems(acl).length) {
        const keep = new Set([acl.me, ...KEEP_SIDS]);
        if (acl.protected !== true || acl.aces.some((a) => a.inherited)) icacls([file, '/inheritance:d']);
        const extra = [...new Set(acl.aces.filter((a) => !keep.has(a.sid) || a.type !== 'Allow').map((a) => a.sid))];
        if (extra.length) icacls([file, '/remove', ...extra.map((s) => `*${s}`)]);
        icacls(ownerOnlyArgs(file, env, acl.me));
        acl = readAcl(file);
        const left = aclProblems(acl);
        if (left.length) throw new Error(left.join('; '));
      }
    } catch (e) {
      if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) throw e;
      warning = `Could not limit ${file} to your Windows user (${String(e.stderr || e.message).trim().split(/\r?\n/)[0]}). Other users of this computer may read it.`;
    }
    fs.writeFileSync(file, text);
  } else {
    fs.writeFileSync(file, text, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) { warning = `Could not limit ${file} to your user (${e.message}).`; }
  }
  return warning;
}
