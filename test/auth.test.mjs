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
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from '../auth.mjs';
import { resolveExe } from '../git.mjs';

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
  assert.equal(auth.SECURITY_HEADERS['content-security-policy'], "frame-ancestors 'none'");
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
});

/** What `icacls <file>` prints: the path and the first entry, the other entries under it, a blank line, a summary. */
const listing = (file, entries) => [`${file} ${entries[0]}`, ...entries.slice(1).map((e) => ' '.repeat(file.length + 1) + e), '', 'Successfully processed 1 files; Failed processing 0 files', ''].join('\r\n');

test('aclEntries: one entry per line up to the blank line; the summary is not an entry', () => {
  const f = 'C:\\T\\ao x\\new.txt'; // a space in the path
  // Entries from a real list: a new file in a folder with nothing to inherit, made with a normal user's token.
  const out = listing(f, ['DESKTOP-1\\ann:(F)', 'NT AUTHORITY\\SYSTEM:(F)', 'NT AUTHORITY\\LogonSessionId_0_2442608:(RX)']);
  assert.deepEqual(auth.aclEntries(out), [`${f} DESKTOP-1\\ann:(F)`, 'NT AUTHORITY\\SYSTEM:(F)', 'NT AUTHORITY\\LogonSessionId_0_2442608:(RX)']);
  assert.equal(auth.aclEntries(Buffer.from(listing(f, ['BUILTIN\\Administrators:(F)']))).length, 1, 'a Buffer, as execFileSync gives it');
  assert.equal(auth.aclEntries('\r\n' + listing(f, ['a:(F)', 'b:(F)'])).length, 2, 'a leading blank line');
  for (const nothing of ['', undefined, null, 4]) assert.ok(auth.aclEntries(nothing).length <= 1, String(nothing));
});

function fakeFs() {
  const log = [];
  return {
    log,
    openSync: (f, flag) => { log.push(['open', flag]); return 3; },
    closeSync: () => log.push(['close']),
    writeFileSync: (f, text, o) => log.push(['write', text, o?.mode]),
    chmodSync: (f, m) => log.push(['chmod', m]),
  };
}

/** A fake icacls: logs each call; `icacls <file>` answers with the next entry list of `lists` (the last one repeats). */
function fakeIcacls(log, lists) {
  let n = 0;
  return (a) => {
    log.push(['icacls', a.join(' ')]);
    if (a.length === 1) return Buffer.from(listing(a[0], lists[Math.min(n++, lists.length - 1)]));
    return Buffer.from('processed file: ' + a[0]);
  };
}

test('writeOwnerOnly on Windows: limit, check the list, then write; an entry left over is removed on an emptied file', () => {
  const env = { USERNAME: 'ann', USERDOMAIN: 'PC1' };
  const LIMIT = 'C:\\o\\.office-token /inheritance:r /grant:r PC1\\ann:F *S-1-5-18:F *S-1-5-32-544:F';
  const three = ['PC1\\ann:(F)', 'NT AUTHORITY\\SYSTEM:(F)', 'BUILTIN\\Administrators:(F)'];
  // The usual path (a new file with inherited entries only, or a file that is already limited): the text stays in
  // place, the file is never emptied and never reset.
  const f1 = fakeFs();
  const w1 = auth.writeOwnerOnly('C:\\o\\.office-token', 'SECRET', { fs: f1, icacls: fakeIcacls(f1.log, [three]), platform: 'win32', env });
  assert.equal(w1, null);
  assert.deepEqual(f1.log, [['open', 'a'], ['close'], ['icacls', LIMIT], ['icacls', 'C:\\o\\.office-token'], ['write', 'SECRET', undefined]]);
  // An explicit entry the limit does not touch (the token's default DACL: the logon session; or a grant set by hand):
  // empty the file, /reset, limit again, check again, then write.
  const f5 = fakeFs();
  const w5 = auth.writeOwnerOnly('C:\\o\\.office-token', 'SECRET', { fs: f5, icacls: fakeIcacls(f5.log, [[...three, 'NT AUTHORITY\\LogonSessionId_0_1:(RX)'], three]), platform: 'win32', env });
  assert.equal(w5, null);
  assert.deepEqual(f5.log, [['open', 'a'], ['close'], ['icacls', LIMIT], ['icacls', 'C:\\o\\.office-token'],
    ['open', 'w'], ['close'], ['icacls', 'C:\\o\\.office-token /reset'], ['icacls', LIMIT], ['icacls', 'C:\\o\\.office-token'], ['write', 'SECRET', undefined]]);
  // Still other entries after /reset: a warning, and the file is written anyway (best effort).
  const f6 = fakeFs();
  const w6 = auth.writeOwnerOnly('C:\\o\\.office-token', 'SECRET', { fs: f6, icacls: fakeIcacls(f6.log, [[...three, 'BUILTIN\\Users:(R)']]), platform: 'win32', env });
  assert.match(w6, /Could not limit C:\\o\\\.office-token to your Windows user \(other entries are still on it after icacls \/reset\)\. Other users/);
  assert.deepEqual(f6.log.at(-1), ['write', 'SECRET', undefined]);
  // An empty or odd list is not taken as limited.
  const f7 = fakeFs();
  assert.match(auth.writeOwnerOnly('C:\\o\\.office-token', 'S', { fs: f7, icacls: (a) => { f7.log.push(a); }, platform: 'win32', env }), /other entries are still on it/);
  assert.ok(f7.log.some((a) => a.includes('/reset')));
  const f2 = fakeFs();
  const w2 = auth.writeOwnerOnly('C:\\o\\x.json', 'T', { fs: f2, icacls: () => { const e = new Error('Command failed'); e.stderr = 'x: No mapping between account names\r\nmore'; throw e; }, platform: 'win32', env });
  assert.match(w2, /Could not limit C:\\o\\x\.json to your Windows user \(x: No mapping between account names\)\. Other users/);
  assert.deepEqual(f2.log.at(-1), ['write', 'T', undefined], 'the file is still written (best effort)');
  const f3 = fakeFs();
  assert.equal(auth.writeOwnerOnly('/o/t', 'T', { fs: f3, icacls: () => assert.fail('no icacls off Windows'), platform: 'linux', env }), null);
  assert.deepEqual(f3.log, [['write', 'T', 0o600], ['chmod', 0o600]]);
  // A missing USERNAME is best effort too; a bug in the runner (an import that is gone) is not hidden as a warning.
  assert.match(auth.writeOwnerOnly('C:\\o\\y', 'T', { fs: fakeFs(), icacls: () => {}, platform: 'win32', env: {} }), /USERNAME is not set/);
  const f4 = fakeFs();
  // eslint-disable-next-line no-undef
  assert.throws(() => auth.writeOwnerOnly('C:\\o\\z', 'SECRET', { fs: f4, icacls: () => execFileSyncThatIsGone(), platform: 'win32', env }), ReferenceError);
  assert.ok(!f4.log.some((l) => l[0] === 'write'), 'nothing is written after a bug');
});

// ---------- real ACLs (Windows) ----------

/** The icacls runner of server.mjs (writeSecret): icacls from System32, its output returned. */
const runIcacls = (args) => execFileSync(resolveExe('icacls'), args, { windowsHide: true, stdio: 'pipe', timeout: 15000 });

/**
 * The DACL of each file by SID, read with .NET in Windows PowerShell: no account names (they change with the
 * language of Windows) and no module cmdlets. Returns { me, files: [{ protected, owner, aces: [{ sid, type, rights,
 * inherited }] }] }, where me is the SID of the user who runs the tests.
 */
function aclOf(files) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$S = [System.Security.Principal.SecurityIdentifier]',
    "'me|' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    '$i = 0',
    'foreach ($f in $env:AO_ACL_FILES.Split([char]10)) {',
    '  $a = [System.IO.File]::GetAccessControl($f)',
    "  'file|' + $i + '|' + $a.AreAccessRulesProtected + '|' + $a.GetOwner($S).Value",
    "  foreach ($r in $a.GetAccessRules($true, $true, $S)) { 'ace|' + $i + '|' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.FileSystemRights + '|' + $r.IsInherited }",
    '  $i++',
    '}',
  ].join('\n');
  const out = execFileSync(resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, AO_ACL_FILES: files.join('\n') } });
  const res = { me: null, files: files.map(() => ({ protected: null, owner: null, aces: [] })) };
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split('|');
    if (p[0] === 'me') res.me = p[1];
    else if (p[0] === 'file') Object.assign(res.files[Number(p[1])], { protected: p[2] === 'True', owner: p[3] });
    else if (p[0] === 'ace') res.files[Number(p[1])].aces.push({ sid: p[2], type: p[3], rights: p[4], inherited: p[5] === 'True' });
  }
  assert.match(String(res.me), /^S-1-5-/, out);
  return res;
}

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

/** A folder whose entries new files inherit: the user and SYSTEM, plus Users, Authenticated Users and Everyone. */
function wideFolder(dir, me) {
  runIcacls([dir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, `*${SYSTEM}:(OI)(CI)F`, `*${USERS}:(OI)(CI)RX`, `*${AUTH_USERS}:(OI)(CI)R`, `*${EVERYONE}:(OI)(CI)R`]);
}

test('writeOwnerOnly with the real icacls: only the user, SYSTEM and Administrators are left, from any start', { skip: !win, timeout: 90000 }, () => {
  // The folders are set up here, so the result does not depend on where the temp folder or the repo is.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-acl-')));
  try {
    const me = aclOf([base]).me;
    // wide: new files inherit Users, Authenticated Users and Everyone (like the root of a data drive).
    // bare: nothing to inherit, so a new file gets the token's default DACL as explicit entries, which
    // /inheritance:r does not remove. A normal user: the user, SYSTEM, the logon session. An elevated administrator
    // (GitHub's runner): SYSTEM and Administrators.
    const wide = path.join(base, 'wide'), bare = path.join(base, 'bare');
    fs.mkdirSync(wide);
    fs.mkdirSync(bare);
    wideFolder(wide, me);
    runIcacls([bare, '/inheritance:r', '/grant:r', `*${me}:F`]);
    // The setup is real: a plain new file in wide inherits Users; in bare it has explicit entries for others than the user.
    fs.writeFileSync(path.join(wide, 'plain'), 'x');
    fs.writeFileSync(path.join(bare, 'plain'), 'x');
    const plain = aclOf([path.join(wide, 'plain'), path.join(bare, 'plain')]).files;
    assert.ok(plain[0].aces.some((a) => a.sid === USERS && a.inherited), JSON.stringify(plain[0]));
    assert.ok(plain[1].aces.every((a) => !a.inherited) && plain[1].aces.some((a) => a.sid !== me), JSON.stringify(plain[1]));

    const files = { wideNew: path.join(wide, 'new.json'), bareNew: path.join(bare, 'new.json'), wideOld: path.join(wide, 'old.json'), bareOld: path.join(bare, 'old.json') };
    // Old files: an old secret and explicit entries set by hand: SYSTEM and Administrators as GitHub's runner
    // shows them, Users, Authenticated Users, Everyone, and a deny.
    for (const f of [files.wideOld, files.bareOld]) {
      fs.writeFileSync(f, 'OLD');
      runIcacls([f, '/grant', `*${SYSTEM}:F`, `*${ADMINS}:F`, `*${USERS}:R`, `*${AUTH_USERS}:R`, `*${EVERYONE}:R`]);
      runIcacls([f, '/deny', `*${ANONYMOUS}:R`]);
    }
    for (const [k, f] of Object.entries(files)) assert.equal(auth.writeOwnerOnly(f, 'SECRET-' + k, { fs, icacls: runIcacls }), null, k);
    const acl = aclOf(Object.values(files));
    Object.entries(files).forEach(([k, f], i) => {
      assertLimited(acl.files[i], me, k);
      assert.equal(fs.readFileSync(f, 'utf8'), 'SECRET-' + k);
    });
    // A later plain write keeps the ACL, and so does a second writeOwnerOnly.
    fs.writeFileSync(files.wideNew, 'MORE');
    assert.equal(auth.writeOwnerOnly(files.bareNew, 'AGAIN', { fs, icacls: runIcacls }), null);
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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

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

function startOffice(dir, env) {
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the office did not start in time:\n' + out)), 30000);
    const onData = (d) => {
      out += d;
      if (/already running|is open: /.test(out) && /#n=[0-9a-f]{32}/.test(out)) { clearTimeout(t); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(t); if (!/#n=[0-9a-f]{32}/.test(out)) reject(new Error(`the office stopped (${code}):\n${out}`)); });
  });
  return { child, done, out: () => out };
}

test('route matrix, launch code and owner-only files on a real server', { timeout: 90000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-auth-')));
  if (win) wideFolder(tmp, aclOf([tmp]).me); // the same start on every machine, wherever the temp folder is
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, {
    // No claude on PATH: no paid call and a fast start. Programs from System32 come by absolute path anyway.
    PATH: [path.dirname(process.execPath), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_PORT: String(port), OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  const office = startOffice(dir, env);
  try {
    await office.done;
    const code = office.out().match(/#n=([0-9a-f]{32})/)[1];
    const agent = JSON.parse(fs.readFileSync(path.join(dir, '.office-token'), 'utf8'));
    const pagePath = auth.pageFile(env, port);
    assert.ok(pagePath.startsWith(lad), pagePath);
    const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
    assert.equal(agent.port, port);
    assert.equal(page.port, port);
    assert.match(agent.token, auth.AGENT_TOKEN_RE);
    assert.match(page.token, /^[0-9a-f]{64}$/);
    assert.notEqual(agent.token, page.token);
    // No file in the office folder holds the page token; only .office-token and the HTTP hooks file hold the agent token.
    const inFolder = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    for (const f of inFolder) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(page.token), `${f} holds the page token`);
    assert.ok(fs.readFileSync(path.join(dir, 'office-hooks-http.json'), 'utf8').includes(agent.token));

    const A = { 'content-type': 'application/json', 'x-office-token': agent.token };
    const P = { 'content-type': 'application/json', 'x-office-token': page.token };
    const frame = (r, what) => {
      assert.equal(r.headers['x-frame-options'], 'DENY', what);
      assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'", what);
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
    const second = startOffice(dir, env);
    await second.done;
    await new Promise((r) => (second.child.exitCode !== null ? r() : second.child.once('exit', r)));
    assert.equal(second.child.exitCode, 0, second.out());
    assert.match(second.out(), /already running/);
    const code3 = second.out().match(/#n=([0-9a-f]{32})/)[1];
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.office-token'), 'utf8')).token, agent.token);
    assert.equal(JSON.parse(fs.readFileSync(pagePath, 'utf8')).token, page.token);
    assert.equal((await hit(port, 'POST', '/launch', { headers: { 'content-type': 'application/json' }, body: { code: code3 } })).status, 200);

    // Limited files: only the user, SYSTEM and Administrators, compared by SID, nothing inherited, although the
    // folders hand Users, Authenticated Users and Everyone down (wideFolder above).
    if (win) {
      const files = [path.join(dir, '.office-token'), path.join(dir, 'office-hooks-http.json'), path.join(dir, 'office-hooks.json'), path.join(dir, 'office-mcp.json'), pagePath];
      const acl = aclOf(files);
      files.forEach((f, i) => assertLimited(acl.files[i], acl.me, path.basename(f)));
    }
  } finally {
    office.child.kill();
    await new Promise((r) => (office.child.exitCode !== null ? r() : office.child.once('exit', r)));
    // The server's PowerShell helper ends when its input closes; until then its folder may be in use.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
