// OpenClaw helpers (providers/openclaw.mjs): the Gateway liveness probe, the version check, and the OpenClaw config the
// Security room rules need. Pure apart from a loopback TCP connect and an injected config reader. No OpenClaw, no model.
// Run: node --test test/openclaw.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { gatewayPort, probeGateway, versionAtLeast, wantedConfig, checkConfig, configReader, DEFAULT_CELLS } from '../providers/openclaw.mjs';

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

test('gatewayPort: 18789 unless OFFICE_OPENCLAW_PORT names another port', () => {
  assert.equal(gatewayPort({}), 18789);
  assert.equal(gatewayPort({ OFFICE_OPENCLAW_PORT: '19001' }), 19001);
  for (const bad of ['0', '70000', 'abc', '1.5', '-3', '']) assert.equal(gatewayPort({ OFFICE_OPENCLAW_PORT: bad }), 18789, bad);
});

test('probeGateway: true when something listens on the loopback port, false when nothing does', async () => {
  const srv = net.createServer((c) => c.destroy());
  const port = await listen(srv);
  assert.equal(await probeGateway({ port }), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await probeGateway({ port }), false, 'the port is closed now');
});

test('probeGateway: a connect that never finishes is false after the time limit, and the socket is destroyed', async () => {
  let destroyed = false, timer;
  const connect = () => ({ once() {}, on() {}, destroy() { destroyed = true; } });
  const p = probeGateway({ port: 1, connect, setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => {} });
  timer();
  assert.equal(await p, false);
  assert.equal(destroyed, true);
});

test('versionAtLeast: numeric, from any text that holds a version; unknown text is false', () => {
  assert.equal(versionAtLeast('2026.10.10', '2026.10.10'), true);
  assert.equal(versionAtLeast('openclaw 2026.10.11', '2026.10.10'), true);
  assert.equal(versionAtLeast('2026.11.1', '2026.10.10'), true);
  assert.equal(versionAtLeast('2026.9.30', '2026.10.10'), false, '9 is below 10, not above it as text');
  assert.equal(versionAtLeast('2026.10.9', '2026.10.10'), false);
  assert.equal(versionAtLeast('2026.10.10-beta.1', '2026.10.10'), true);
  assert.equal(versionAtLeast('unknown', '2026.10.10'), false);
  assert.equal(versionAtLeast(null, '2026.10.10'), false);
});

test('wantedConfig: workspace-only always; the shell cell sets exec approval; a Deny is a tool deny entry', () => {
  const byPath = (w) => Object.fromEntries(w.want.map((x) => [x.path, x]));
  const base = wantedConfig(DEFAULT_CELLS);
  assert.equal(byPath(base)['tools.fs.workspaceOnly'].value, true);
  assert.deepEqual(byPath(base)['tools.exec.ask'].value, 'always', 'the default shell cell is Ask');
  assert.equal(byPath(base)['tools.deny'], undefined, 'nothing is denied by default');

  const deny = wantedConfig({ ...DEFAULT_CELLS, shell: 'deny', web: 'deny', 'edit-inside': 'deny', mcp: 'deny', 'read-inside': 'deny' });
  assert.deepEqual(byPath(deny)['tools.deny'].value, ['group:runtime', 'group:web', 'write', 'edit', 'apply_patch', 'group:plugins', 'read']);
  assert.equal(byPath(deny)['tools.exec.ask'], undefined, 'a denied shell needs no approval setting');

  const allow = wantedConfig({ ...DEFAULT_CELLS, shell: 'allow' });
  assert.equal(byPath(allow)['tools.exec.ask'], undefined, 'Allow asks nothing of OpenClaw: the office answers its prompts');
});

test('wantedConfig: a cell OpenClaw config cannot carry is listed with its reason, never as enforced', () => {
  const gaps = wantedConfig(DEFAULT_CELLS).gaps;
  const rows = gaps.map((g) => `${g.row}=${g.value}`);
  assert.ok(rows.includes('web=ask'), 'OpenClaw has no approval for web tools');
  assert.ok(rows.includes('edit-inside=allow') === false, 'Allow needs no config');
  assert.ok(rows.includes('settings=ask') && rows.includes('secrets=ask'), 'config cannot rule settings or secret files');
  assert.ok(gaps.every((g) => typeof g.reason === 'string' && g.reason.length > 10));
  // the shell is carried in all three values, so it is never a gap
  for (const v of ['ask', 'allow', 'deny']) assert.equal(wantedConfig({ ...DEFAULT_CELLS, shell: v }).gaps.some((g) => g.row === 'shell'), false, v);
  // a row the caller leaves out is not a gap and not wanted
  assert.deepEqual(wantedConfig({ shell: 'ask' }).gaps, [], 'only the cells given are judged');
});

const have = (o) => async (p) => (p in o ? { state: 'set', value: o[p] } : { state: 'unset' });

test('checkConfig: reports each wanted setting as on or off, and the command that fixes an off one', async () => {
  const w = wantedConfig({ ...DEFAULT_CELLS, web: 'deny' });
  const bad = await checkConfig(w, have({}));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.settings.map((s) => [s.path, s.ok]), [['tools.fs.workspaceOnly', false], ['tools.exec.ask', false], ['tools.deny', false]]);
  assert.deepEqual(bad.fix, [
    'openclaw config set tools.fs.workspaceOnly true',
    'openclaw config set tools.exec.ask always',
    `openclaw config set tools.deny "['group:web']" --strict-json`,
  ]);
  assert.equal(bad.execAsks, false, 'exec approval is off: commands do not ask');

  const good = await checkConfig(w, have({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'on-miss', 'tools.deny': ['GROUP:WEB', 'browser'] }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.fix, []);
  assert.equal(good.execAsks, true);
});

test('checkConfig: the new exec mode counts, and a deny list keeps entries the user already has', async () => {
  const w = wantedConfig({ ...DEFAULT_CELLS, web: 'deny' });
  const r = await checkConfig(w, have({ 'tools.fs.workspaceOnly': true, 'tools.exec.mode': 'ask', 'tools.deny': ['browser'] }));
  assert.equal(r.settings.find((s) => s.path === 'tools.exec.ask').ok, true, 'mode ask is an approval');
  assert.equal(r.execAsks, true);
  assert.deepEqual(r.fix, [`openclaw config set tools.deny "['browser', 'group:web']" --strict-json`], 'the user\'s own entry stays');
});

test('checkConfig: a config the office cannot read is unknown, never a pass', async () => {
  const w = wantedConfig(DEFAULT_CELLS);
  const r = await checkConfig(w, async () => ({ state: 'unreadable', why: 'it stopped' }));
  assert.equal(r.ok, false);
  assert.equal(r.unreadable, true);
  assert.equal(r.execAsks, null, 'unknown, not "asks" and not "does not ask"');
  assert.ok(r.settings.every((s) => s.ok === false && s.have === 'unknown'));
});

// A fake execFile for the config reader: `config get <path> --json` answers by path, `config validate` by `valid`.
function fakeExec({ get = {}, valid = true } = {}) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args });
    if (args[1] === 'validate') { if (valid) cb(null, 'ok\n', ''); else { const e = new Error('invalid'); e.code = 1; cb(e, '', ''); } return; }
    const r = get[args[2]];
    if (r === undefined) { const e = new Error('spawn failed'); e.code = 'ENOENT'; cb(e, '', ''); } else if (r instanceof Error) cb(r, '', 'bad'); else cb(null, r, '');
  };
  return { calls, read: configReader({ exe: (n) => `C:/bin/${n}.exe`, execFile }) };
}
const exit1 = () => Object.assign(new Error('Command failed'), { code: 1 });

test('configReader: runs openclaw config get <path> --json by its absolute path and reads the answer', async () => {
  const { calls, read } = fakeExec({ get: { 'tools.fs.workspaceOnly': 'true\n', 'tools.deny': '["browser"]\n', 'tools.exec.ask': exit1() } });
  assert.deepEqual(await read('tools.fs.workspaceOnly'), { state: 'set', value: true });
  assert.deepEqual(await read('tools.deny'), { state: 'set', value: ['browser'] });
  assert.deepEqual(await read('tools.exec.ask'), { state: 'unset' }, 'exit 1 with a valid config is an unset key: the runtime default applies');
  assert.equal((await read('tools.exec.mode')).state, 'unreadable');
  assert.deepEqual(calls[0], { file: 'C:/bin/openclaw.exe', args: ['config', 'get', 'tools.fs.workspaceOnly', '--json'] });
  assert.equal(calls.filter((c) => c.args[1] === 'validate').length, 1, 'validate runs only after an exit 1');
});

test('configReader: exit 1 from a broken config, a crash or the wrong program is unreadable, never unset', async () => {
  const bad = fakeExec({ get: { 'tools.exec.ask': exit1() }, valid: false });
  const r = await bad.read('tools.exec.ask');
  assert.equal(r.state, 'unreadable');
  assert.match(r.why, /config validate/);
  // A program that prints text that is not JSON (a stand-in, a wrong binary).
  const text = fakeExec({ get: { 'tools.fs.workspaceOnly': 'Usage: not json\n' } });
  assert.deepEqual(await text.read('tools.fs.workspaceOnly'), { state: 'unreadable', why: 'it printed text that is not JSON' });
  // The program cannot be found at all.
  const none = configReader({ exe: () => { throw new Error('openclaw.exe is not on the PATH'); }, execFile: () => assert.fail('nothing runs') });
  assert.deepEqual(await none('tools.deny'), { state: 'unreadable', why: 'openclaw.exe is not on the PATH' });
});

test('configReader: reads that fail with exit 1 together share one validate', async () => {
  const { calls, read } = fakeExec({ get: { a: exit1(), b: exit1(), c: exit1() } });
  const out = await Promise.all(['a', 'b', 'c'].map(read));
  assert.deepEqual(out.map((x) => x.state), ['unset', 'unset', 'unset']);
  assert.equal(calls.filter((c) => c.args[1] === 'validate').length, 1);
});

test('the deny command pastes into cmd, PowerShell and bash: double quotes outside, single quotes inside, and an odd name gets none', async () => {
  const w = wantedConfig({ ...DEFAULT_CELLS, web: 'deny' });
  const odd = await checkConfig(w, have({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'always', 'tools.deny': ["it's", 'a"b'] }));
  const x = odd.settings.find((s) => s.path === 'tools.deny');
  assert.equal(x.ok, false);
  assert.equal(x.fix, null, 'a name with a quote has no command to copy; the note still names the setting');
  const ok = await checkConfig(w, have({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'always', 'tools.deny': ['group:ui'] }));
  assert.equal(ok.settings.find((s) => s.path === 'tools.deny').fix, `openclaw config set tools.deny "['group:ui', 'group:web']" --strict-json`);
});

test('checkConfig: when only one of the two exec keys cannot be read, no fix is offered for exec ask', async () => {
  const w = wantedConfig(DEFAULT_CELLS);
  const r = await checkConfig(w, async (p) => (p === 'tools.exec.mode' ? { state: 'unreadable', why: 'x' } : p === 'tools.fs.workspaceOnly' ? { state: 'set', value: true } : { state: 'unset' }));
  assert.equal(r.execAsks, null);
  assert.equal(r.settings.find((s) => s.path === 'tools.exec.ask').fix, null);
});
