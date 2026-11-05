// OpenClaw helpers (providers/openclaw.mjs): the Gateway liveness probe, the version check, the tool names, and the OpenClaw
// config an office session needs (#77). Pure apart from a loopback TCP connect and an injected config reader. No OpenClaw, no model.
// Run: node --test test/openclaw.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gatewayPort, probeGateway, versionAtLeast, wantedConfig, checkConfig, configReader, toolCall, PLUGIN_DIR } from '../providers/openclaw.mjs';

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

// ---------- the config an office session needs (#77): workspace-only, and the office plugin loaded and pointed at this office ----------
// The office token file. On Windows the plugin setting may spell it with other case and slashes; elsewhere a path is exact.
const TOKEN = path.join(os.tmpdir(), 'ao-office', '.office-token');
const UNIX = TOKEN.replace(/\\/g, '/');
const SPELLED = process.platform === 'win32' ? UNIX.toLowerCase() : TOKEN;
const have = (o) => async (p) => (p in o ? { state: 'set', value: o[p] } : { state: 'unset' });
const GOOD = { 'tools.fs.workspaceOnly': true, 'plugins.entries.agent-office.enabled': true, 'plugins.entries.agent-office.config.tokenFile': SPELLED };
const CALLS = ['read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets'];
const DIR = PLUGIN_DIR.replace(/\\/g, '/').replace(/\/$/, '');

test('wantedConfig: workspace-only, plugins on, the office plugin allowed, enabled and given this office\'s token file', () => {
  const w = wantedConfig({ tokenFile: TOKEN });
  assert.deepEqual(w.want.map((x) => x.path), ['tools.fs.workspaceOnly', 'plugins.enabled', 'plugins.allow', 'plugins.deny', 'plugins.entries.agent-office.enabled', 'plugins.entries.agent-office.config.tokenFile']);
  assert.deepEqual(w.want[0].rows, ['files-outside']);
  for (const x of w.want.slice(1)) assert.deepEqual(x.rows, CALLS, x.path + ': every call goes through the plugin');
  assert.deepEqual(w.gaps, [], 'the office decides every call: no cell is out of its reach');
});

test('checkConfig: a good config passes; each setting that is off names the command that fixes it', async () => {
  const w = wantedConfig({ tokenFile: TOKEN });
  const good = await checkConfig(w, have(GOOD));
  assert.equal(good.ok, true, JSON.stringify(good.settings.filter((s) => !s.ok)));
  assert.deepEqual(good.fix, []);
  assert.equal((await checkConfig(w, have({ ...GOOD, 'plugins.enabled': true, 'plugins.allow': ['agent-office', 'x'], 'plugins.deny': ['y'] }))).ok, true);

  const bad = await checkConfig(w, have({}));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.settings.filter((s) => !s.ok).map((s) => s.path), ['tools.fs.workspaceOnly', 'plugins.entries.agent-office.enabled', 'plugins.entries.agent-office.config.tokenFile']);
  assert.deepEqual(bad.fix, [
    'openclaw config set tools.fs.workspaceOnly true',
    'openclaw plugins install --link "' + DIR + '" --force',
    'openclaw config set plugins.entries.agent-office.config.tokenFile "' + UNIX + '"',
  ]);
  const off = await checkConfig(w, have({ ...GOOD, 'plugins.enabled': false, 'plugins.allow': ['x'], 'plugins.deny': ['Agent-Office'], 'plugins.entries.agent-office.enabled': false, 'plugins.entries.agent-office.config.tokenFile': 'E:/other/.office-token-4392' }));
  assert.deepEqual(off.fix, [
    'openclaw config set plugins.enabled true',
    'openclaw config set plugins.allow "[\'x\', \'agent-office\']" --strict-json',
    'openclaw config set plugins.deny "[]" --strict-json',
    'openclaw plugins enable agent-office',
    'openclaw config set plugins.entries.agent-office.config.tokenFile "' + UNIX + '"',
  ]);
});

test('checkConfig: a config the office cannot read is unknown, never a pass; an office without a token file never passes', async () => {
  const r = await checkConfig(wantedConfig({ tokenFile: TOKEN }), async () => ({ state: 'unreadable', why: 'it stopped' }));
  assert.equal(r.ok, false);
  assert.equal(r.unreadable, true);
  assert.ok(r.settings.every((s) => s.ok === false && s.have === 'unknown' && s.fix === null));
  const none = await checkConfig(wantedConfig({}), have(GOOD));
  assert.equal(none.settings.find((s) => s.path.endsWith('tokenFile')).ok, false, 'the office cannot confirm a file it does not know');
  // A token file path with a character the three shells read differently gets no command to copy.
  const odd = await checkConfig(wantedConfig({ tokenFile: 'E:\\a%b\\.office-token' }), have({}));
  assert.equal(odd.settings.find((s) => s.path.endsWith('tokenFile')).fix, null);
});

test('toolCall: OpenClaw tool ids as the tool names and inputs the office rates and shows', () => {
  const t = (name, params, paths) => { const c = toolCall(name, params, paths); return [c.tool_name, c.tool_input, c.handoff]; };
  assert.deepEqual(t('read', { path: 'src/a.js' }), ['Read', { file_path: 'src/a.js' }, null]);
  assert.deepEqual(t('write', { file_path: 'b.md', content: 'x' }), ['Write', { file_path: 'b.md' }, null], 'an edit carries only its file, like every ACP edit');
  assert.deepEqual(t('edit', { path: 'c.js', old_string: 'a', new_string: 'b' }), ['Edit', { file_path: 'c.js' }, null]);
  assert.deepEqual(t('apply_patch', { input: '*** Begin Patch' }, ['d.js']), ['Edit', { file_path: 'd.js' }, null]);
  assert.deepEqual(t('apply_patch', { input: '*** Begin Patch' }, ['d.js', 'e.js']), ['openclaw:apply_patch', { description: 'd.js, e.js' }, null], 'more than one file: no single file to rate, so it asks as an other call');
  assert.deepEqual(t('exec', { command: 'npm test' }), ['Bash', { command: 'npm test' }, null]);
  assert.deepEqual(t('bash', { command: 'ls' }), ['Bash', { command: 'ls' }, null]);
  assert.deepEqual(t('process', { action: 'kill', sessionId: 's1' }), ['Bash', { command: 'process {"action":"kill","sessionId":"s1"}' }, null]);
  assert.deepEqual(t('web_fetch', { url: 'https://example.com' }), ['WebFetch', { url: 'https://example.com' }, null]);
  assert.deepEqual(t('web_search', { query: 'acp' }), ['WebSearch', { query: 'acp' }, null]);
  assert.deepEqual(t('read', {}), ['openclaw:read', { description: '{}' }, null], 'a read with no path is not rated as a read');
  assert.deepEqual(t('Read', { path: 'a' }), ['openclaw:Read', { description: '{"path":"a"}' }, null], 'a plugin tool that borrows a core name is not that tool');
  assert.deepEqual(t('memory_search', { query: 'x' }), ['openclaw:memory_search', { description: '{"query":"x"}' }, null]);
  for (const name of ['sessions_spawn', 'sessions_send', 'subagents', 'cron', 'automations', 'gateway', 'plugins', 'nodes']) {
    assert.match(toolCall(name, {}).handoff, /outside this session/, name);
  }
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
