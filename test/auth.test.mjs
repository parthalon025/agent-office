// Access rules (audit #27 H1, L4, M3): two tokens, the one-time launch code, request checks, owner-only files.
// Unit tests run auth.mjs alone. The route matrix also runs against a real server: a copy of the office in a temp
// folder, on a free port, with its own LOCALAPPDATA, so it never touches this folder's .office-token or a running
// office. Offline: no claude on PATH for that server, no browser (OFFICE_OPEN=0), no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from '../auth.mjs';
import { resolveExe } from '../git.mjs';
import { officeFiles } from '../files.mjs';
import { startOffice, startOnFreePort } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- tokens and launch codes ----------

test('tokenEqual: equal text only, any length, never throws, and uses crypto.timingSafeEqual', () => {
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls++; return real(a, b); };
  try {
    const t = auth.newPageToken();
    assert.equal(auth.tokenEqual(t, t), true);
    assert.equal(auth.tokenEqual(t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), t), false);
    assert.equal(auth.tokenEqual(t.slice(0, 10), t), false, 'shorter');
    assert.equal(auth.tokenEqual(t + 'aa', t), false, 'longer');
    assert.equal(auth.tokenEqual('', t), false);
    assert.ok(calls >= 4, 'every compare goes through timingSafeEqual');
    for (const bad of [undefined, null, 42, ['x'], { t }]) assert.equal(auth.tokenEqual(bad, t), false, String(bad));
    assert.equal(auth.tokenEqual('', ''), false, 'an empty token opens nothing');
    assert.equal(auth.tokenEqual('x', undefined), false);
  } finally { crypto.timingSafeEqual = real; }
  assert.match(auth.newAgentToken(), auth.AGENT_TOKEN_RE);
  assert.match(auth.newPageToken(), /^[0-9a-f]{64}$/);
  assert.notEqual(auth.newPageToken(), auth.newPageToken());
});

test('launch codes work once, expire after the time to live, and refuse wrong or odd values', () => {
  let t = 1000;
  const codes = auth.createLaunchCodes({ now: () => t, ttl: 60000 });
  const a = codes.mint(), b = codes.mint();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(codes.take('0'.repeat(32)), false, 'a wrong code');
  for (const bad of [undefined, null, 7, { a }, [a]]) assert.equal(codes.take(bad), false, String(bad));
  assert.equal(codes.take(a.toUpperCase()), false, 'case matters');
  assert.equal(codes.take(a), true);
  assert.equal(codes.take(a), false, 'single use');
  t += 59999;
  assert.equal(codes.size, 1);
  t += 1; // exactly the time to live: gone
  assert.equal(codes.take(b), false, 'expired');
  assert.equal(codes.size, 0);
});

test('launch codes keep at most max live codes, the oldest goes first', () => {
  let n = 0;
  const codes = auth.createLaunchCodes({ now: () => 0, max: 3, make: () => 'c' + (n++) });
  const list = [codes.mint(), codes.mint(), codes.mint(), codes.mint()];
  assert.equal(codes.size, 3);
  assert.equal(codes.take(list[0]), false);
  assert.equal(codes.take(list[3]), true);
});

test('the launch link carries the code in the fragment, in the form the page reads', () => {
  const code = auth.createLaunchCodes().mint();
  const link = auth.launchUrl(4317, code);
  assert.equal(link, `http://127.0.0.1:4317/#n=${code}`);
  // public/adapter.js reads the code with this pattern and removes it from the address bar.
  assert.ok(read('public/adapter.js').includes('/^#n=([0-9a-f]{32})$/'));
  assert.match(new URL(link).hash, /^#n=([0-9a-f]{32})$/);
});

// ---------- route groups and request checks ----------

const AG = auth.newAgentToken(), PG = auth.newPageToken(), PORT = 4999;
const site = { port: PORT, agentToken: AG, pageToken: PG, isStatic: (p) => p === '/adapter.js' };
const H = (more = {}) => ({ host: `127.0.0.1:${PORT}`, ...more });
const J = (more = {}) => H({ 'content-type': 'application/json', ...more });
const check = (method, p, headers) => auth.checkRequest({ method, path: p, headers }, site);

test('routeOf sorts every route into one group', () => {
  const want = {
    'GET /': 'public', 'GET /favicon.ico': 'public', 'GET /adapter.js': 'public', 'POST /': null, 'POST /adapter.js': null,
    'POST /launch': 'launch', 'GET /launch': 'launch',
    'POST /hook': 'agent', 'POST /hook/http': 'agent', 'POST /hook/permission': 'agent',
    'POST /mcp/inbox': 'agent', 'POST /mcp/ask': 'agent', 'POST /mcp/room': 'agent', 'POST /mcp/room/update': 'agent',
    'GET /events': 'page', 'GET /api/info': 'page', 'GET /api/choices': 'page', 'GET /api/auth': 'page',
    'POST /api/answer': 'page', 'POST /api/startup': 'page', 'POST /api/ext': 'page', 'POST /api/launch-link': 'page', 'POST /api/probe-http': 'page',
    'GET /hookx': null, 'GET /mcp': null, 'GET /apix': null, 'GET /eventsx': null, 'GET /.office-token': null,
  };
  for (const [k, g] of Object.entries(want)) {
    const [m, p] = k.split(' ');
    assert.equal(auth.routeOf(m, p, site.isStatic), g, k);
  }
});

test('each token opens its own group only', () => {
  assert.deepEqual(check('POST', '/hook', J({ 'x-office-token': AG })), { ok: true, group: 'agent' });
  assert.deepEqual(check('POST', '/mcp/ask', J({ 'x-office-token': AG })), { ok: true, group: 'agent' });
  assert.deepEqual(check('POST', '/api/answer', J({ 'x-office-token': PG })), { ok: true, group: 'page' });
  assert.deepEqual(check('GET', '/events', H({ cookie: `x=1; ${auth.cookieName(PORT)}=${PG}` })), { ok: true, group: 'page' });
  const no = (r, status) => { assert.equal(r.ok, false); assert.equal(r.status, status); };
  for (const p of ['/hook', '/hook/http', '/hook/permission', '/mcp/inbox', '/mcp/room/update']) {
    no(check('POST', p, J()), 401);
    no(check('POST', p, J({ 'x-office-token': PG })), 401);
    no(check('POST', p, J({ cookie: `${auth.cookieName(PORT)}=${PG}` })), 401);
  }
  for (const [m, p] of [['GET', '/events'], ['GET', '/api/info'], ['POST', '/api/answer'], ['POST', '/api/startup'], ['POST', '/api/ext']]) {
    no(check(m, p, m === 'POST' ? J() : H()), 401);
    no(check(m, p, m === 'POST' ? J({ 'x-office-token': AG }) : H({ 'x-office-token': AG })), 401);
    no(check(m, p, H({ cookie: `${auth.cookieName(PORT)}=${AG}`, ...(m === 'POST' ? { 'content-type': 'application/json' } : {}) })), 401);
  }
  // The cookie of an office on another port opens nothing here.
  no(check('GET', '/events', H({ cookie: `${auth.cookieName(PORT + 1)}=${PG}` })), 401);
  assert.equal(check('GET', '/api/info', H()).error, auth.NO_ACCESS);
});

test('Host, Origin, Sec-Fetch-Site and content type are checked before the token', () => {
  const ok = J({ 'x-office-token': PG });
  assert.equal(check('POST', '/api/answer', { ...ok, host: 'evil.example' }).status, 403);
  assert.equal(check('GET', '/', { host: `127.0.0.1:${PORT + 1}` }).status, 403);
  assert.equal(check('GET', '/', { host: `localhost:${PORT}` }).ok, true);
  for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) assert.equal(check('POST', '/api/answer', { ...ok, origin }).ok, true, origin);
  for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${PORT + 1}`, `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}/`, '']) {
    assert.equal(check('POST', '/api/answer', { ...ok, origin }).status, 403, origin);
    assert.equal(check('POST', '/hook', J({ 'x-office-token': AG, origin })).status, 403, 'agent ' + origin);
  }
  for (const s of ['same-origin', 'none']) assert.equal(check('POST', '/api/answer', { ...ok, 'sec-fetch-site': s }).ok, true, s);
  for (const s of ['same-site', 'cross-site']) {
    assert.equal(check('POST', '/api/answer', { ...ok, 'sec-fetch-site': s }).status, 403, s);
    assert.equal(check('GET', '/events', H({ cookie: `${auth.cookieName(PORT)}=${PG}`, 'sec-fetch-site': s })).status, 403, 'events ' + s);
    assert.equal(check('POST', '/launch', J({ 'sec-fetch-site': s })).status, 403, 'launch ' + s);
  }
  assert.equal(check('GET', '/', H({ 'sec-fetch-site': 'cross-site' })).ok, true, 'a link from another site may open the page');
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
    assert.equal(check('POST', '/api/answer', { ...ok, 'content-type': type }).status, 415, String(type));
    assert.equal(check('POST', '/hook', H({ 'x-office-token': AG, 'content-type': type })).status, 415, 'hook ' + type);
  }
  assert.equal(check('POST', '/api/answer', { ...ok, 'content-type': 'application/json; charset=utf-8' }).ok, true);
  assert.equal(check('GET', '/launch', H()).status, 404);
  assert.deepEqual(check('POST', '/launch', J()), { ok: true, group: 'launch' });
  assert.equal(check('GET', '/nothing', H()).status, 404);
});

test('no Origin header and no Sec-Fetch-Site is fine on every group: Claude Code hooks, hook.mjs, mcp.mjs and command-line tools send none', () => {
  const plain = (more) => ({ host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...more });
  for (const p of ['/hook', '/hook/http', '/hook/permission', '/mcp/inbox', '/mcp/ask', '/mcp/room', '/mcp/room/update']) {
    const h = plain({ 'x-office-token': AG });
    assert.equal('origin' in h || 'sec-fetch-site' in h, false);
    assert.deepEqual(check('POST', p, h), { ok: true, group: 'agent' }, p);
  }
  for (const p of ['/api/answer', '/api/open', '/api/history', '/api/probe-http', '/api/launch-link']) assert.deepEqual(check('POST', p, plain({ 'x-office-token': PG })), { ok: true, group: 'page' }, p);
  assert.deepEqual(check('GET', '/events', { host: `127.0.0.1:${PORT}`, 'x-office-token': PG }), { ok: true, group: 'page' });
  assert.deepEqual(check('POST', '/launch', plain({})), { ok: true, group: 'launch' });
  assert.deepEqual(check('GET', '/', { host: `localhost:${PORT}` }), { ok: true, group: 'public' });
});

test('cookies: the page cookie is HttpOnly, SameSite=Strict, for the whole site; values are read by exact name', () => {
  const c = auth.pageCookie(PORT, PG);
  assert.equal(c, `ao_${PORT}=${PG}; Path=/; HttpOnly; SameSite=Strict`);
  assert.doesNotMatch(c, /Max-Age|Expires|Domain/i);
  assert.deepEqual(auth.cookieValues(`a=1; ao_${PORT}=x; xao_${PORT}=y;ao_${PORT}=z`, `ao_${PORT}`), ['x', 'z']);
  assert.deepEqual(auth.cookieValues(undefined, 'a'), []);
  assert.deepEqual(Object.keys(auth.SECURITY_HEADERS).sort(), ['content-security-policy', 'x-frame-options']);
  assert.equal(auth.SECURITY_HEADERS['x-frame-options'], 'DENY');
  assert.equal(auth.SECURITY_HEADERS['content-security-policy'], auth.CSP);
});

test('CSP (M2, M3): no frames, scripts, style sheets and fonts from this server only, no plugins, no <base>; never unsafe-*', () => {
  const dirs = Object.fromEntries(auth.CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.deepEqual(dirs, {
    'frame-ancestors': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'font-src': "'self'", 'object-src': "'none'", 'base-uri': "'self'",
  });
  assert.doesNotMatch(auth.CSP, /unsafe|\*|https?:|data:|nonce-|sha\d+-/, 'no loophole: the page needs no inline code, eval or other site');
});

// ---------- files ----------

test('pageFile is outside the office folder: LOCALAPPDATA, else the home folder', () => {
  assert.equal(auth.pageFile({ LOCALAPPDATA: 'C:\\L' }, 4317), path.join('C:\\L', 'AgentOffice', 'office-page-4317.json'));
  assert.equal(auth.pageFile({}, 5000, '/home/u'), path.join('/home/u', '.agent-office', 'office-page-5000.json'));
  assert.equal(path.basename(auth.pageFile({}, '4317x', '/h')), 'office-page-0.json', 'a port is a number');
});

// Well-known SIDs: the same in every Windows language.
const SYSTEM = 'S-1-5-18', ADMINS = 'S-1-5-32-544', USERS = 'S-1-5-32-545', AUTH_USERS = 'S-1-5-11', EVERYONE = 'S-1-1-0', ANONYMOUS = 'S-1-5-7';

test('ownerOnlyArgs: no inherited entries; full control for the user, SYSTEM and Administrators, by SID', () => {
  assert.deepEqual(auth.KEEP_SIDS, [SYSTEM, ADMINS]);
  assert.deepEqual(auth.ownerOnlyArgs('C:\\x\\f.json', { USERNAME: 'ann', USERDOMAIN: 'PC1' }), ['C:\\x\\f.json', '/inheritance:r', '/grant:r', 'PC1\\ann:F', '*S-1-5-18:F', '*S-1-5-32-544:F']);
  assert.deepEqual(auth.ownerOnlyArgs('f', { USERNAME: 'ann' }), ['f', '/inheritance:r', '/grant:r', 'ann:F', '*S-1-5-18:F', '*S-1-5-32-544:F']);
  assert.throws(() => auth.ownerOnlyArgs('f', {}), /USERNAME/);
  // With the user's SID (from readAcl) the name is not needed.
  assert.deepEqual(auth.ownerOnlyArgs('f', {}, 'S-1-5-21-1-2-3-500'), ['f', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-500:F', '*S-1-5-18:F', '*S-1-5-32-544:F']);
});

const ME = 'S-1-5-21-1-2-3-1001', LOGON = 'S-1-5-5-0-77', OWNER_RIGHTS = 'S-1-3-4', OTHER = 'S-1-5-21-1-2-3-1002';
const ace = (sid, more = {}) => ({ sid, type: 'Allow', rights: 'FullControl', inherited: false, ...more });
const LIMITED = { me: ME, protected: true, owner: ME, aces: [ace(ME), ace(SYSTEM), ace(ADMINS)] };

test('parseAcl reads the lines of ACL_SCRIPT; odd output throws', () => {
  // The shape of real output (an elevated administrator's new file, as on GitHub's runner).
  const out = ['me|S-1-5-21-9-9-9-500', 'dacl|False|S-1-5-32-544', 'ace|S-1-5-18|Allow|FullControl|False', 'ace|S-1-5-5-0-77|Allow|ReadAndExecute, Synchronize|True', ''].join('\r\n');
  assert.deepEqual(auth.parseAcl(out), { me: 'S-1-5-21-9-9-9-500', protected: false, owner: 'S-1-5-32-544',
    aces: [ace(SYSTEM), ace(LOGON, { rights: 'ReadAndExecute, Synchronize', inherited: true })] });
  for (const odd of ['', undefined, 'me|S-1-5-21-1\r\n', 'dacl|True|S-1-5-18', 'Get-Acl : error']) assert.throws(() => auth.parseAcl(odd), /could not read its permissions/, String(odd));
  assert.match(auth.ACL_SCRIPT, /AreAccessRulesProtected/);
  assert.match(auth.ACL_SCRIPT, /IsInherited/);
  assert.doesNotMatch(auth.ACL_SCRIPT, /Get-Acl|"/, 'no module cmdlet; no double quote (it goes through the Windows command line)');
});

test('aclProblems: limited means inheritance off, the right owner, and one explicit full allow for each of the three', () => {
  assert.deepEqual(auth.aclProblems(LIMITED), []);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, owner: ADMINS }), [], 'an elevated administrator: Administrators own the file');
  // GitHub's runner, file left as it was made: the count is right (3), but every entry is inherited. Never limited.
  const inherited = { me: ME, protected: false, owner: ADMINS, aces: [ace(SYSTEM, { inherited: true }), ace(ADMINS, { inherited: true }), ace(ME, { inherited: true })] };
  assert.deepEqual(auth.aclProblems(inherited), ['inheritance is on', `inherited entry for ${SYSTEM}`, `inherited entry for ${ADMINS}`, `inherited entry for ${ME}`,
    `no entry for ${ME}`, `no entry for ${SYSTEM}`, `no entry for ${ADMINS}`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, protected: false }), ['inheritance is on'], 'right entries, inheritance on');
  assert.deepEqual(auth.aclProblems({ ...LIMITED, owner: OTHER }), [`the owner is ${OTHER}`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, aces: [...LIMITED.aces, ace(USERS, { rights: 'Read' })] }), [`Allow entry for ${USERS}`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, aces: [...LIMITED.aces, ace(SYSTEM, { type: 'Deny', rights: 'Write' })] }), [`Deny entry for ${SYSTEM}`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, aces: [ace(ME), ace(SYSTEM, { rights: 'Read' }), ace(ADMINS)] }), [`${SYSTEM} has Read`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, aces: [ace(ME), ace(SYSTEM)] }), [`no entry for ${ADMINS}`]);
  assert.deepEqual(auth.aclProblems({ ...LIMITED, aces: [...LIMITED.aces, ace(ME)] }), ['4 entries, not 3'], 'a duplicate');
  assert.deepEqual(auth.aclProblems({ me: SYSTEM, protected: true, owner: SYSTEM, aces: [ace(SYSTEM), ace(ADMINS)] }), [], 'run as SYSTEM: two entries');
});

/** What `icacls <file>` prints: the path and the first entry, the other entries under it, a blank line, a summary. */
const listing = (file, entries) => [`${file} ${entries[0]}`, ...entries.slice(1).map((e) => ' '.repeat(file.length + 1) + e), '', 'Successfully processed 1 files; Failed processing 0 files', ''].join('\r\n');
const NAME_OF = { [ME]: 'PC1\\ann', [SYSTEM]: 'NT AUTHORITY\\SYSTEM', [ADMINS]: 'BUILTIN\\Administrators', [USERS]: 'BUILTIN\\Users' };

/**
 * One file's ACL and the icacls verbs the writer uses, so every path runs without Windows. broken: verbs that exit 0
 * but change nothing ('/inheritance:r', '/inheritance:d', '/grant:r', '/remove', '/reset', or 'all'). PC1\ann is ME.
 * `icacls <file>` prints the list (with (I) on inherited entries), so the writer of fb2eced runs on it too.
 */
function fakeWin({ aces, protect = false, owner = ME, broken = [] }) {
  const st = { protected: protect, owner, aces: aces.map((a) => ({ ...a })) };
  const log = [];
  const off = (v) => broken.includes('all') || broken.includes(v);
  const icacls = (a) => {
    const [file, ...rest] = a;
    log.push(['icacls', rest.join(' ')]);
    if (!rest.length) return Buffer.from(listing(file, st.aces.map((x) => `${NAME_OF[x.sid] || x.sid}:${x.inherited ? '(I)' : ''}${x.type === 'Deny' ? '(DENY)' : ''}(${x.rights === 'FullControl' ? 'F' : 'R'})`)));
    for (let i = 0; i < rest.length; i++) {
      const v = rest[i];
      const args = [];
      while (i + 1 < rest.length && !rest[i + 1].startsWith('/')) args.push(rest[++i]);
      if (off(v)) continue;
      const sidOf = (g) => { const who = g.replace(/:F$/, ''); return who.startsWith('*') ? who.slice(1) : { 'PC1\\ann': ME }[who]; };
      if (v === '/inheritance:r') { st.protected = true; st.aces = st.aces.filter((x) => !x.inherited); }
      else if (v === '/inheritance:d') { st.protected = true; st.aces.forEach((x) => { x.inherited = false; }); }
      else if (v === '/reset') { st.protected = false; st.aces = st.aces.filter((x) => x.inherited); }
      else if (v === '/remove') for (const g of args) st.aces = st.aces.filter((x) => x.inherited || x.sid !== sidOf(g));
      else if (v === '/grant:r') for (const g of args) { st.aces = st.aces.filter((x) => x.inherited || x.sid !== sidOf(g) || x.type !== 'Allow'); st.aces.push(ace(sidOf(g))); }
    }
    return Buffer.from('processed file: ' + file);
  };
  const readAcl = () => { log.push(['readAcl']); return { me: ME, protected: st.protected, owner: st.owner, aces: st.aces.map((x) => ({ ...x })) }; };
  return { st, log, icacls, readAcl };
}

function fakeFs(log = []) {
  return {
    log,
    openSync: (f, flag) => { log.push(['open', flag]); return 3; },
    closeSync: () => log.push(['close']),
    writeFileSync: (f, text, o) => log.push(['write', text, o?.mode]),
    chmodSync: (f, m) => log.push(['chmod', m]),
  };
}

const ENV = { USERNAME: 'ann', USERDOMAIN: 'PC1' };
const LIMIT_BY_NAME = '/inheritance:r /grant:r PC1\\ann:F *S-1-5-18:F *S-1-5-32-544:F';
const LIMIT_BY_SID = `/inheritance:r /grant:r *${ME}:F *S-1-5-18:F *S-1-5-32-544:F`;
/** Runs writeOwnerOnly on a fakeWin; returns { warning, log, st }. */
function runWriter(start) {
  const w = fakeWin(start);
  const warning = auth.writeOwnerOnly('C:\\o\\.office-token', 'SECRET', { fs: fakeFs(w.log), icacls: w.icacls, readAcl: w.readAcl, platform: 'win32', env: ENV });
  return { warning, log: w.log, st: w.st };
}

test('writeOwnerOnly: files that inherit exactly the user, SYSTEM and Administrators are not limited until inheritance is off and every entry is explicit', () => {
  // The case of GitHub's runner: the folder hands down exactly the three, the owner is Administrators. An icacls that
  // exits 0 and changes nothing leaves a list of three (I) entries; a count of three is not success.
  const three = [ace(SYSTEM, { inherited: true }), ace(ADMINS, { inherited: true }), ace(ME, { inherited: true })];
  const dead = runWriter({ aces: three, owner: ADMINS, broken: ['all'] });
  assert.match(String(dead.warning), /^Could not limit C:\\o\\\.office-token to your Windows user \(inheritance is on; inherited entry for S-1-5-18; .*\)\. Other users of this computer may read it\.$/);
  assert.deepEqual(dead.log.at(-1), ['write', 'SECRET', undefined], 'written anyway, with the warning');
  // /inheritance:r ignored, but /inheritance:d works: the inherited entries become explicit, the limit collapses them.
  const noR = runWriter({ aces: three, owner: ADMINS, broken: ['/inheritance:r'] });
  assert.equal(noR.warning, null);
  assert.deepEqual(noR.st, { protected: true, owner: ADMINS, aces: [ace(ME), ace(SYSTEM), ace(ADMINS)] });
  assert.deepEqual(noR.log, [['open', 'a'], ['close'], ['icacls', LIMIT_BY_NAME], ['readAcl'], ['icacls', '/inheritance:d'], ['icacls', LIMIT_BY_SID], ['readAcl'], ['write', 'SECRET', undefined]]);
  // A working icacls: one limit, one check.
  const ok = runWriter({ aces: three, owner: ADMINS });
  assert.equal(ok.warning, null);
  assert.deepEqual(ok.log, [['open', 'a'], ['close'], ['icacls', LIMIT_BY_NAME], ['readAcl'], ['write', 'SECRET', undefined]]);
});

test('writeOwnerOnly: explicit entries the limit leaves are removed by SID; the file is never emptied or reset', () => {
  // A normal user's default DACL (folder with nothing to inherit): the logon session stays after the limit.
  const normal = runWriter({ aces: [ace(ME), ace(SYSTEM), ace(LOGON, { rights: 'ReadAndExecute, Synchronize' })] });
  assert.equal(normal.warning, null);
  assert.deepEqual(normal.log, [['open', 'a'], ['close'], ['icacls', LIMIT_BY_NAME], ['readAcl'], ['icacls', `/remove *${LOGON}`], ['icacls', LIMIT_BY_SID], ['readAcl'], ['write', 'SECRET', undefined]]);
  // An elevated administrator's default DACL (GitHub's runner): SYSTEM, Administrators, OWNER RIGHTS.
  const elevated = runWriter({ aces: [ace(SYSTEM), ace(ADMINS), ace(OWNER_RIGHTS)], owner: ADMINS });
  assert.equal(elevated.warning, null);
  assert.ok(elevated.log.some((l) => l[1] === `/remove *${OWNER_RIGHTS}`));
  // An old file with grants and denies set by hand, and inherited Users: all go; denies of a kept SID too.
  const old = runWriter({ aces: [ace(USERS, { rights: 'Read' }), ace(EVERYONE, { rights: 'Read' }), ace(ANONYMOUS, { type: 'Deny', rights: 'Read' }), ace(SYSTEM, { type: 'Deny', rights: 'Write' }), ace(USERS, { rights: 'ReadAndExecute', inherited: true })] });
  assert.equal(old.warning, null);
  assert.deepEqual(auth.aclProblems({ me: ME, ...old.st }), []);
  assert.ok(old.log.some((l) => l[1] === `/remove *${USERS} *${EVERYONE} *${ANONYMOUS} *${SYSTEM}`), JSON.stringify(old.log));
  for (const r of [normal, elevated, old]) assert.ok(!r.log.some((l) => l[1] === '/reset' || (l[0] === 'open' && l[1] === 'w')), 'no /reset, never emptied');
});

test('writeOwnerOnly: what is still wrong is named in the warning; failures are best effort; a bug throws', () => {
  // /remove does nothing: the warning names the entry that is left.
  const stuck = runWriter({ aces: [ace(ME), ace(SYSTEM), ace(EVERYONE, { rights: 'Read' })], broken: ['/remove'] });
  assert.match(stuck.warning, new RegExp(`\\(Allow entry for ${EVERYONE}\\)`));
  // An owner that is not one of the three cannot be fixed here: said so.
  assert.match(runWriter({ aces: [ace(ME)], owner: OTHER }).warning, new RegExp(`\\(the owner is ${OTHER}\\)`));
  // PowerShell cannot read the ACL (constrained language mode, for example): the reason, and the file is written.
  const f5 = fakeFs();
  const w5 = auth.writeOwnerOnly('C:\\o\\x.json', 'T', { fs: f5, icacls: () => {}, readAcl: () => { const e = new Error('Command failed'); e.stderr = 'Cannot invoke method. Method invocation is supported only on core types in this language mode.\r\nAt line:3'; throw e; }, platform: 'win32', env: ENV });
  assert.match(w5, /Could not limit C:\\o\\x\.json to your Windows user \(Cannot invoke method\. Method invocation is supported only on core types in this language mode\.\)/);
  assert.deepEqual(f5.log.at(-1), ['write', 'T', undefined]);
  const f2 = fakeFs();
  const w2 = auth.writeOwnerOnly('C:\\o\\x.json', 'T', { fs: f2, icacls: () => { const e = new Error('Command failed'); e.stderr = 'x: No mapping between account names\r\nmore'; throw e; }, readAcl: () => LIMITED, platform: 'win32', env: ENV });
  assert.match(w2, /Could not limit C:\\o\\x\.json to your Windows user \(x: No mapping between account names\)\. Other users/);
  assert.deepEqual(f2.log.at(-1), ['write', 'T', undefined], 'the file is still written (best effort)');
  const f3 = fakeFs();
  assert.equal(auth.writeOwnerOnly('/o/t', 'T', { fs: f3, icacls: () => assert.fail('no icacls off Windows'), readAcl: () => assert.fail('no check off Windows'), platform: 'linux', env: ENV }), null);
  assert.deepEqual(f3.log, [['write', 'T', 0o600], ['chmod', 0o600]]);
  // A missing USERNAME is best effort too; a bug in the runner (an import that is gone, a missing reader) is not
  // hidden as a warning.
  assert.match(auth.writeOwnerOnly('C:\\o\\y', 'T', { fs: fakeFs(), icacls: () => {}, readAcl: () => LIMITED, platform: 'win32', env: {} }), /USERNAME is not set/);
  const f4 = fakeFs();
  // eslint-disable-next-line no-undef
  assert.throws(() => auth.writeOwnerOnly('C:\\o\\z', 'SECRET', { fs: f4, icacls: () => execFileSyncThatIsGone(), readAcl: () => LIMITED, platform: 'win32', env: ENV }), ReferenceError);
  assert.ok(!f4.log.some((l) => l[0] === 'write'), 'nothing is written after a bug');
  assert.throws(() => auth.writeOwnerOnly('C:\\o\\z', 'SECRET', { fs: fakeFs(), icacls: () => {}, platform: 'win32', env: ENV }), TypeError, 'no readAcl');
});

// ---------- real ACLs (Windows) ----------

// The limits only stop a stuck program: Windows PowerShell can need over a minute to start on a loaded machine (#98).
/** The runners of server.mjs (writeSecret): icacls from System32, the ACL reader through Windows PowerShell. */
const runIcacls = (args) => execFileSync(resolveExe('icacls'), args, { windowsHide: true, stdio: 'pipe', timeout: 180000 });
const runReadAcl = (f) => auth.parseAcl(execFileSync(resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', auth.ACL_SCRIPT],
  { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 180000, env: { ...process.env, AO_ACL_FILE: f } }));
const REAL = { fs, icacls: runIcacls, readAcl: runReadAcl };

const runPs = (script, env) => execFileSync(resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, ...env } });

/**
 * The DACL of each file or folder by SID, read with .NET in Windows PowerShell: no account names (they change with
 * the language of Windows) and no module cmdlets. Written apart from auth.ACL_SCRIPT on purpose, so the test does not
 * check the writer with the writer's own reader. Returns { me, files: [{ protected, owner, aces: [{ sid, type,
 * rights, inherited, flags }] }] }, where me is the SID of the user who runs the tests and flags the inheritance
 * flags of a folder entry.
 */
function aclOf(files) {
  const out = runPs([
    "$ErrorActionPreference = 'Stop'",
    '$S = [System.Security.Principal.SecurityIdentifier]',
    "'me|' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    '$i = 0',
    'foreach ($f in $env:AO_ACL_FILES.Split([char]10)) {',
    '  if ([System.IO.Directory]::Exists($f)) { $a = [System.IO.Directory]::GetAccessControl($f) } else { $a = [System.IO.File]::GetAccessControl($f) }',
    "  'file|' + $i + '|' + $a.AreAccessRulesProtected + '|' + $a.GetOwner($S).Value",
    "  foreach ($r in $a.GetAccessRules($true, $true, $S)) { 'ace|' + $i + '|' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.FileSystemRights + '|' + $r.IsInherited + '|' + $r.InheritanceFlags }",
    '  $i++',
    '}',
  ].join('\n'), { AO_ACL_FILES: files.join('\n') });
  const res = { me: null, files: files.map(() => ({ protected: null, owner: null, aces: [] })) };
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split('|');
    if (p[0] === 'me') res.me = p[1];
    else if (p[0] === 'file') Object.assign(res.files[Number(p[1])], { protected: p[2] === 'True', owner: p[3] });
    else if (p[0] === 'ace') res.files[Number(p[1])].aces.push({ sid: p[2], type: p[3], rights: p[4], inherited: p[5] === 'True', flags: p[6] });
  }
  assert.match(String(res.me), /^S-1-5-/, out);
  return res;
}

/**
 * Gives a folder exactly these entries, with inheritance off: rules [[sid, rights, inheritable]]. Set with .NET
 * (Directory.SetAccessControl), not icacls, and read back: the test's folders must be what the test says on every
 * machine. (On GitHub's runner in run 41938497590 a folder set up with icacls /inheritance:r still handed down
 * SYSTEM, Administrators and runneradmin to new files.)
 */
function folderAcl(dir, rules) {
  runPs([
    "$ErrorActionPreference = 'Stop'",
    '$sec = New-Object System.Security.AccessControl.DirectorySecurity',
    '$sec.SetAccessRuleProtection($true, $false)',
    "foreach ($spec in $env:AO_RULES.Split(';')) {",
    "  $p = $spec.Split('|')",
    '  $inh = [System.Security.AccessControl.InheritanceFlags]::None',
    "  if ($p[2] -eq '1') { $inh = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }",
    '  $sid = New-Object System.Security.Principal.SecurityIdentifier($p[0])',
    '  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]$p[1], $inh, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))',
    '}',
    '[System.IO.Directory]::SetAccessControl($env:AO_DIR, $sec)',
  ].join('\n'), { AO_DIR: dir, AO_RULES: rules.map(([s, r, i]) => `${s}|${r}|${i ? 1 : 0}`).join(';') });
  const got = aclOf([dir]).files[0];
  const show = `setup of ${path.basename(dir)}: ${JSON.stringify(got)}`;
  assert.equal(got.protected, true, show);
  assert.deepEqual(got.aces.map((a) => [a.sid, a.rights, a.inherited, a.flags !== 'None']).sort(), rules.map(([s, r, i]) => [s, r, false, !!i]).sort(), show);
}

/** A folder whose entries new files inherit: the user and SYSTEM, plus Users, Authenticated Users and Everyone. */
const wideFolder = (dir, me) => folderAcl(dir, [[me, 'FullControl', 1], [SYSTEM, 'FullControl', 1], [USERS, 'ReadAndExecute, Synchronize', 1], [AUTH_USERS, 'Read, Synchronize', 1], [EVERYONE, 'Read, Synchronize', 1]]);

/**
 * A limited file: exactly three entries, for the user, SYSTEM and Administrators, each an explicit allow with full
 * control; inheritance off; the owner one of the three. Anything else fails: Users, Authenticated Users, Everyone,
 * the logon session, any other account, a deny, an inherited entry.
 */
function assertLimited(acl, me, label) {
  const show = `${label}: ${JSON.stringify(acl)}`;
  assert.equal(acl.protected, true, `inheritance is on. ${show}`);
  assert.ok([me, SYSTEM, ADMINS].includes(acl.owner), `owner. ${show}`);
  assert.deepEqual(acl.aces.map((a) => a.sid).sort(), [me, SYSTEM, ADMINS].sort(), show);
  for (const a of acl.aces) assert.deepEqual([a.type, a.rights, a.inherited], ['Allow', 'FullControl', false], show);
}

test('writeOwnerOnly with the real icacls: only the user, SYSTEM and Administrators are left, from any start', { skip: !win, timeout: 900000 }, () => {
  // The folders are set up here, so the result does not depend on where the temp folder or the repo is.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-acl-')));
  try {
    const me = aclOf([base]).me;
    // wide: new files inherit Users, Authenticated Users and Everyone (like the root of a data drive).
    // three: new files inherit exactly the user, SYSTEM and Administrators (GitHub runner's temp folder): the right
    //   count, all inherited, inheritance on.
    // bare: nothing to inherit, so a new file gets the token's default DACL as explicit entries, which
    //   /inheritance:r does not remove. A normal user: the user, SYSTEM, the logon session. An elevated administrator
    //   (GitHub's runner): SYSTEM, Administrators, sometimes OWNER RIGHTS.
    const wide = path.join(base, 'wide'), three = path.join(base, 'three'), bare = path.join(base, 'bare');
    for (const d of [wide, three, bare]) fs.mkdirSync(d);
    wideFolder(wide, me);
    folderAcl(three, [[me, 'FullControl', 1], [SYSTEM, 'FullControl', 1], [ADMINS, 'FullControl', 1]]);
    folderAcl(bare, [[me, 'FullControl', 0]]);
    // The setup is real for new files too.
    for (const d of [wide, three, bare]) fs.writeFileSync(path.join(d, 'plain'), 'x');
    const plain = aclOf([wide, three, bare].map((d) => path.join(d, 'plain'))).files;
    assert.ok(plain[0].aces.some((a) => a.sid === USERS && a.inherited), 'wide/plain ' + JSON.stringify(plain[0]));
    assert.ok(!plain[1].protected && plain[1].aces.length === 3 && plain[1].aces.every((a) => a.inherited), 'three/plain ' + JSON.stringify(plain[1]));
    assert.ok(plain[2].aces.every((a) => !a.inherited) && plain[2].aces.some((a) => a.sid !== me), 'bare/plain ' + JSON.stringify(plain[2]));

    // An icacls that exits 0 and changes nothing, on a file that inherits exactly the three (its list shows three
    // (I) entries): the writer must say so. fb2eced counted three entries and called that limited.
    const deadFile = path.join(three, 'dead.json');
    const dead = auth.writeOwnerOnly(deadFile, 'SECRET-dead', { ...REAL, icacls: (a) => (a.length === 1 ? runIcacls(a) : Buffer.from('')) });
    assert.match(String(dead), /dead\.json to your Windows user \(inheritance is on; inherited entry for /);

    const files = { wideNew: path.join(wide, 'new.json'), threeNew: path.join(three, 'new.json'), bareNew: path.join(bare, 'new.json'),
      deadAgain: deadFile, wideOld: path.join(wide, 'old.json'), bareOld: path.join(bare, 'old.json') };
    // Old files: an old secret and explicit entries set by hand: SYSTEM and Administrators as GitHub's runner
    // shows them, Users, Authenticated Users, Everyone, and a deny.
    for (const f of [files.wideOld, files.bareOld]) {
      fs.writeFileSync(f, 'OLD');
      runIcacls([f, '/grant', `*${SYSTEM}:F`, `*${ADMINS}:F`, `*${USERS}:R`, `*${AUTH_USERS}:R`, `*${EVERYONE}:R`]);
      runIcacls([f, '/deny', `*${ANONYMOUS}:R`]);
    }
    for (const [k, f] of Object.entries(files)) assert.equal(auth.writeOwnerOnly(f, 'SECRET-' + k, REAL), null, k);
    const acl = aclOf(Object.values(files));
    Object.entries(files).forEach(([k, f], i) => {
      assertLimited(acl.files[i], me, k);
      assert.equal(fs.readFileSync(f, 'utf8'), 'SECRET-' + k);
    });
    // A later plain write keeps the ACL, and so does a second writeOwnerOnly.
    fs.writeFileSync(files.wideNew, 'MORE');
    assert.equal(auth.writeOwnerOnly(files.bareNew, 'AGAIN', REAL), null);
    const again = aclOf([files.wideNew, files.bareNew]);
    assertLimited(again.files[0], me, 'wideNew after a plain write');
    assertLimited(again.files[1], me, 'bareNew written twice');
    assert.equal(fs.readFileSync(files.bareNew, 'utf8'), 'AGAIN');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---------- sources ----------

test('no token in the page source, no token from the URL, no plain token compare in the server', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /__TOKEN__|office-token/);
  for (const f of ['public/adapter.js', 'public/office.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /office-token|x-office-token|[?&]t=/, f);
  }
  const server = read('server.mjs');
  assert.doesNotMatch(server, /searchParams\.get\(\s*['"]t['"]\s*\)/);
  assert.doesNotMatch(server, /[!=]==?\s*(AGENT_TOKEN|PAGE_TOKEN)\b|\b(AGENT_TOKEN|PAGE_TOKEN)\s*[!=]==?/);
  assert.doesNotMatch(server, /__TOKEN__/);
  assert.match(read('auth.mjs'), /crypto\.timingSafeEqual\(/);
});

// ---------- the real server ----------

/** One HTTP request with full control of the headers (fetch drops Host, Origin, Cookie and Sec-*). */
function hit(port, method, p, { headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...headers } }, (res) => {
      if (String(res.headers['content-type']).startsWith('text/event-stream')) {
        res.once('data', (c) => { resolve({ status: res.statusCode, headers: res.headers, text: String(c) }); res.destroy(); });
        return;
      }
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: b, json }); });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

test('route matrix, launch code and owner-only files on a real server', { timeout: 900000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-auth-')));
  if (win) wideFolder(tmp, aclOf([tmp]).me); // the same start on every machine, wherever the temp folder is
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(baseEnv, {
    // No claude on PATH: no paid call and a fast start. Programs from System32 come by absolute path anyway.
    PATH: [path.dirname(process.execPath), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  // The free port can be taken before the server binds it; the helper then starts again on a new port (test/fixtures/office-server.mjs).
  let office = null;
  // The finally stops the second copy too. A copy that is still starting when the test fails keeps the folder busy, and
  // once the first office is gone it takes the port and runs on with no test to stop it (#78).
  let second = null;
  try {
    const started = await startOnFreePort(dir, baseEnv);
    office = started.office;
    const { port, env } = started;
    const code = office.out().match(/#n=([0-9a-f]{32})/)[1];
    const own = officeFiles(dir, port); // a free port is not the default one, so the names carry the port (files.mjs)
    const agent = JSON.parse(fs.readFileSync(own.token, 'utf8'));
    const pagePath = auth.pageFile(env, port);
    assert.ok(pagePath.startsWith(lad), pagePath);
    const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
    assert.equal(agent.port, port);
    assert.equal(page.port, port);
    assert.match(agent.token, auth.AGENT_TOKEN_RE);
    assert.match(page.token, /^[0-9a-f]{64}$/);
    assert.notEqual(agent.token, page.token);
    // No file in the office folder holds the page token; only the token file and the HTTP hooks file hold the agent token.
    const inFolder = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    for (const f of inFolder) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(page.token), `${f} holds the page token`);
    assert.deepEqual(inFolder.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(agent.token)).sort(), [own.token, own.hooksHttp].map((f) => path.basename(f)).sort());

    const A = { 'content-type': 'application/json', 'x-office-token': agent.token };
    const P = { 'content-type': 'application/json', 'x-office-token': page.token };
    const frame = (r, what) => {
      assert.equal(r.headers['x-frame-options'], 'DENY', what);
      assert.equal(r.headers['content-security-policy'], auth.CSP, what);
    };

    // GET / holds no token.
    const home = await hit(port, 'GET', '/');
    assert.equal(home.status, 200);
    frame(home, 'GET /');
    for (const t of [agent.token, page.token, '__TOKEN__', 'office-token']) assert.ok(!home.text.includes(t), 'GET / contains ' + t.slice(0, 12));
    frame(await hit(port, 'GET', '/adapter.js'), 'static');

    // No token: 401 on every token route.
    for (const [m, p] of [['GET', '/events'], ['GET', '/api/info'], ['GET', '/api/auth'], ['POST', '/api/history'], ['POST', '/api/answer'], ['POST', '/api/startup'],
      ['POST', '/hook'], ['POST', '/hook/http'], ['POST', '/hook/permission'], ['POST', '/mcp/inbox'], ['POST', '/mcp/room']]) {
      const r = await hit(port, m, p, { headers: m === 'POST' ? { 'content-type': 'application/json' } : {}, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${m} ${p}`);
      frame(r, `401 ${p}`);
    }
    // The agent token never opens a page route.
    assert.equal((await hit(port, 'GET', '/events', { headers: { 'x-office-token': agent.token } })).status, 401);
    assert.equal((await hit(port, 'GET', '/api/info', { headers: { 'x-office-token': agent.token } })).status, 401);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: A, body: {} })).status, 401);
    assert.equal((await hit(port, 'POST', '/api/launch-link', { headers: A, body: {} })).status, 401);
    // The page token never opens an agent route, by header or by cookie.
    const cookieOf = (t) => `${auth.cookieName(port)}=${t}`;
    for (const p of ['/hook', '/hook/http', '/hook/permission', '/mcp/inbox', '/mcp/room']) {
      assert.equal((await hit(port, 'POST', p, { headers: P, body: {} })).status, 401, p);
      assert.equal((await hit(port, 'POST', p, { headers: { 'content-type': 'application/json', cookie: cookieOf(page.token) }, body: {} })).status, 401, p + ' cookie');
    }
    // Each token on its own group.
    const hook = await hit(port, 'POST', '/hook', { headers: A, body: { hook_event_name: 'Notification', session_id: 's1', cwd: tmp } });
    assert.equal(hook.status, 200);
    frame(hook, 'hook');
    assert.equal((await hit(port, 'POST', '/mcp/inbox', { headers: A, body: {} })).status, 200);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: P, body: {} })).status, 200);
    const ev = await hit(port, 'GET', '/events', { headers: { 'x-office-token': page.token } });
    assert.equal(ev.status, 200);
    assert.match(ev.text, /^data: \{/);

    // ?t= opens nothing: not on a POST, not on /events.
    assert.equal((await hit(port, 'POST', `/api/history?t=${page.token}`, { headers: { 'content-type': 'application/json' }, body: {} })).status, 401);
    assert.equal((await hit(port, 'POST', `/hook?t=${agent.token}`, { headers: { 'content-type': 'application/json' }, body: {} })).status, 401);
    assert.equal((await hit(port, 'GET', `/events?t=${page.token}`)).status, 401);

    // Foreign Origin, cross-site fetches, wrong content type and wrong Host are refused even with the right token.
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { ...P, origin: 'http://evil.example' }, body: {} })).status, 403);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { ...P, origin: `http://127.0.0.1:${port + 1}` }, body: {} })).status, 403);
    assert.equal((await hit(port, 'POST', '/hook', { headers: { ...A, origin: 'null' }, body: {} })).status, 403);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { ...P, origin: `http://127.0.0.1:${port}` }, body: {} })).status, 200);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { ...P, origin: `http://localhost:${port}` }, body: {} })).status, 200);
    assert.equal((await hit(port, 'GET', '/events', { headers: { cookie: cookieOf(page.token), 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { ...P, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await hit(port, 'POST', '/hook', { headers: { ...A, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const badHost = await hit(port, 'GET', '/', { host: 'evil.example' });
    assert.equal(badHost.status, 403);
    frame(badHost, '403');

    // The launch code: a wrong one fails, the right one gives the cookie once.
    const wrong = await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code: '0'.repeat(32) } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, auth.LINK_DEAD);
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ code }) })).status, 415, 'a form cannot trade the code');
    const traded = await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, body: { code } });
    assert.equal(traded.status, 200);
    const setCookie = String(traded.headers['set-cookie']);
    assert.match(setCookie, new RegExp(`^ao_${port}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict$`));
    assert.ok(!traded.text.includes(page.token), 'the token is not in the answer body');
    const jar = setCookie.split(';')[0];
    assert.equal(jar, cookieOf(page.token));
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code } })).status, 401, 'single use');
    // The cookie is what a reload sends: it opens the page routes, never the agent routes.
    assert.equal((await hit(port, 'GET', '/api/auth', { headers: { cookie: jar, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await hit(port, 'GET', '/events', { headers: { cookie: jar } })).status, 200);
    assert.equal((await hit(port, 'POST', '/api/history', { headers: { 'content-type': 'application/json', cookie: jar }, body: {} })).status, 200);
    assert.equal((await hit(port, 'POST', '/hook', { headers: { 'content-type': 'application/json', cookie: jar }, body: {} })).status, 401);

    // A new link for a second npm start: the page token asks, the code works once.
    const more = await hit(port, 'POST', '/api/launch-link', { headers: P, body: {} });
    assert.equal(more.status, 200);
    const code2 = new URL(more.json.url).hash.slice(3);
    assert.match(more.json.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#n=[0-9a-f]{32}$`));
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code: code2 } })).status, 200);
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code: code2 } })).status, 401);

    // A second copy on the same port changes no token and prints a fresh launch link from the running office.
    second = startOffice(dir, env);
    await second.done;
    await new Promise((r) => (second.child.exitCode !== null ? r() : second.child.once('exit', r)));
    assert.equal(second.child.exitCode, 0, second.out());
    assert.match(second.out(), /already running/);
    const code3 = second.out().match(/#n=([0-9a-f]{32})/)[1];
    assert.equal(JSON.parse(fs.readFileSync(own.token, 'utf8')).token, agent.token);
    assert.equal(JSON.parse(fs.readFileSync(pagePath, 'utf8')).token, page.token);
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code: code3 } })).status, 200);

    // Limited files: only the user, SYSTEM and Administrators, compared by SID, nothing inherited, although the
    // folders hand Users, Authenticated Users and Everyone down (wideFolder above).
    // The state and the past sessions (L10) are limited once at start; the plain writes after a change keep it.
    const statePath = own.state, historyPath = own.history;
    const historyBefore = fs.statSync(historyPath).mtimeMs;
    assert.equal((await hit(port, 'POST', '/api/notes/save', { headers: P, body: { key: 'l10-board', text: 'L10 NOTE', base: 0 } })).status, 200);
    assert.equal((await hit(port, 'POST', '/api/history/forget', { headers: P, body: { uid: 'nobody' } })).status, 200);
    await new Promise((r) => setTimeout(r, 1500)); // saveHistory waits 800 ms
    assert.match(fs.readFileSync(statePath, 'utf8'), /L10 NOTE/, 'savePersisted wrote state.json');
    assert.ok(fs.statSync(historyPath).mtimeMs > historyBefore, 'saveHistory wrote history.json');
    if (win) {
      const files = [own.token, own.hooksHttp, own.hooksCmd, own.mcp, pagePath, statePath, historyPath];
      const acl = aclOf(files);
      files.forEach((f, i) => assertLimited(acl.files[i], acl.me, path.basename(f)));
    } else {
      for (const f of [statePath, historyPath]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, path.basename(f));
    }
  } finally {
    for (const o of [office, second]) {
      if (!o) continue;
      o.child.kill();
      await new Promise((r) => (o.child.exitCode !== null ? r() : o.child.once('exit', r)));
    }
    // The server's helpers start in %SystemRoot% (git.helperCwd), so once both copies are gone nothing is in the folder.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('stalePageFiles removes only page files of ports with no listener (#126)', async () => {
  const dir = path.join('C:\\L', 'AgentOffice');
  const file = auth.pageFile({ LOCALAPPDATA: 'C:\\L' }, 4400);
  const names = ['office-page-4317.json', 'office-page-4400.json', 'office-page-4401.json', 'office-page-4402.json',
    'office-page-x.json', 'office-page-.json', 'office-page-44.json.bak', 'notes.json', 'office-page-99999999999999999999.json'];
  const gone = [], probed = [];
  const out = await auth.stalePageFiles({
    file, port: 4400,
    readdir: async (d) => { assert.equal(d, dir); return names; },
    isListening: async (p) => { probed.push(p); return p === 4401; },
    unlink: async (f) => { gone.push(path.basename(f)); },
  });
  assert.deepEqual(gone.sort(), ['office-page-4317.json', 'office-page-4402.json']);
  assert.deepEqual(out.sort(), gone.sort());
  assert.ok(!probed.includes(4400), 'the own port is not probed');
});

test('stalePageFiles never throws on a readdir, probe or unlink error (#126)', async () => {
  const file = auth.pageFile({ LOCALAPPDATA: 'C:\\L' }, 4400);
  assert.deepEqual(await auth.stalePageFiles({ file, port: 4400, readdir: async () => { throw new Error('no folder'); }, isListening: async () => false, unlink: async () => {} }), []);
  const out = await auth.stalePageFiles({ file, port: 4400, readdir: async () => ['office-page-4401.json', 'office-page-4402.json'],
    isListening: async () => false, unlink: async (f) => { if (f.includes('4401')) throw new Error('busy'); } });
  assert.deepEqual(out, ['office-page-4402.json']);
  assert.deepEqual(await auth.stalePageFiles({ file, port: 4400, readdir: async () => ['office-page-4401.json'], isListening: async () => { throw new Error('x'); }, unlink: async () => {} }), []);
});

test('removeOwnPageFile removes the file only while it holds this office token (#126)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pf-'));
  try {
    const f = path.join(dir, 'office-page-4400.json');
    fs.writeFileSync(f, JSON.stringify({ token: 'mine', port: 4400 }));
    assert.equal(auth.removeOwnPageFile(f, 'mine'), true);
    assert.equal(fs.existsSync(f), false);
    fs.writeFileSync(f, JSON.stringify({ token: 'newer', port: 4400 }));
    assert.equal(auth.removeOwnPageFile(f, 'mine'), false);
    assert.equal(fs.existsSync(f), true, 'a newer office on the port keeps its file');
    fs.writeFileSync(f, 'not json');
    assert.equal(auth.removeOwnPageFile(f, 'mine'), false);
    assert.equal(auth.removeOwnPageFile(path.join(dir, 'none.json'), 'mine'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
