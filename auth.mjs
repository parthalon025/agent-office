// Access rules of the office server (audit #27 H1, L4, M3). Two tokens and a launch code:
// - The agent token opens only the agent routes (/hook, /hook/*, /mcp/*). Sessions send it in x-office-token.
//   It is kept in .office-token in the office folder (hook.mjs and mcp.mjs read it) and reused across restarts.
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
import os from 'node:os';
import path from 'node:path';

export const LAUNCH_TTL_MS = 5 * 60 * 1000;
export const AGENT_TOKEN_RE = /^[0-9a-f]{48}$/;
/** On every response: no page may show the office in a frame (clickjacking, M3). */
export const SECURITY_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
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
  if (pathname === '/launch') return 'launch';
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
  if (group === 'launch') return req.method === 'POST' ? { ok: true, group } : deny(404, 'Not found');
  const given = h['x-office-token'];
  if (group === 'agent') return tokenEqual(given, site.agentToken) ? { ok: true, group } : deny(401, 'Unauthorized');
  const cookies = cookieValues(h.cookie, cookieName(site.port));
  let pass = tokenEqual(given, site.pageToken);
  for (const c of cookies) pass = tokenEqual(c, site.pageToken) || pass; // compare all, no early exit
  return pass ? { ok: true, group } : deny(401, NO_ACCESS);
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
 * The principals a limited file keeps next to the current user, as well-known SIDs (the same in every Windows
 * language): SYSTEM and the Administrators group. They can take ownership of any file and read it anyway, so to
 * deny them protects nothing, and it breaks backup and antivirus. Everyone else goes: Users, Authenticated Users,
 * Everyone, other accounts, the logon session.
 */
export const KEEP_SIDS = ['S-1-5-18', 'S-1-5-32-544'];

/**
 * icacls arguments that remove inherited entries and give full control to the current user, SYSTEM and
 * Administrators. /grant:r replaces only the grants of those three: other explicit entries stay (writeOwnerOnly
 * checks for them).
 */
export function ownerOnlyArgs(file, env = process.env) {
  const user = String(env.USERNAME || '').trim();
  if (!user) throw new Error('USERNAME is not set.');
  const domain = String(env.USERDOMAIN || '').trim();
  return [file, '/inheritance:r', '/grant:r', `${domain ? domain + '\\' : ''}${user}:F`, ...KEEP_SIDS.map((s) => `*${s}:F`)];
}

/**
 * The entries in icacls' list for one file (`icacls <file>`): one per line up to the first blank line, trimmed.
 * The first line also holds the path. The summary line after the blank line (in the language of Windows) is not
 * an entry.
 */
export function aclEntries(out) {
  const lines = String(out ?? '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const entries = [];
  for (; i < lines.length && lines[i].trim(); i++) entries.push(lines[i].trim());
  return entries;
}

/**
 * Writes a file that only the current user, SYSTEM and Administrators can read, and returns null, or a warning text
 * when the limit could not be set (the file is written anyway; best effort). Elsewhere: mode 0600.
 * deps: { fs, icacls(args) -> its output, platform, env }. On Windows, before the text goes in:
 * 1. Make the file if it is missing. A new file has the folder's inherited entries, or, in a folder with nothing to
 *    inherit, explicit entries from the process token's default DACL (a normal user: the user, SYSTEM and the logon
 *    session; an elevated administrator: SYSTEM and Administrators).
 * 2. icacls /inheritance:r /grant:r for the three. It removes inherited entries only, so 3. lists the file: more or
 *    fewer than three entries means an explicit entry is left (default DACL, an older office, set by hand).
 * 4. Only then: empty the file, icacls /reset (drops every explicit entry), and the limit of 2. again. Between /reset
 *    and the limit the file has the folder's inherited entries for a moment, so it must be empty. A file that was
 *    already limited never takes this path, so it never opens up and its text stays in place.
 * A later plain write keeps the ACL. Only a failed or missing icacls (or no USERNAME) is best effort. A bug in the
 * caller (a TypeError or ReferenceError, for example an import that is gone) is thrown, never turned into a warning.
 */
export function writeOwnerOnly(file, text, { fs, icacls, platform = process.platform, env = process.env }) {
  let warning = null;
  if (platform === 'win32') {
    fs.closeSync(fs.openSync(file, 'a')); // make it if missing; keep what is there until the limit is set
    try {
      const limit = ownerOnlyArgs(file, env);
      const kept = 1 + KEEP_SIDS.length;
      const others = () => aclEntries(icacls([file])).length !== kept;
      icacls(limit);
      if (others()) {
        fs.closeSync(fs.openSync(file, 'w'));
        icacls([file, '/reset']);
        icacls(limit);
        if (others()) throw new Error('other entries are still on it after icacls /reset');
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
