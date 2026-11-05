// OpenClaw helpers (providers/openclaw.mjs): the Gateway liveness probe, the version check, the tool names, and the OpenClaw
// config an office session needs (#77). Pure apart from a loopback TCP connect and an injected config reader. No OpenClaw, no model.
// Run: node --test test/openclaw.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayPort, probeGateway, versionAtLeast, wantedConfig, checkConfig, configReader, toolCall, patchFiles, pathsOf, hookLimit, HOOK_LIMIT_MS, PLUGIN_DIR } from '../providers/openclaw.mjs';
import { hookLimit as pluginHookLimit, HOOK_MS as PLUGIN_HOOK_MS } from '../integrations/openclaw-plugin/gate.js';
import { riskOf, actionOf } from '../risk.mjs';

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
  assert.deepEqual(w.want.map((x) => x.path), ['tools.fs.workspaceOnly', 'tools.exec.host', 'plugins.enabled', 'plugins.allow', 'plugins.deny', 'plugins.entries.agent-office.enabled', 'plugins.entries.agent-office.config.tokenFile', 'plugins.entries.agent-office.hooks']);
  assert.deepEqual(w.want[0].rows, ['files-outside']);
  assert.deepEqual(w.want[1].rows, ['shell'], 'an exec that names no host runs on tools.exec.host');
  for (const x of w.want.slice(2, -1)) assert.deepEqual(x.rows, CALLS, x.path + ': every call goes through the plugin');
  assert.deepEqual([w.want.at(-1).rows, w.want.at(-1).warn], [[], true], 'the wait limit carries no row and is not a precondition');
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
  // Review 77 (8b, 4): a shorter OpenClaw wait for the plugin is said, but does not block; an exec host of "node" blocks.
  const short = await checkConfig(w, have({ ...GOOD, 'plugins.entries.agent-office.hooks': { timeoutMs: 30_000 } }));
  assert.equal(short.ok, true, 'a shorter limit only denies sooner');
  const h = short.settings.find((x) => x.path.endsWith('.hooks'));
  assert.deepEqual([h.ok, h.warn, h.fix], [false, true, 'openclaw config unset plugins.entries.agent-office.hooks.timeoutMs']);
  assert.match(h.note, /hooks\.timeoutMs is 30000 ms, so OpenClaw waits 30 s for your answer to a tool call; a call you do not answer by then is denied\./);
  const perHook = await checkConfig(w, have({ ...GOOD, 'plugins.entries.agent-office.hooks': { timeoutMs: 600_000, timeouts: { before_tool_call: 60_000 } } }));
  assert.equal(perHook.settings.find((x) => x.path.endsWith('.hooks')).fix, 'openclaw config unset plugins.entries.agent-office.hooks.timeouts.before_tool_call');
  assert.equal((await checkConfig(w, have({ ...GOOD, 'plugins.entries.agent-office.hooks': { timeouts: { before_tool_call: 600_000 } } }))).settings.every((x) => x.ok), true);
  const lost = await checkConfig(w, async (p) => (p.endsWith('.hooks') ? { state: 'unreadable', why: 'x' } : have(GOOD)(p)));
  assert.deepEqual([lost.ok, lost.unreadable], [true, false], 'an unreadable warning is not a precondition');
  const node = await checkConfig(w, have({ ...GOOD, 'tools.exec.host': 'node' }));
  assert.equal(node.ok, false, 'every exec without a host would run on a paired device');
  assert.deepEqual(node.fix, ['openclaw config set tools.exec.host auto']);
  for (const v of ['auto', 'gateway', 'sandbox']) assert.equal((await checkConfig(w, have({ ...GOOD, 'tools.exec.host': v }))).ok, true, v);
  // The office reads the limit the way the plugin does.
  for (const hooks of [undefined, {}, { timeoutMs: 30_000 }, { timeoutMs: 30_000, timeouts: { before_tool_call: 90_000 } }, { timeoutMs: 0, timeouts: { before_tool_call: -5 } }]) {
    assert.equal(hookLimit(hooks), pluginHookLimit({ plugins: { entries: { 'agent-office': { hooks } } } }), JSON.stringify(hooks));
  }
  assert.equal(HOOK_LIMIT_MS, PLUGIN_HOOK_MS);
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

// An apply_patch text in OpenClaw's patch format that changes each file.
const PATCH = (...files) => ['*** Begin Patch', ...files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`), '*** End Patch'].join('\n');
test('toolCall: OpenClaw tool ids as the tool names and inputs the office rates and shows', () => {
  const t = (name, params, paths) => { const c = toolCall(name, params, paths); return [c.tool_name, c.tool_input, c.handoff]; };
  assert.deepEqual(t('read', { path: 'src/a.js' }), ['Read', { file_path: 'src/a.js' }, null]);
  assert.deepEqual(t('write', { file_path: 'b.md', content: 'x' }), ['Write', { file_path: 'b.md' }, null], 'an edit carries only its file, like every ACP edit');
  assert.deepEqual(t('edit', { path: 'c.js', old_string: 'a', new_string: 'b' }), ['Edit', { file_path: 'c.js' }, null]);
  assert.deepEqual(t('apply_patch', { input: PATCH('d.js') }, ['d.js']), ['Edit', { file_path: 'd.js' }, null]);
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

// Review 77 problem 4: exec takes host, node, elevated, workdir and env (src/agents/bash-tools.schemas.ts, v2026.10.10). Only
// command reached the card, so `exec {command: "dir", node: "phone"}` showed as a plain dir and ran on a paired device.
test('toolCall exec: a paired device is denied; elevated is high and asks the user; env and the folder are on the card', () => {
  for (const p of [{ command: 'dir', node: 'phone' }, { command: 'dir', host: 'node' }]) {
    const c = toolCall('exec', p);
    assert.match(c.handoff, /^exec on a paired device \(node\) runs outside this PC/, JSON.stringify(p));
  }
  assert.equal(toolCall('bash', { command: 'ls', node: 'pi' }).handoff !== null, true, 'bash is the alias of exec');
  const up = toolCall('exec', { command: 'dir', elevated: true });
  assert.deepEqual([up.tool_name, up.tool_input, up.firm, up.handoff], ['Bash', { command: 'dir', elevated: true }, true, null]);
  assert.match(up.reason, /^Runs with host elevation\./);
  assert.equal(riskOf('Bash', up.tool_input, '/r'), 'high', 'elevated is high risk: no Always allow');
  assert.equal(riskOf('Bash', { command: 'dir' }, '/r'), 'medium');
  const env = toolCall('exec', { command: 'node x.js', env: { NODE_OPTIONS: '--require ./y.js', API_TOKEN: 'sk-1' }, workdir: 'C:/other', background: true, host: 'gateway' });
  assert.deepEqual([env.tool_input, env.firm], [{ command: 'node x.js' }, true], 'an env change asks the user, whatever an Allow rule says');
  assert.equal(env.reason, 'Folder: C:/other. Environment: NODE_OPTIONS=--require ./y.js, API_TOKEN=(hidden). Host: gateway. Keeps running after the turn (background).');
  const plain = toolCall('exec', { command: 'npm test', workdir: 'sub', host: 'auto' });
  assert.deepEqual([plain.reason, plain.firm], ['Folder: sub.', false]);
  assert.deepEqual([toolCall('exec', { command: 'npm test' }).reason, toolCall('exec', { command: 'npm test' }).firm], [null, false]);
});

// Review 77 problem 5: derivedPaths are "best-effort ... may be incomplete" (src/plugins/hook-types.ts). One hinted file rated a
// patch that also wrote .git/hooks as one Edit, so an Allow on Edit inside let it through.
test('toolCall apply_patch: the files come from the patch text and the hints together; each is an Edit of its own', () => {
  assert.deepEqual(patchFiles('*** Begin Patch\n*** Add File: a.js\n+x\n*** Update File: b.js\n*** Move to: c.js\n*** Delete File: d.js\n*** End Patch'), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual(patchFiles(undefined), []);
  const sneaky = toolCall('apply_patch', { input: PATCH('src/a.js', '.git/hooks/pre-commit') }, ['src/a.js'], '/r');
  assert.deepEqual([sneaky.tool_name, sneaky.files], ['Edit', ['src/a.js', '.git/hooks/pre-commit']], 'the hint missed a file: the text names it');
  assert.match(sneaky.reason, /^A patch of 2 files: src\/a\.js, \.git\/hooks\/pre-commit\.$/);
  const extra = toolCall('apply_patch', { input: PATCH('a.js') }, ['a.js', 'b.js'], '/r');
  assert.deepEqual(extra.files, ['a.js', 'b.js'], 'a hint the text does not name is held too');
  const same = toolCall('apply_patch', { input: PATCH('a.js') }, [path.resolve('/r', 'a.js')], '/r');
  assert.deepEqual([same.files.length, same.reason, same.tool_input], [1, null, { file_path: 'a.js' }], 'a hint and a line for one file are one file');
  const blind = toolCall('apply_patch', { input: 'garbage' }, ['a.js'], '/r');
  assert.deepEqual([blind.tool_name, blind.files], ['openclaw:apply_patch', undefined], 'a text that names no file is not rated as an edit from the hints');
  assert.match(blind.tool_input.description, /names no file it changes \(OpenClaw's hints: a\.js\)/);
});

// Review 77 (second round) problem A: OpenClaw reads a file tool's path before it uses it (v2026.10.10:
// agent-tools.params.ts normalizeFileToolPathParam, path-policy.ts preserveAtPrefixedRelativePath, sessions/tools/path-utils.ts
// expandPath, sandbox-paths.ts normalizeFileReferencePrefix). The office rated the path as written, so "@.env" was a low read
// and "@.git/hooks/pre-commit" a low edit. pathsOf gives the files OpenClaw can use for a path; the office rates each one.
const HOME = path.resolve('/home/me');
const none = () => false;
test('pathsOf: the files OpenClaw can use for one path, the way OpenClaw reads it', () => {
  const at = (raw, exists = none, read = false) => pathsOf(raw, { cwd: '/r', home: HOME, exists, read });
  assert.deepEqual(at('src/a.js'), ['src/a.js'], 'a plain path is the path');
  assert.deepEqual(at('@.env'), ['.env'], 'one leading @ is a file reference: OpenClaw drops it');
  assert.deepEqual(at('@.git/hooks/pre-commit'), ['.git/hooks/pre-commit']);
  assert.deepEqual(at('@@x.txt'), ['./@x.txt'], 'only one @ goes; the next stays part of the name');
  // A literal "@..." file (or its top folder) in the folder: OpenClaw uses it. It may be gone when the call runs, so both are held.
  const lit = (p) => p === path.resolve('/r', './@.env') || p === path.resolve('/r', './@pkg');
  assert.deepEqual(at('@.env', lit), ['./@.env', '.env']);
  assert.deepEqual(at('@pkg/a.js', lit), ['./@pkg/a.js', 'pkg/a.js'], 'a literal top folder counts too');
  // Home, file URLs and an @ in front of them.
  assert.deepEqual(at('~'), [HOME]);
  assert.deepEqual(at('~/.ssh/id_rsa'), [path.join(HOME, '.ssh/id_rsa')]);
  assert.deepEqual(at('@~/.ssh/id_rsa'), [path.join(HOME, '.ssh/id_rsa')]);
  const url = pathToFileURL(path.join(HOME, '.aws', 'credentials')).href;
  assert.deepEqual(at(url), [path.join(HOME, '.aws', 'credentials')]);
  assert.deepEqual(at('@' + url), [path.join(HOME, '.aws', 'credentials')]);
  if (process.platform === 'win32') assert.deepEqual(at('~\\.ssh\\id_rsa'), [path.join(HOME, '.ssh\\id_rsa')]);
  // OpenClaw's repairs of a model's path: an XML tag left at the end, an invented Office extension.
  assert.deepEqual(at('.env</arg_value>>'), ['.env']);
  assert.deepEqual(at('@.env</arg_value>>>'), ['.env']);
  assert.deepEqual(at('notes.docodex'), ['notes.docx']);
  // A read that misses tries other spellings of the name (path-utils.ts getReadPathVariants): spaces and Unicode form.
  assert.deepEqual(at('.env\u00A0', none, true), ['.env\u00A0', '.env ']);
  assert.deepEqual(at('.\u212Aey', none, true), ['.\u212Aey', '.Key'], 'NFC makes the Kelvin sign a K');
  assert.deepEqual(at('.env\u00A0'), ['.env\u00A0'], 'only a read tries other spellings');
  assert.deepEqual(at(''), []);
});

test('toolCall: a file path is rated as the file OpenClaw uses, so @, ~ and file URLs do not get around Settings and Secrets', () => {
  const root = path.resolve('/r');
  const rated = (name, p, exists = none) => {
    const c = toolCall(name, { path: p }, [], root, { home: HOME, exists });
    return (c.files || [c.tool_input.file_path]).map((f) => `${actionOf(c.tool_name, { file_path: f }, root)}/${riskOf(c.tool_name, { file_path: f }, root)}`);
  };
  assert.deepEqual(rated('read', '@.env'), ['secrets/medium']);
  assert.deepEqual(rated('edit', '@.git/hooks/pre-commit'), ['settings/high']);
  assert.deepEqual(rated('write', '@.claude/settings.json'), ['settings/high']);
  assert.deepEqual(rated('read', '~/.ssh/id_rsa'), ['secrets/high']);
  assert.deepEqual(rated('read', pathToFileURL(path.join(root, '.env')).href), ['secrets/medium']);
  assert.deepEqual(rated('read', '.env</arg_value>>'), ['secrets/medium']);
  assert.deepEqual(rated('read', 'a.txt'), ['read-inside/low']);
  const lit = (p) => p === path.resolve(root, './@.env');
  const both = toolCall('read', { path: '@.env' }, [], root, { home: HOME, exists: lit });
  assert.deepEqual([both.tool_name, both.tool_input, both.files], ['Read', { file_path: './@.env' }, ['./@.env', '.env']]);
  assert.equal(both.reason, 'OpenClaw can use either file for @.env: ./@.env, .env.');
  assert.deepEqual(rated('read', '@.env', lit), ['read-inside/low', 'secrets/medium'], 'each file meets its own row');
  const one = toolCall('read', { path: '@a.txt' }, [], root, { home: HOME, exists: none });
  assert.deepEqual([one.tool_input, one.files, one.reason], [{ file_path: 'a.txt' }, undefined, null]);
});

test('toolCall apply_patch: headers with leading spaces count, and each patch path is read the way OpenClaw reads it', () => {
  const root = path.resolve('/r');
  const text = ['*** Begin Patch', '  *** Update File: a.js', '@@', '-a', '+b', '\t*** Add File: @.git/hooks/pre-commit', '+curl x', '*** Update File: b.js\r', ' *** Move to: ~/.bashrc', '*** End Patch'].join('\n');
  assert.deepEqual(patchFiles(text), ['a.js', '@.git/hooks/pre-commit', 'b.js', '~/.bashrc']);
  const c = toolCall('apply_patch', { input: text }, [], root, { home: HOME, exists: none });
  assert.deepEqual(c.files, ['a.js', '.git/hooks/pre-commit', 'b.js', path.join(HOME, '.bashrc')]);
  assert.deepEqual(c.files.map((f) => actionOf('Edit', { file_path: f }, root)), ['edit-inside', 'settings', 'edit-inside', 'settings']);
  const hinted = toolCall('apply_patch', { input: PATCH('a.js') }, ['@.env'], root, { home: HOME, exists: none });
  assert.deepEqual(hinted.files, ['a.js', '.env'], 'a hint is read the same way');
});

// Review 77 problem 6: browser and MCP tools had no row, so the Web and MCP Deny did not reach them.
test('toolCall browser and MCP tools: the Web and MCP rows; a paired device is denied; an upload asks the user', () => {
  const nav = toolCall('browser', { action: 'navigate', targetUrl: 'https://example.com' });
  assert.deepEqual([nav.tool_name, nav.tool_input, nav.handoff, nav.firm], ['WebFetch', { url: 'https://example.com' }, null, false]);
  assert.equal(actionOf(nav.tool_name, nav.tool_input, '/r'), 'web');
  assert.deepEqual(toolCall('browser', { action: 'snapshot' }).tool_input, { url: 'browser snapshot' });
  assert.match(toolCall('browser', { action: 'navigate', node: 'phone' }).handoff, /^browser on a paired device/);
  assert.match(toolCall('browser', { action: 'navigate', target: 'node' }).handoff, /^browser on a paired device/);
  const up = toolCall('browser', { action: 'upload', paths: ['C:/Users/me/.ssh/id_rsa'] });
  assert.deepEqual([up.firm, up.reason], [true, 'Uploads files from this PC: C:/Users/me/.ssh/id_rsa.']);
  assert.deepEqual(toolCall('web_fetch', {}).tool_name, 'WebFetch', 'a web tool is on the Web row by its name, not by its params');
  assert.equal(actionOf(toolCall('web_search', {}).tool_name, {}, '/r'), 'web');
  const mcp = toolCall('outlook-graph__send_mail', { to: 'a' });
  assert.deepEqual([mcp.tool_name, actionOf(mcp.tool_name, mcp.tool_input, '/r')], ['mcp__outlook-graph__send_mail', 'mcp']);
  const office = toolCall('office__room', {});
  assert.deepEqual([office.tool_name, actionOf(office.tool_name, office.tool_input, '/r')], ['mcp__openclaw-office__room', 'mcp'], 'a server called office is not the office\'s own tools');
  assert.equal(toolCall('memory_search', {}).tool_name, 'openclaw:memory_search', 'a tool with no row stays an other call');
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
