// Paperclip as an optional HQ (#76): the address rule, what makes an agent supervised, the one PATCH of Supervise in office,
// and the watcher against a fake Paperclip (REST and the live events WebSocket, test/fixtures/fake-paperclip.mjs). No paid
// call, no real Paperclip. Run: node --test test/paperclip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE_ADAPTER, checkUrl, supervisionOf, supervisePatch, argsWhy, configWhy, runCheck, runIds, cleanIds, createHq, roleLabel, DEFAULT_URL } from '../src/paperclip.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

const HOOKS = 'C:/office/office-hooks.json';
const SUPERVISED = { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--permission-mode', 'default', '--settings', HOOKS] };
const agent = (adapterConfig, o = {}) => ({ id: 'a1', name: 'Ada', role: 'engineer', adapterType: 'claude_local', adapterConfig, ...o });

test('the address: http on 127.0.0.1 only, nothing after the port; localhost and every other host are refused', () => {
  assert.deepEqual(checkUrl('http://127.0.0.1:3100'), { ok: true, url: 'http://127.0.0.1:3100' });
  assert.deepEqual(checkUrl(' 127.0.0.1:3100/ '), { ok: true, url: 'http://127.0.0.1:3100' }, 'no scheme means http; a slash at the end is fine');
  assert.deepEqual(checkUrl('http://127.0.0.1'), { ok: true, url: 'http://127.0.0.1:80' });
  assert.equal(DEFAULT_URL, 'http://127.0.0.1:3100');
  for (const bad of ['http://localhost:3100', 'http://[::1]:3100', 'http://10.0.0.5:3100', 'http://127.0.0.2:3100', 'http://paperclip.example.com', 'http://0.0.0.0:3100',
    'https://127.0.0.1:3100', 'ws://127.0.0.1:3100', 'http://user:pw@127.0.0.1:3100', 'http://127.0.0.1:3100/api', 'http://127.0.0.1:3100/?x=1', 'http://127.0.0.1:3100/#a', '', 'http://']) {
    const r = checkUrl(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /127\.0\.0\.1/, `${bad}: the refusal says where Paperclip must run`);
  }
  assert.match(checkUrl('http://localhost:3100').error, /^localhost is not 127\.0\.0\.1\./);
});

test('supervised needs all of it: engine cli, skip permissions off, --permission-mode default and the office hooks file (#75)', () => {
  assert.deepEqual(supervisionOf(agent(SUPERVISED), HOOKS), { state: 'supervised', label: '', why: '', can: false });
  assert.equal(supervisionOf(agent({ ...SUPERVISED, extraArgs: ['--permission-mode', 'default', '--settings', 'c:\\office\\OFFICE-HOOKS.json'] }), HOOKS).state, 'supervised', 'the path in any case and slash style');
  const cases = [
    [{ cwd: 'C:/x' }, /ACP engine \(the default\), which approves every call/],              // the default since 2026.10 (spike run 1)
    [{ ...SUPERVISED, engine: 'acp' }, /acp engine/],
    [{ ...SUPERVISED, dangerouslySkipPermissions: undefined }, /Skip permissions is on/],     // the CLI engine still defaults it to true
    [{ ...SUPERVISED, extraArgs: ['--settings', HOOKS] }, /machine default \(Auto\)/],         // spike run 2: Auto asked nothing
    [{ ...SUPERVISED, extraArgs: ['--permission-mode', 'default', '--settings', HOOKS, '--permission-mode', 'acceptEdits'] }, /acceptEdits permission mode/],
    [{ ...SUPERVISED, extraArgs: ['--permission-mode', 'default'] }, /does not load the office hooks file/],
    [{ ...SUPERVISED, extraArgs: [...SUPERVISED.extraArgs, '--dangerously-skip-permissions'] }, /skips permissions/],
    [{ ...SUPERVISED, extraArgs: [...SUPERVISED.extraArgs, '--permission-prompt-tool', 'mcp__x__ok'] }, /Its own tool answers/],
  ];
  for (const [cfg, why] of cases) {
    const s = supervisionOf(agent(cfg), HOOKS);
    assert.deepEqual([s.state, s.label, s.can], ['unsupervised', 'Unsupervised', true], JSON.stringify(cfg));
    assert.match(s.why, why);
  }
  // args, the older key, counts when extraArgs is empty (execute.ts reads extraArgs, then args)
  assert.equal(supervisionOf(agent({ engine: 'cli', dangerouslySkipPermissions: false, extraArgs: [], args: ['--permission-mode', 'default', '--settings', HOOKS] }), HOOKS).state, 'supervised');
  assert.equal(configWhy(SUPERVISED, HOOKS), '');
  assert.equal(argsWhy(['--settings=' + HOOKS, '--permission-mode=default'], HOOKS), '', 'the = spelling too');
});

test('an agent that runs no Claude Code, a hidden config, a model profile, an issue override or a last run that skipped the office is not supervised', () => {
  const codex = supervisionOf({ id: 'x', adapterType: 'codex_local', adapterConfig: {} }, HOOKS);
  assert.deepEqual([codex.state, codex.label, codex.can], ['unsupervised', 'Unsupervised: runs without the office hooks', false]);
  assert.match(codex.why, /codex_local, not Claude Code/);
  assert.deepEqual([supervisionOf(agent(undefined), HOOKS).state, supervisionOf(agent(undefined), HOOKS).can], ['unknown', false]);
  const prof = supervisionOf(agent(SUPERVISED, { runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { engine: 'acp' } }, off: { enabled: false, adapterConfig: { dangerouslySkipPermissions: true } } } } }), HOOKS);
  assert.deepEqual([prof.state, prof.can], ['partly', false]);
  assert.match(prof.why, /cheap model profile: It runs on the acp engine/);
  const iss = supervisionOf(agent(SUPERVISED), HOOKS, { issues: [{ id: 'i', identifier: 'ACM-7', assigneeAgentId: 'a1', assigneeAdapterOverrides: { adapterConfig: { dangerouslySkipPermissions: true } } }] });
  assert.deepEqual([iss.state, iss.label], ['partly', 'Partly supervised: an issue skips the office']);
  assert.match(iss.why, /^For ACM-7: Skip permissions is on/);
  const last = supervisionOf(agent(SUPERVISED), HOOKS, { lastRun: { ok: false, why: 'It skips permissions (--dangerously-skip-permissions).' } });
  assert.deepEqual([last.state, last.can], ['unsupervised', false], 'the patch would change nothing, so it is not offered');
});

test('Supervise in office is one patch: engine cli, skip permissions off, the agent\'s own arguments kept, mode and hooks at the end', () => {
  const p = supervisePatch(agent({ cwd: 'C:/x', model: 'haiku', dangerouslySkipPermissions: true, extraArgs: ['--max-turns', '8', '--dangerously-skip-permissions', '--permission-mode', 'auto', '--settings', 'C:/mine.json', '--settings', HOOKS, '--permission-prompt-tool', 'mcp__a__b'] }), HOOKS);
  assert.deepEqual(p, { adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--max-turns', '8', '--settings', 'C:/mine.json', '--permission-mode', 'default', '--settings', HOOKS] } });
  assert.deepEqual(Object.keys(p), ['adapterConfig'], 'only the adapter config: Paperclip merges it with the rest (cwd, model stay)');
  assert.deepEqual(supervisePatch(agent({ args: ['--verbose'] }), HOOKS).adapterConfig.extraArgs, ['--verbose', '--permission-mode', 'default', '--settings', HOOKS], 'the older args key is carried over');
  assert.equal(supervisionOf(agent({ cwd: 'C:/x', ...p.adapterConfig }), HOOKS).state, 'supervised', 'the patched config is supervised');
});

// Review 76, finding 1: flags that let a run approve its own calls, or turn the hooks off, from `claude --help` and the hidden
// options of Claude Code 2.1.318. --allowedTools is what Paperclip itself passes on a sandbox target instead of
// --dangerously-skip-permissions (packages/adapters/claude-local/src/server/permissions.ts).
test('a flag that approves calls by itself or turns off the hooks is never supervised, and Supervise takes it out with its values', () => {
  const ok = SUPERVISED.extraArgs;
  const cases = [
    [['--allowedTools', 'Bash(*) Edit'], /^It allows tools without asking \(--allowedTools\)/],
    [['--allowed-tools', 'Bash', 'Edit'], /\(--allowed-tools\)/],
    [['--allowedTools=Bash'], /\(--allowedTools\)/],
    [['--allowed-tools=Edit,Write'], /\(--allowed-tools\)/],
    [['--dangerously-skip-permissions'], /skips permissions/],
    [['--permission-prompt-tool=mcp__x__ok'], /Its own tool answers/],
    [['--allow-dangerously-skip-permissions'], /\(--allow-dangerously-skip-permissions\)/],
    [['--managed-settings', '{"permissions":{"allow":["Bash"]}}'], /policy settings \(--managed-settings\)/],
    [['--bare'], /\(--bare\).*office hooks do not run/],
    [['--safe-mode'], /\(--safe-mode\).*office hooks do not run/],
  ];
  for (const [extra, why] of cases) {
    for (const args of [[...ok, ...extra], [...extra, ...ok]]) {
      const s = supervisionOf(agent({ ...SUPERVISED, extraArgs: args }), HOOKS);
      assert.deepEqual([s.state, s.label, s.can], ['unsupervised', 'Unsupervised', true], args.join(' '));
      assert.match(s.why, why, args.join(' '));
      assert.match(argsWhy(['--print', '-', '--add-dir', 'C:/b', ...args], HOOKS), why, `the run line too: ${args.join(' ')}`);
      const patched = supervisePatch(agent({ ...SUPERVISED, extraArgs: args }), HOOKS).adapterConfig;
      assert.equal(configWhy(patched, HOOKS), '', `the patch takes it out: ${patched.extraArgs.join(' ')}`);
    }
  }
  // the values go with the flag, the way Claude Code reads them: a list takes every next argument up to the next flag
  assert.deepEqual(supervisePatch(agent({ extraArgs: ['--allowedTools', 'Bash(git *)', 'Edit', '--max-turns', '8', '--allowed-tools=Write', 'kept', '--managed-settings', '{}', '--bare', '--verbose', '--safe-mode', '--allow-dangerously-skip-permissions'] }), HOOKS).adapterConfig.extraArgs,
    ['--max-turns', '8', 'kept', '--verbose', '--permission-mode', 'default', '--settings', HOOKS], 'an = spelling takes no more than its own value');
  assert.deepEqual(supervisePatch(agent({ extraArgs: ['--allowedTools', '--verbose', 'Edit', '--max-turns', '3'] }), HOOKS).adapterConfig.extraArgs, ['--max-turns', '3', '--permission-mode', 'default', '--settings', HOOKS], 'the first value is taken whatever it looks like');
  // Paperclip's own run line on a sandbox target
  assert.match(argsWhy(['--print', '-', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Task Bash(*) Edit Write', '--add-dir', 'C:/b', ...ok], HOOKS), /allows tools without asking/);
  // --disallowedTools only takes tools away: it stays, and it is no --allowedTools
  assert.equal(argsWhy([...ok, '--disallowedTools', 'Bash', '--disallowed-tools=WebFetch'], HOOKS), '');
  assert.deepEqual(supervisePatch(agent({ extraArgs: ['--disallowedTools', 'Bash', 'Edit'] }), HOOKS).adapterConfig.extraArgs, ['--disallowedTools', 'Bash', 'Edit', '--permission-mode', 'default', '--settings', HOOKS]);
  // manual is the name Claude Code 2.1 shows for the default mode (it reads manual as default)
  assert.equal(argsWhy(['--permission-mode', 'manual', '--settings', HOOKS], HOOKS), '');
});

// Review 76, finding 2: Claude Code keeps the last value of a repeated --settings (one settings file), as for --permission-mode.
test('only the last --settings counts: an office hooks file that a later --settings replaces is not loaded', () => {
  const s = supervisionOf(agent({ ...SUPERVISED, extraArgs: ['--permission-mode', 'default', '--settings', HOOKS, '--settings', 'C:/mine.json'] }), HOOKS);
  assert.deepEqual([s.state, s.can], ['unsupervised', true]);
  assert.match(s.why, /^Claude Code loads only the last --settings, and that is not the office hooks file\./);
  assert.match(argsWhy(['--settings', HOOKS, '--permission-mode', 'default', '--settings={"hooks":{}}'], HOOKS), /only the last --settings/, 'a JSON text is a --settings too');
  assert.equal(argsWhy(['--settings', 'C:/mine.json', '--permission-mode', 'default', '--settings', HOOKS], HOOKS), '', 'an earlier one is not loaded, so it changes nothing');
  assert.match(argsWhy(['--permission-mode', 'default', '--settings', 'C:/mine.json'], HOOKS), /does not load the office hooks file/);
  const p = supervisePatch(agent({ ...SUPERVISED, extraArgs: ['--settings', HOOKS, '--settings', 'C:/mine.json'] }), HOOKS).adapterConfig;
  assert.deepEqual(p.extraArgs, ['--settings', 'C:/mine.json', '--permission-mode', 'default', '--settings', HOOKS]);
  assert.equal(configWhy(p, HOOKS), '');
});

// Review 76, finding 3: Paperclip starts adapterConfig.command (default claude, execute.ts). Another program may or may not
// pass the calls on to Claude Code with the office hooks: the office cannot tell.
test('the program a run starts: unset or claude is supervised, any other program is Partly supervised with the reason', () => {
  for (const command of [undefined, '', 'claude', 'CLAUDE', 'claude.exe']) {
    assert.equal(supervisionOf(agent({ ...SUPERVISED, command }), HOOKS).state, 'supervised', String(command));
  }
  for (const command of ['C:\\Users\\a\\.local\\bin\\claude.exe', 'C:/Users/a/.local/bin/Claude.EXE', '/usr/local/bin/claude', 'C:/tools/claude-wrap.cmd', 'node', 'claude.cmd', 'C:/x/claude.exe.bak', 'C:/claude/run.exe', 'claude --bare']) {
    const s = supervisionOf(agent({ ...SUPERVISED, command }), HOOKS);
    assert.deepEqual([s.state, s.label, s.can], ['partly', 'Partly supervised: it starts another program', false], command);
    assert.equal(s.why, `It starts ${command}, not claude. The office cannot tell if that program uses the office hooks.`);
  }
  const prof = supervisionOf(agent(SUPERVISED, { runtimeConfig: { modelProfiles: { wrap: { adapterConfig: { command: 'C:/w.cmd' } } } } }), HOOKS);
  assert.deepEqual([prof.state, prof.can], ['partly', false]);
  assert.match(prof.why, /^With the wrap model profile: It starts C:\/w\.cmd, not claude\./);
  const iss = supervisionOf(agent(SUPERVISED), HOOKS, { issues: [{ id: 'i', identifier: 'ACM-9', assigneeAgentId: 'a1', assigneeAdapterOverrides: { adapterConfig: { command: 'C:/w.cmd' } } }] });
  assert.match(iss.why, /^For ACM-9: It starts C:\/w\.cmd/);
  // an agent that also lacks the settings: Supervise is offered, and the patch leaves the program as it is
  assert.deepEqual([supervisionOf(agent({ cwd: 'C:/x', command: 'C:/w.cmd' }), HOOKS).state, supervisionOf(agent({ cwd: 'C:/x', command: 'C:/w.cmd' }), HOOKS).can], ['unsupervised', true]);
  assert.equal('command' in supervisePatch(agent({ command: 'C:/w.cmd' }), HOOKS).adapterConfig, false);
});

// Review 76, round 2, hole 1: flags of Claude Code 2.1.318 (its binary) that load plugins, agents or settings, or let
// something else than the office answer a call. The office cannot read what they load, and taking them out would change
// what the agent does, so Supervise leaves them and the agent is Partly supervised.
test('a flag that loads plugins, agents or settings, or lets something else answer, is Partly supervised, and Supervise leaves it', () => {
  const ok = SUPERVISED.extraArgs;
  const cases = [
    [['--plugin-dir', 'C:/p'], /^It loads plugins \(--plugin-dir\), and a plugin hook can allow a call without the office\.$/],
    [['--plugin-dir-no-mcp', 'C:/p'], /\(--plugin-dir-no-mcp\)/],
    [['--plugin-url=https://example.com/p.zip'], /\(--plugin-url\)/],
    [['--await-initialize'], /^It loads plugins \(--await-initialize\)/],
    [['--agents', '{"r":{"description":"d","prompt":"p","permissionMode":"bypassPermissions"}}'], /^It loads agents \(--agents\), and an agent can set its own permission mode and hooks\.$/],
    [['--agent', 'reviewer'], /\(--agent\)/],
    [['--agent-type', 'helper'], /\(--agent-type\)/],
    [['--setting-sources', 'user'], /^It changes which settings load \(--setting-sources\)/],
    [['--project-config-root', 'C:/other'], /\(--project-config-root\)/],
    [['--client-data-url', 'https://example.com/d'], /\(--client-data-url\)/],
    [['--sdk-url', 'ws://127.0.0.1:9'], /^It connects to an SDK host \(--sdk-url\), which can answer permission prompts\.$/],
    [['--await-claim'], /\(--await-claim\)/],
    [['--remote-control'], /^It turns on Remote Control \(--remote-control\)/],
    [['--rc', 'me'], /\(--rc\)/],
    [['--channels', 'a', 'b'], /^It registers channel servers \(--channels\)/],
    [['--dangerously-load-development-channels', 'a'], /\(--dangerously-load-development-channels\)/],
    [['--teleport'], /\(--teleport\)/],
    [['--chrome'], /^It turns on Claude in Chrome \(--chrome\)/],
  ];
  for (const [extra, why] of cases) {
    for (const args of [[...ok, ...extra], [...extra, ...ok]]) {
      const s = supervisionOf(agent({ ...SUPERVISED, extraArgs: args }), HOOKS);
      assert.deepEqual([s.state, s.label, s.can], ['partly', 'Partly supervised: it loads what the office cannot check', false], args.join(' '));
      assert.match(s.why, why, args.join(' '));
      const run = runCheck('claude', ['--print', '-', '--add-dir', 'C:/b', ...args], HOOKS);
      assert.deepEqual([run.ok, run.partly], [false, true], `the run line too: ${args.join(' ')}`);
      assert.match(run.why, why);
    }
    // Supervise leaves it: an agent that also lacks the settings is set up, and then shows Partly supervised
    const before = agent({ cwd: 'C:/x', extraArgs: extra });
    assert.deepEqual([supervisionOf(before, HOOKS).state, supervisionOf(before, HOOKS).can], ['unsupervised', true]);
    const p = supervisePatch(before, HOOKS).adapterConfig;
    assert.deepEqual(p.extraArgs, [...extra, '--permission-mode', 'default', '--settings', HOOKS]);
    assert.equal(supervisionOf(agent({ cwd: 'C:/x', ...p }), HOOKS).state, 'partly');
  }
  // a cloud session runs its calls in the cloud: Unsupervised, and Supervise does not move it here
  for (const extra of [['--cloud'], ['--cloud', 'fix the bug'], ['--remote', 'x'], ['--environment', 'ccpool_1'], ['--pool', 'p'], ['--attach-serve', 's1']]) {
    const s = supervisionOf(agent({ ...SUPERVISED, extraArgs: [...ok, ...extra] }), HOOKS);
    assert.deepEqual([s.state, s.can], ['unsupervised', false], extra.join(' '));
    assert.match(s.why, new RegExp(`^It runs its session in the cloud \\(${extra[0]}\\), so its calls never reach the office hooks\\. Supervise in office does not change that: change it in Paperclip\\.$`));
    assert.equal(supervisionOf(agent({ cwd: 'C:/x', extraArgs: extra }), HOOKS).can, false, 'not offered: it would not help');
    assert.match(runCheck('claude', [...ok, ...extra], HOOKS).why, /in the cloud/);
  }
});

// Review 76, round 2, hole 2: the env of the run. The office reads the key names, never a value, and never writes env.
test('the env of an agent: by key name only, a key that turns off hooks or permissions is Unsupervised and Supervise is not offered', () => {
  const OFF = ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_PERSONAL_HOOKS_OFF', 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
    'CLAUDE_BG_SESSION_PERMISSION_RULES', 'CLAUDE_CODE_REMOTE_TOOLS_HOST_ALLOWS_UNATTENDED', 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'];
  for (const key of [...OFF, 'claude_code_simple']) {
    // values are never read: every value throws when it is read
    const env = new Proxy({ [key]: '0', PATH: 'x' }, { get(t, k) { if (typeof k === 'string' && Object.hasOwn(t, k)) throw new Error(`the office read the value of ${k}`); return undefined; } });
    const s = supervisionOf(agent({ ...SUPERVISED, env }), HOOKS);
    assert.deepEqual([s.state, s.label, s.can], ['unsupervised', 'Unsupervised: its env turns off the office', false], key);
    assert.match(s.why, new RegExp(`^Its env has ${key.toUpperCase()}, which [^.]+\\. Supervise in office does not change env: change it in Paperclip\\.$`));
    assert.equal(supervisionOf(agent({ cwd: 'C:/x', env }), HOOKS).can, false, `${key}: Supervise would not help`);
    assert.equal('env' in supervisePatch(agent({ cwd: 'C:/x', env }), HOOKS).adapterConfig, false, 'the patch never carries env');
    assert.match(runCheck('claude', ok(), HOOKS, [key, 'PATH']).why, new RegExp(`^Its env has ${key.toUpperCase()}`), 'the env of the run line too');
  }
  // a key that loads plugins or other settings: Partly supervised
  for (const key of ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CHROME_PERMISSION_MODE', 'CLAUDE_CODE_DISABLE_HOOK_FORWARDING']) {
    const s = supervisionOf(agent({ ...SUPERVISED, env: { [key]: 'x' } }), HOOKS);
    assert.deepEqual([s.state, s.label, s.can], ['partly', 'Partly supervised: its env loads what the office cannot check', false], key);
    assert.match(s.why, new RegExp(`^Its env has ${key}, which `));
    assert.deepEqual([runCheck('claude', ok(), HOOKS, [key]).ok, runCheck('claude', ok(), HOOKS, [key]).partly], [false, true]);
  }
  // other keys change nothing; the env of an issue override counts like the rest of the override
  assert.equal(supervisionOf(agent({ ...SUPERVISED, env: { ANTHROPIC_API_KEY: 'x', CLAUDE_CONFIG_DIR: 'C:/c', PAPERCLIP_API_KEY: 'y' } }), HOOKS).state, 'supervised');
  const iss = supervisionOf(agent(SUPERVISED), HOOKS, { issues: [{ id: 'i', identifier: 'ACM-3', assigneeAgentId: 'a1', assigneeAdapterOverrides: { adapterConfig: { env: { CLAUDE_CODE_SIMPLE: '1' } } } }] });
  assert.deepEqual([iss.state, iss.can], ['partly', false]);
  assert.match(iss.why, /^For ACM-3: Its env has CLAUDE_CODE_SIMPLE/);
  function ok() { return ['--print', '-', ...SUPERVISED.extraArgs]; }
});

// Review 76, round 2, hole 3: the arguments are read the way Claude Code's parser (commander) reads them, with the value
// count of each of its flags (from the 2.1.318 binary). A flag the office does not know is not guessed at.
test('the arguments are read with the value count of each Claude Code flag: a flag inside a value is text, an unknown flag is Partly supervised', () => {
  const ok = SUPERVISED.extraArgs;
  // a flag that takes a value takes the next argument, whatever it looks like
  assert.match(argsWhy(['--append-system-prompt', '--permission-mode', 'default', '--settings', HOOKS], HOOKS), /does not set --permission-mode default/);
  assert.match(argsWhy(['--permission-mode', 'default', '--system-prompt', '--settings', HOOKS], HOOKS), /does not load the office hooks file/);
  assert.equal(argsWhy([...ok, '--append-system-prompt', '--dangerously-skip-permissions'], HOOKS), '', 'a value that looks like a flag is text');
  assert.equal(supervisionOf(agent({ ...SUPERVISED, extraArgs: [...ok, '--model', '--bare'] }), HOOKS).state, 'supervised');
  // a list takes each next argument up to a flag; an optional value only when the next argument is no flag
  assert.equal(argsWhy(['--add-dir', 'C:/a', 'C:/b', ...ok], HOOKS), '');
  assert.equal(argsWhy(['--resume', ...ok], HOOKS), '');
  assert.equal(argsWhy(['-r', 'abc', ...ok, '-w'], HOOKS), '');
  // short flags together (-pc), and a short flag with its value in the same argument (-nName)
  assert.equal(argsWhy(['-pc', '-nName', '-d2e', ...ok], HOOKS), '');
  // after -- every argument is text
  assert.match(argsWhy(['--', ...ok], HOOKS), /does not set --permission-mode default/);
  // a flag the office does not know: it cannot tell which arguments are its values
  for (const x of [['--made-up', 'x'], ['--made-up=x'], ['-x'], ['-px'], ['--verbose=1'], ['--tmux=classic']]) {
    const s = supervisionOf(agent({ ...SUPERVISED, extraArgs: [...ok, ...x] }), HOOKS);
    assert.deepEqual([s.state, s.label, s.can], ['partly', 'Partly supervised: it passes a flag the office does not know', false], x.join(' '));
    assert.match(s.why, /^It passes -[^ ]*, which is not a flag of Claude Code 2\.1\.318, so the office cannot tell which arguments are its values\.$/, x.join(' '));
    assert.deepEqual(supervisePatch(agent({ extraArgs: x }), HOOKS).adapterConfig.extraArgs, [...x, '--permission-mode', 'default', '--settings', HOOKS], 'the patch keeps it');
  }
  // Paperclip's own run line has only flags the office knows
  assert.deepEqual(runCheck('claude.exe', ['--print', '-', '--output-format', 'stream-json', '--verbose', '--resume', 's1', '--model', 'haiku', '--effort', 'high', '--max-turns', '8',
    '--append-system-prompt-file', 'C:/i.md', '--add-dir', 'C:/b', ...ok], HOOKS), { ok: true, why: '', partly: false, kind: '' });
  // Supervise puts the office settings before a --, where Claude Code still reads them as flags
  const p = supervisePatch(agent({ extraArgs: ['--verbose', '--', 'some text'] }), HOOKS).adapterConfig;
  assert.deepEqual(p.extraArgs, ['--verbose', '--permission-mode', 'default', '--settings', HOOKS, '--', 'some text']);
  assert.equal(configWhy(p, HOOKS), '');
});

test('the ids of a Paperclip run come from its environment and are plain ids only', () => {
  assert.deepEqual(runIds({ PAPERCLIP_AGENT_ID: 'a-1', PAPERCLIP_COMPANY_ID: 'c-1', PAPERCLIP_RUN_ID: 'r_1', PAPERCLIP_TASK_ID: 't1', PATH: 'x' }), { agent: 'a-1', company: 'c-1', run: 'r_1', task: 't1' });
  assert.equal(runIds({ PATH: 'x' }), null, 'not a Paperclip run');
  assert.equal(runIds({ PAPERCLIP_AGENT_ID: 'a-1' }), null, 'an agent needs its company');
  assert.deepEqual(cleanIds({ agent: 'a', company: 'c', run: '../../x', task: 'x'.repeat(81), other: 'y' }), { agent: 'a', company: 'c' });
  assert.equal(cleanIds('a'), null);
  assert.equal(roleLabel('ceo'), 'CEO');
  assert.equal(roleLabel('wizard'), 'Wizard');
});

const fast = { refetchMs: 20, retryMs: [50, 50] };

test('the watcher: one company read over REST, budgets, tasks, heartbeats and routines; live events move the agents', async () => {
  const pc = await startFakePaperclip();
  const feed = [], ended = [];
  let changes = 0;
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onChange: () => changes++, onFeed: (t) => feed.push(t), onRun: (r) => ended.push(r) });
  try {
    const r = await hq.connect({ url: pc.url });
    assert.deepEqual(r, { ok: true, url: pc.url, company: DEMO().companies[0].id });
    await until(() => hq.state() === 'on', 'the events socket');
    const v = hq.view();
    assert.equal(v.company.name, 'Acme Robotics');
    assert.deepEqual(v.budget, { spent: 12.4, limit: 100 }, 'the company budget for its runs, in dollars');
    const [grace, ada, linus] = v.agents;
    assert.deepEqual([grace.name, grace.role, grace.supervision.state, grace.supervision.can], ['Grace', 'CEO', 'unsupervised', true]);
    assert.deepEqual(grace.heartbeat, { on: true, every: 1800, last: Date.parse('2026-11-05T08:30:00.000Z') }, 'its heartbeat, shown, never run');
    assert.deepEqual([ada.title, ada.task.identifier, ada.task.title, ada.budget], ['Backend engineer', 'ACM-12', 'Add a health route to the API', { spent: 8.3, limit: 50 }]);
    assert.deepEqual([linus.kind, linus.supervision.label, linus.run], ['codex_local', 'Unsupervised: runs without the office hooks', { id: 'run-linus-1', status: 'running' }], 'an agent kind with no Claude Code hooks shows, from its live run');
    assert.deepEqual(v.routines.map((x) => [x.title, x.agent, x.cron, x.next]), [['Weekly status report', 'Grace', '0 9 * * 1', Date.parse('2026-11-10T09:00:00.000Z')]]);

    // live events: a run of Ada starts, then ends; the agent's status changes
    pc.emit('heartbeat.run.queued', { runId: 'run-ada-1', agentId: ada.id, invocationSource: 'assignment', triggerDetail: null, wakeupRequestId: null });
    await until(() => hq.view().agents[1].run?.status === 'queued', 'the queued run');
    pc.emit('heartbeat.run.status', { runId: 'run-ada-1', agentId: ada.id, status: 'running', invocationSource: 'assignment', error: null });
    pc.state.agents[1].status = 'running';   // Paperclip saves the status it sends
    pc.emit('agent.status', { agentId: ada.id, status: 'running', outcome: 'running' });
    await until(() => hq.view().agents[1].status === 'running' && hq.view().agents[1].run.status === 'running', 'the running run');
    // an event of another company is not this company's
    pc.emit('agent.status', { agentId: ada.id, status: 'error' }, 'another-company');
    pc.state.agents[1].spentMonthlyCents = 905;
    pc.emit('heartbeat.run.status', { runId: 'run-ada-1', agentId: ada.id, status: 'succeeded', error: null });
    await until(() => hq.view().agents[1].budget.spent === 9.05, 'the budget read again when the run ends');
    assert.equal(hq.view().agents[1].status, 'running');
    assert.deepEqual(ended, [{ agentId: ada.id, runId: 'run-ada-1', status: 'succeeded' }]);

    // the command line of a run: a run that skips the office is named in the feed, and the agent shows it
    pc.emit('heartbeat.run.event', { runId: 'run-grace-1', agentId: grace.id, seq: 1, eventType: 'adapter.invoke', stream: 'system', message: 'adapter invocation', payload: { adapterType: 'claude_local', command: 'claude', commandArgs: ['--print', '-', '--dangerously-skip-permissions'] } });
    await until(() => feed.length, 'the feed line');
    assert.match(feed[0], /^Paperclip started a run of Grace without the office: It skips permissions/);

    // the labels of a run's office session: by the hook ids, only for an agent of the watched company
    assert.deepEqual(hq.labelOf({ agent: ada.id, company: v.company.id, run: 'run-ada-2' }), { agent: 'Ada', role: 'Backend engineer', company: 'Acme Robotics', task: 'ACM-12 Add a health route to the API', budget: { spent: 9.05, limit: 50 }, run: 'run-ada-2' });
    assert.equal(hq.labelOf({ agent: ada.id, company: 'other' }), null);
    assert.equal(hq.labelOf({ agent: 'nobody', company: v.company.id }), null);
    assert.ok(changes > 3);

    // watch only: every request was a read (and the one socket); nothing drove Paperclip
    assert.deepEqual([...new Set(pc.requests.map((q) => q.method))].sort(), ['GET', 'UPGRADE']);
    assert.ok(pc.requests.some((q) => q.path === '/api/companies/' + v.company.id + '/agents' && q.query === ''), 'the agents route takes no query (Paperclip answers 400 to one)');
  } finally { hq.disconnect(); await pc.close(); }
});

test('the stream drops: the watcher says so and connects again; disconnect stops everything', async () => {
  const pc = await startFakePaperclip();
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on' && pc.sockets() === 1, 'the first socket');
    pc.drop();
    await until(() => hq.state() === 'lost', 'lost');
    assert.match(hq.view().error, /live events of Paperclip stopped/);
    await until(() => hq.state() === 'on' && pc.sockets() === 1, 'the second socket');
    hq.disconnect();
    assert.equal(hq.view(), null);
    await until(() => pc.sockets() === 0, 'the socket closed');
  } finally { hq.disconnect(); await pc.close(); }
});

test('Supervise in office sends one PATCH with the whole change, and the agent shows Unsupervised until Paperclip saved it', async () => {
  const pc = await startFakePaperclip();
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    const ada = hq.view().agents.find((a) => a.name === 'Ada');
    assert.deepEqual([ada.supervision.state, ada.supervision.can], ['unsupervised', true]);
    const r = await hq.supervise(ada.id);
    assert.deepEqual([r.ok, r.supervision.state], [true, 'supervised']);
    const writes = pc.requests.filter((q) => q.method !== 'GET' && q.method !== 'UPGRADE');
    assert.equal(writes.length, 1, 'one request that writes');
    assert.deepEqual(writes[0], { method: 'PATCH', path: `/api/agents/${ada.id}`, query: '', body: { adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--max-turns', '8', '--permission-mode', 'default', '--settings', HOOKS] } } });
    assert.deepEqual(pc.state.agents[1].adapterConfig, { cwd: 'C:/work/acme', model: 'haiku', engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--max-turns', '8', '--permission-mode', 'default', '--settings', HOOKS] }, 'Paperclip kept the rest of the config');
    assert.equal(hq.view().agents.find((a) => a.name === 'Ada').supervision.state, 'supervised');
    assert.match(feed.at(-1), /^Supervise in office: Ada now runs Claude Code with the office hooks/);
    // again: nothing to send
    assert.equal((await hq.supervise(ada.id)).already, true);
    // an agent the office cannot set up, and one that does not exist
    const linus = hq.view().agents.find((a) => a.name === 'Linus');
    await assert.rejects(hq.supervise(linus.id), (e) => e.status === 409 && /codex_local, not Claude Code/.test(e.message));
    await assert.rejects(hq.supervise('nobody'), (e) => e.status === 404);
    assert.equal(pc.requests.filter((q) => q.method === 'PATCH').length, 1, 'still one PATCH');
  } finally { hq.disconnect(); await pc.close(); }
});

// Review 76, finding 4: the PATCH replaces extraArgs whole, so it is built from the agent as Paperclip has it at the click.
test('Supervise in office reads the agent again just before its PATCH, so a change made in Paperclip since the last read is kept', async () => {
  const pc = await startFakePaperclip();
  const feed = [];
  // #144: the socket opening starts one background read after refetchMs. Its requests would interleave with the click's
  // GET and PATCH (the old wait only saw its first request, not its end). A long refetchMs means no background read runs,
  // so the requests after n are only the click's, in order.
  const hq = createHq({ ...fast, refetchMs: 600000, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on' && pc.sockets() === 1, 'the socket opened', { ms: 5000 });
    const [grace, ada] = hq.view().agents;
    // the user changes Ada in Paperclip, and no event tells the office before the click
    pc.state.agents[1].adapterConfig.extraArgs = ['--max-turns', '12', '--settings', 'C:/mine.json', '--allowedTools', 'Bash'];
    const n = pc.requests.length;
    const r = await hq.supervise(ada.id);
    assert.equal(r.ok, true);
    assert.deepEqual(pc.requests.slice(n, n + 2).map((q) => [q.method, q.path]), [['GET', `/api/agents/${ada.id}`], ['PATCH', `/api/agents/${ada.id}`]], 'the read comes right before the change');
    assert.deepEqual(pc.requests[n + 1].body.adapterConfig.extraArgs, ['--max-turns', '12', '--settings', 'C:/mine.json', '--permission-mode', 'default', '--settings', HOOKS], 'the new arguments are kept, --allowedTools goes');
    assert.match(feed.at(-1), /^Supervise in office: Ada now runs Claude Code with the office hooks\. Its next run asks here\. Its own --settings C:\/mine\.json no longer loads: Claude Code loads only the last --settings\.$/);
    // Grace was set up by hand in Paperclip before the click: nothing to send
    pc.state.agents[0].adapterConfig = { cwd: 'C:/work/acme', ...SUPERVISED };
    const again = await hq.supervise(grace.id);
    assert.deepEqual([again.already, again.supervision.state], [true, 'supervised']);
    assert.equal(hq.view().agents[0].supervision.state, 'supervised', 'the office shows what it read');
    // moved to another adapter in Paperclip before the click: refused with the reason, nothing sent
    pc.state.agents[1].adapterType = 'codex_local';
    await assert.rejects(hq.supervise(ada.id), (e) => e.status === 409 && /codex_local, not Claude Code/.test(e.message));
    assert.equal(pc.requests.filter((q) => q.method === 'PATCH').length, 1, 'one PATCH in all');
  } finally { hq.disconnect(); await pc.close(); }
});

// Review 76, round 2, hole 4: Paperclip's PATCH has no version check, so a change saved in Paperclip at the same moment can
// replace what the office sent. The office reads the agent once more after its PATCH and shows what that read says.
test('after its PATCH, Supervise reads the agent again: other saved arguments than it sent are named in the feed, and the agent shows the read', async () => {
  const pc = await startFakePaperclip();
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    const ada = hq.view().agents.find((a) => a.name === 'Ada');
    pc.afterPatch = (a) => { a.adapterConfig = { ...a.adapterConfig, extraArgs: ['--max-turns', '8', '--allowedTools', 'Bash'] }; };
    const n = pc.requests.length;
    const r = await hq.supervise(ada.id);
    const route = `/api/agents/${ada.id}`;
    assert.deepEqual(pc.requests.slice(n).filter((q) => q.path === route).map((q) => q.method), ['GET', 'PATCH', 'GET'], 'read, change, read again');
    assert.deepEqual([r.ok, r.supervision.state], [false, 'unsupervised']);
    assert.equal(feed.at(-1), 'Supervise in office: Paperclip saved other arguments for Ada than the office sent (a change made in Paperclip at the same time). The office shows the saved config: It allows tools without asking (--allowedTools).');
    assert.equal(hq.view().agents.find((a) => a.name === 'Ada').supervision.state, 'unsupervised');
    // the same arguments saved: no such line
    pc.afterPatch = null;
    pc.state.agents[1].adapterConfig = { cwd: 'C:/work/acme', model: 'haiku', engine: 'cli', extraArgs: ['--max-turns', '8'] };
    const again = await hq.supervise(ada.id);
    assert.deepEqual([again.ok, again.supervision.state], [true, 'supervised']);
    assert.match(feed.at(-1), /^Supervise in office: Ada now runs Claude Code with the office hooks\./);
    assert.equal(feed.filter((t) => /saved other arguments/.test(t)).length, 1);
  } finally { hq.disconnect(); await pc.close(); }
});

// Review 76, findings 1 and 3, on the command line of each run (adapter.invoke: command is the resolved program, or
// ssh://... :: claude and sandbox://... :: claude for a run on another computer, execution-target.ts).
test('the command line of a run: a flag that approves calls, another program or another computer is named, and the agent shows it', async () => {
  const pc = await startFakePaperclip(DEMO(HOOKS));
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket', { ms: 5000 });
    const ada = () => hq.view().agents.find((a) => a.name === 'Ada');
    assert.equal(ada().supervision.state, 'supervised');
    const invoke = (runId, command, extra) => pc.emit('heartbeat.run.event', { runId, agentId: ada().id, seq: 1, eventType: 'adapter.invoke', stream: 'system', message: 'adapter invocation',
      payload: { adapterType: 'claude_local', command, commandArgs: ['--print', '-', '--output-format', 'stream-json', '--verbose', '--add-dir', 'C:/b', ...extra] } });
    invoke('r1', 'claude', ['--allowedTools', 'Task Bash(*) Edit', ...SUPERVISED.extraArgs]);
    await until(() => feed.length === 1, 'the first feed line', { ms: 3000 });
    assert.equal(feed[0], 'Paperclip started a run of Ada without the office: It allows tools without asking (--allowedTools). Its tool calls are not held.');
    assert.equal(ada().supervision.label, 'Unsupervised: its last run skipped the office');
    invoke('r2', 'claude.exe', SUPERVISED.extraArgs);
    await until(() => ada().supervision.state === 'supervised', 'a held run again', { ms: 3000 });
    invoke('r3', 'C:/tools/wrap.cmd', SUPERVISED.extraArgs);
    await until(() => feed.length === 2, 'the second feed line', { ms: 3000 });
    assert.equal(feed[1], 'Paperclip started a run of Ada with another program: It starts C:/tools/wrap.cmd, not claude. The office cannot tell if that program uses the office hooks.');
    assert.deepEqual([ada().supervision.state, ada().supervision.label, ada().supervision.can], ['partly', 'Partly supervised: its last run started another program', false]);
    invoke('r4', 'ssh://me@build:22//work :: claude', SUPERVISED.extraArgs);
    await until(() => feed.length === 3, 'the third feed line', { ms: 3000 });
    assert.match(feed[2], /^Paperclip started a run of Ada without the office: It runs on another computer \(ssh\), so its calls never reach the office hooks\./);
    assert.equal(ada().supervision.label, 'Unsupervised: its last run skipped the office');
    invoke('r5', 'sandbox://e2b/lease-1/work :: claude', SUPERVISED.extraArgs);
    await until(() => feed.length === 4, 'the fourth feed line', { ms: 3000 });
    assert.match(feed[3], /another computer \(sandbox\)/);
  } finally { hq.disconnect(); await pc.close(); }
});

test('a refused address sends nothing; several companies ask which; a Paperclip that asks for sign-in is said', async () => {
  let calls = 0;
  const hq = createHq({ fetch: async () => { calls++; throw new Error('no'); }, hooksFile: () => HOOKS });
  for (const url of ['http://localhost:3100', 'http://192.168.1.10:3100', 'https://127.0.0.1:3100']) await assert.rejects(hq.connect({ url }), (e) => e.status === 400 && /127\.0\.0\.1/.test(e.message), url);
  assert.equal(calls, 0, 'no request left the office');
  assert.equal(hq.view(), null);

  const two = DEMO();
  two.companies.push({ id: 'c2', name: 'Beta Labs', status: 'active', budgetMonthlyCents: 0, spentMonthlyCents: 0 });
  const pc = await startFakePaperclip(two);
  const hq2 = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    assert.deepEqual(await hq2.connect({ url: pc.url }), { choose: [{ id: two.companies[0].id, name: 'Acme Robotics' }, { id: 'c2', name: 'Beta Labs' }] });
    assert.equal(hq2.view().state, 'choose');
    assert.equal(pc.requests.some((q) => q.method === 'UPGRADE'), false, 'nothing is watched before the choice');
    await hq2.connect({ url: pc.url, company: 'c2' });
    assert.equal(hq2.view().company.name, 'Beta Labs');
    await assert.rejects(hq2.connect({ url: pc.url, company: 'nope' }), (e) => e.status === 404);
  } finally { hq2.disconnect(); await pc.close(); }

  const locked = await startFakePaperclip({ ...DEMO(), auth: true });
  const hq3 = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await assert.rejects(hq3.connect({ url: locked.url }), (e) => e.status === 502 && /asks for sign-in \(403\).*local_trusted/.test(e.message));
    assert.equal(hq3.view(), null, 'a failed connect is not kept');
  } finally { await locked.close(); }

  // a saved connection at start keeps trying while Paperclip is not up
  const hq4 = createHq({ ...fast, hooksFile: () => HOOKS });
  const r = await hq4.connect({ url: 'http://127.0.0.1:9', company: 'c1', keep: true });
  assert.equal(r.ok, false);
  assert.equal(hq4.view().state, 'lost');
  assert.match(hq4.view().error, /No Paperclip answers at http:\/\/127\.0\.0\.1:9/);
  hq4.disconnect();
});

// Review 76, round 3 (owner direction: a Paperclip agent is untrusted by default; anything unknown, unreadable or cut is
// never Supervised).
test('round 3: env keys that can answer the office hook make the agent Unsupervised; chrome, stream-json input and an empty config are never Supervised', () => {
  for (const key of ['CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_CODE_GIT_BASH_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'PATHEXT', 'path']) {
    const s = supervisionOf(agent({ ...SUPERVISED, env: { [key]: 'x' } }), HOOKS);
    assert.deepEqual([s.state, s.can], ['unsupervised', false], key);
    assert.equal(supervisionOf(agent({ cwd: 'C:/x', env: { [key]: 'x' } }), HOOKS).can, false);
  }
  assert.equal(supervisionOf(agent({ ...SUPERVISED, chrome: true }), HOOKS).state, 'partly');
  assert.equal(supervisionOf(agent({ ...SUPERVISED, chrome: false }), HOOKS).state, 'supervised');
  const si = supervisionOf(agent({ ...SUPERVISED, extraArgs: [...SUPERVISED.extraArgs, '--input-format', 'stream-json'] }), HOOKS);
  assert.deepEqual([si.state, si.can], ['partly', false]);
  assert.match(si.why, /stream-json input/);
  assert.equal(supervisionOf(agent({ ...SUPERVISED, extraArgs: [...SUPERVISED.extraArgs, '--input-format', 'text'] }), HOOKS).state, 'supervised');
  assert.deepEqual([supervisionOf(agent({}), HOOKS).state, supervisionOf(agent({}), HOOKS).can], ['unknown', false], 'an empty config is a hidden one');
  // a run line of 50 arguments may be cut
  assert.equal(runCheck('claude', [...SUPERVISED.extraArgs, ...Array(46).fill('x')], HOOKS).partly, true);
  assert.equal(runCheck('claude', SUPERVISED.extraArgs, HOOKS).ok, true);
});

test('round 3: a profile and an issue override read together, and the env layers of a project or routine, are checked; unread parts fail closed', () => {
  const profile = { runtimeConfig: { modelProfiles: { fast: { adapterConfig: { env: { BASH_ENV: '1' } } } } } };
  const issue = { id: 'i', identifier: 'ACM-1', assigneeAgentId: 'a1', assigneeAdapterOverrides: { adapterConfig: { command: 'C:/w.cmd' } } };
  // each alone is partly; together with a clean profile the issue still counts
  assert.equal(supervisionOf(agent(SUPERVISED, { runtimeConfig: { modelProfiles: { ok: { adapterConfig: { model: 'haiku' } } } } }), HOOKS, { issues: [issue] }).state, 'partly');
  const both = supervisionOf(agent(SUPERVISED, profile), HOOKS, { issues: [{ ...issue, assigneeAdapterOverrides: { adapterConfig: { model: 'x' } } }] });
  assert.match(both.why, /model profile/);
  const layerKeys = supervisionOf(agent(SUPERVISED), HOOKS, { layers: [{ name: 'its project Web', keys: ['PATH'] }] });
  assert.deepEqual([layerKeys.state, layerKeys.can], ['unsupervised', false]);
  assert.match(layerKeys.why, /^For its project Web: Its env has PATH/);
  assert.equal(supervisionOf(agent(SUPERVISED), HOOKS, { layers: [{ name: 'its routine R', keys: ['FOO'] }] }).state, 'supervised');
  const un = supervisionOf(agent(SUPERVISED), HOOKS, { unread: ['issues'] });
  assert.deepEqual([un.state, un.can], ['partly', false]);
});

test('round 3: the patch puts the office arguments in front of a trailing flag that takes a value', () => {
  const a = agent({ engine: 'cli', extraArgs: ['--max-turns', '8', '--model'] });
  assert.deepEqual(supervisePatch(a, HOOKS).adapterConfig.extraArgs, ['--max-turns', '8', '--permission-mode', 'default', '--settings', HOOKS, '--model']);
  assert.deepEqual(supervisePatch(agent({ engine: 'cli', extraArgs: [] }), HOOKS).adapterConfig.extraArgs, ['--permission-mode', 'default', '--settings', HOOKS]);
});

test('round 3: the watcher holds no env value, and a failed read of projects is not Supervised', async () => {
  const demo = DEMO(HOOKS);
  demo.agents[1].adapterConfig.env = { SECRET_TOKEN: 'sk-very-secret' };
  demo.projects = [{ id: 'p1', companyId: demo.companies[0].id, name: 'Web', env: { PS4: 'sk-other-secret' } }];
  demo.issues[0].projectId = 'p1';
  const pc = await startFakePaperclip(demo);
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    const ada = hq.view().agents.find((a) => a.name === 'Ada');
    assert.deepEqual([ada.supervision.state, ada.supervision.can], ['unsupervised', false], 'the project env key PS4');
    assert.match(ada.supervision.why, /its project Web/);
    assert.equal(JSON.stringify(hq.view()).includes('sk-'), false);
    await hq.supervise('a1000000-0000-4000-8000-000000000002').catch(() => {});
  } finally { hq.disconnect(); await pc.close(); }
  const pc2 = await startFakePaperclip({ ...DEMO(HOOKS), noProjects: true });
  const hq2 = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq2.connect({ url: pc2.url });
    const ada = hq2.view().agents.find((a) => a.name === 'Ada');
    assert.deepEqual([ada.supervision.state, ada.supervision.can], ['partly', false]);
    assert.match(ada.supervision.why, /projects/);
  } finally { hq2.disconnect(); await pc2.close(); }
});

// ---------- review 76, round 4: red first (each test failed on the round 3 code) ----------
test('round 4: every env key the office knows turns hooks off or loads what it cannot read; one that looks like Claude Code or Node but is unknown is Partly supervised', () => {
  for (const key of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_PERSONAL_HOOKS_OFF', 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_BG_SESSION_PERMISSION_RULES', 'CLAUDE_CODE_REMOTE_TOOLS_HOST_ALLOWS_UNATTENDED', 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS']) {
    assert.equal(supervisionOf(agent({ ...SUPERVISED, env: { [key]: '1' } }), HOOKS).state, 'unsupervised', key);
  }
  for (const key of ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CHROME_PERMISSION_MODE', 'CLAUDE_CODE_DISABLE_HOOK_FORWARDING', 'claude_code_plugin_dirs']) {
    const s = supervisionOf(agent({ ...SUPERVISED, env: { [key]: '1' } }), HOOKS);
    assert.deepEqual([s.state, s.can], ['partly', false], key);
  }
  // the lists above are not complete, so a key of those families that the office does not know is not Supervised
  for (const key of ['CLAUDE_CODE_SOME_NEW_SWITCH', 'NODE_COMPILE_CACHE', 'NODE_DEBUG_NATIVE', 'CLAUDE_BG_SOMETHING']) {
    const s = supervisionOf(agent({ ...SUPERVISED, env: { [key]: '1' } }), HOOKS);
    assert.deepEqual([s.state, s.can], ['partly', false], key);
    assert.match(s.why, new RegExp(key));
  }
  for (const key of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NODE_ENV', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) {
    assert.equal(supervisionOf(agent({ ...SUPERVISED, env: { [key]: '1' } }), HOOKS).state, 'supervised', key);
  }
  // the same on a run's command line
  assert.equal(runCheck('claude', SUPERVISED.extraArgs, HOOKS, ['NODE_COMPILE_CACHE']).partly, true);
  assert.equal(runCheck('claude', SUPERVISED.extraArgs, HOOKS, ['BASH_ENV']).ok, false);
  assert.equal(runCheck('claude', SUPERVISED.extraArgs, HOOKS, ['bash_env']).partly, false);
});

test('round 4: the env of a project or a routine is read like the agent env, in both strengths', () => {
  const layer = (keys) => supervisionOf(agent(SUPERVISED), HOOKS, { layers: [{ name: 'its routine R', keys }] });
  assert.deepEqual([layer(['BASH_ENV']).state, layer(['BASH_ENV']).can], ['unsupervised', false]);
  const w = layer(['CLAUDE_CODE_PLUGIN_DIRS']);
  assert.deepEqual([w.state, w.can], ['partly', false]);
  assert.match(w.why, /^For its routine R: Its env has CLAUDE_CODE_PLUGIN_DIRS/);
  assert.match(w.label, /^Partly supervised/);
});

test('round 4: a model profile that is switched off does not count; an issue of another agent does not count; an active profile and an issue override both do', () => {
  const profile = (enabled) => ({ runtimeConfig: { modelProfiles: { cheap: { enabled, adapterConfig: { command: 'C:/w.cmd' } } } } });
  assert.equal(supervisionOf(agent(SUPERVISED, profile(false)), HOOKS).state, 'supervised');
  assert.equal(supervisionOf(agent(SUPERVISED, profile(true)), HOOKS).state, 'partly');
  assert.equal(supervisionOf(agent(SUPERVISED, profile(undefined)), HOOKS).state, 'partly', 'a profile with no enabled value is on');
  const issue = (who) => ({ id: 'i', identifier: 'ACM-9', assigneeAgentId: who, assigneeAdapterOverrides: { adapterConfig: { dangerouslySkipPermissions: true } } });
  assert.equal(supervisionOf(agent(SUPERVISED), HOOKS, { issues: [issue('someone-else')] }).state, 'supervised');
  const mine = supervisionOf(agent(SUPERVISED), HOOKS, { issues: [issue('a1')] });
  assert.equal(mine.state, 'partly');
  assert.match(mine.why, /^For ACM-9: Skip permissions is on/);
});

test('round 4: a trailing flag that takes a list of values keeps the office arguments out of its list', () => {
  const a = agent({ engine: 'cli', extraArgs: ['--max-turns', '8', '--add-dir'] });
  assert.deepEqual(supervisePatch(a, HOOKS).adapterConfig.extraArgs, ['--max-turns', '8', '--permission-mode', 'default', '--settings', HOOKS, '--add-dir']);
  // a flag that Supervise takes out and that ends the list leaves no trace
  assert.deepEqual(supervisePatch(agent({ engine: 'cli', extraArgs: ['--model', 'x', '--allowedTools'] }), HOOKS).adapterConfig.extraArgs, ['--model', 'x', '--permission-mode', 'default', '--settings', HOOKS]);
});

test('round 4: the watcher keeps no env value: agents, profiles, issue overrides, routines and projects hold key names only', async () => {
  const demo = DEMO(HOOKS), cid = demo.companies[0].id;
  Object.assign(demo.agents[1], { runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: 'h', env: { PROFILE_KEY: 'sk-profile' } } } } } });
  demo.agents[0].adapterConfig.env = { AGENT_KEY: 'sk-agent' };
  demo.issues[0].assigneeAdapterOverrides = { adapterConfig: { env: { ISSUE_KEY: 'sk-issue' } } };
  demo.routines[0].env = { ROUTINE_KEY: { type: 'plain', value: 'sk-routine' } };
  demo.projects = [{ id: 'p1', companyId: cid, name: 'Web', env: { PROJECT_KEY: 'sk-project' } }];
  const pc = await startFakePaperclip(demo);
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    const held = JSON.stringify(hq.held());
    for (const key of ['AGENT_KEY', 'PROFILE_KEY', 'ISSUE_KEY', 'ROUTINE_KEY', 'PROJECT_KEY']) assert.ok(held.includes(key), `${key} is read as a name`);
    assert.equal(held.includes('sk-'), false);
    assert.equal(held.includes('plain'), false);
  } finally { hq.disconnect(); await pc.close(); }
});

test('round 4: the watcher fails closed on what it cannot read of a company: any project env, blocked and backlog issues, a cut list, a Paperclip with no env field', async () => {
  const run = async (mutate, check) => {
    const demo = DEMO(HOOKS), cid = demo.companies[0].id;
    demo.routines.forEach((r) => { r.env = null; });
    demo.projects = [{ id: 'p1', companyId: cid, name: 'Web', env: null }];
    mutate(demo, cid);
    const pc = await startFakePaperclip(demo), hq = createHq({ ...fast, hooksFile: () => HOOKS });
    try { await hq.connect({ url: pc.url }); await check(hq.view().agents.find((a) => a.name === 'Ada').supervision); } finally { hq.disconnect(); await pc.close(); }
  };
  const ADA = 'a1000000-0000-4000-8000-000000000002';
  await run(() => {}, (s) => assert.equal(s.state, 'supervised', 'the baseline'));
  // a project env applies to any issue of the project, and an agent can be given one at any time
  await run((d) => { d.projects[0].env = { BASH_ENV: 'x' }; }, (s) => { assert.deepEqual([s.state, s.can], ['unsupervised', false]); assert.match(s.why, /its project Web/); });
  // a blocked or backlog issue can still wake an agent
  for (const status of ['blocked', 'backlog']) {
    await run((d, cid) => d.issues.push({ id: 'ib', companyId: cid, identifier: 'ACM-40', status, assigneeAgentId: ADA, assigneeAdapterOverrides: { adapterConfig: { command: 'C:/w.cmd' } } }), (s) => assert.match(s.why, /ACM-40/, status));
  }
  // Paperclip lists at most 500 issues by default: a list that long may be cut
  await run((d, cid) => { for (let n = 0; n < 500; n++) d.issues.push({ id: `x${n}`, companyId: cid, identifier: `X-${n}`, status: 'todo', assigneeAgentId: null }); }, (s) => { assert.equal(s.state, 'partly'); assert.match(s.why, /issues/); });
  // a project or a routine with no env field at all: this Paperclip may not have one, so the office cannot say it has none
  await run((d) => { delete d.projects[0].env; }, (s) => { assert.equal(s.state, 'partly'); assert.match(s.why, /project env/); });
  // a routine of nobody may run as anyone; a routine of another agent does not run as Ada
  await run((d) => { d.routines[0].assigneeAgentId = null; d.routines[0].env = { BASH_ENV: 'x' }; }, (s) => { assert.equal(s.state, 'unsupervised'); assert.match(s.why, /its routine Weekly status report/); });
  await run((d) => { d.routines[0].env = { BASH_ENV: 'x' }; }, (s) => assert.equal(s.state, 'supervised', 'a routine of Grace is not a layer of Ada'));
  await run((d) => { delete d.routines[0].env; }, (s) => { assert.equal(s.state, 'partly'); assert.match(s.why, /routine env/); });
});

// Paperclip as a plan source (#155, spec #130): its tasks are plan steps, read-only, on the contract of manager.mjs (#154).
import { createPlanBoard } from '../src/manager.mjs';

test('plan source: tasks become steps with agent, state, budget and model; the board reads them through the contract', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), allIssues: true });
  const ADA = 'a1000000-0000-4000-8000-000000000002', TASK = 'i1000000-0000-4000-8000-000000000012';
  const company = DEMO().companies[0].id;
  pc.state.issues.push({ id: 'i-x', companyId: company, identifier: 'ACM-14', title: 'Odd one', status: 'waiting_on_moon', assigneeAgentId: null });
  pc.state.issues.push({ id: 'i-d', companyId: company, identifier: 'ACM-15', title: 'Shipped', status: 'done', assigneeAgentId: ADA });
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, sessions: () => [{ uid: 'u7', paperclip: { task: TASK, run: 'r1' } }, { uid: 'u8', paperclip: { task: 'other' } }] });
  const board = createPlanBoard({ sources: [hq.planSource] });
  try {
    assert.equal(hq.planSource.kind, 'paperclip');
    assert.deepEqual(hq.planSource.list(), [], 'nothing before a connection');
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const { plans, unreadable } = board.snapshot();
    assert.deepEqual(unreadable, []);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].source, 'paperclip');
    assert.equal(plans[0].sourceWord, 'Paperclip');
    assert.equal(plans[0].frozen, false);
    const by = Object.fromEntries(plans[0].steps.map((s) => [s.id, s]));
    const s = by[TASK];
    assert.deepEqual([s.title, s.state, s.owner, s.raw, s.model, s.budget, s.uid], ['ACM-12 Add a health route to the API', 'working', 'Ada', 'in_progress', 'haiku', { spent: 8.3, limit: 50 }, 'u7']);
    assert.equal(by['i1000000-0000-4000-8000-000000000013'].state, 'pending', 'todo waits');
    assert.equal(by['i-x'].state, 'unknown', 'an unknown state is neutral, with its raw name');
    assert.equal(by['i-x'].raw, 'waiting_on_moon');
    assert.equal(by['i-x'].word, 'Unknown');
    assert.equal(s.skipped, false);
  } finally { board.close(); hq.disconnect(); await pc.close(); }
});

test('plan source: a step whose agent run skipped the office says so', async () => {
  const pc = await startFakePaperclip(DEMO(HOOKS));
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const ADA = 'a1000000-0000-4000-8000-000000000002';
    pc.emit('heartbeat.run.event', { runId: 'r9', agentId: ADA, eventType: 'adapter.invoke', payload: { command: 'claude', commandArgs: ['--print', '--dangerously-skip-permissions'], env: {} } });
    await until(() => hq.planSource.list()[0].steps.some((s) => s.skipped), 'the skipped run');
    const st = hq.planSource.list()[0].steps.find((x) => x.owner === 'Ada');
    assert.equal(st.skipped, true);
    assert.match(st.skippedWhy, /skips permissions/);
  } finally { hq.disconnect(); await pc.close(); }
});

test('plan source: a lost connection freezes the steps as Not connected; no plan to show is unreadable', async () => {
  const pc = await startFakePaperclip();
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    assert.equal(hq.planSource.list()[0].steps.length, 2, 'two open tasks');
    assert.equal(hq.planSource.list()[0].frozen, false);
    await pc.close();   // Paperclip goes away
    await until(() => hq.state() === 'lost', 'the lost state');
    const [p] = hq.planSource.list();
    assert.equal(p.steps.length, 2, 'the last plan stays');
    assert.equal(p.status, 'not-connected');
    assert.equal(p.frozen, true);
    assert.match(p.reason, /^Not connected\./);
    assert.equal(createPlanBoard({ sources: [hq.planSource] }).snapshot().plans[0].frozen, true);
    hq.disconnect();
    assert.deepEqual(hq.planSource.list(), [], 'the user disconnected: no plan');
  } finally { hq.disconnect(); }
  const dead = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await dead.connect({ url: 'http://127.0.0.1:9', keep: true, company: 'c' });
    assert.throws(() => dead.planSource.list(), /could not be read/);
    assert.deepEqual(createPlanBoard({ sources: [dead.planSource] }).snapshot().unreadable, [{ source: 'paperclip', word: 'Paperclip' }]);
  } finally { dead.disconnect(); }
});

test('plan source: a task list that may be cut is unreadable, not a plan that looks whole', async () => {
  const seed = DEMO();
  for (let n = 0; n < 500; n++) seed.issues.push({ ...seed.issues[1], id: `bulk-${n}`, identifier: `ACM-${100 + n}` });
  const pc = await startFakePaperclip(seed);
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    assert.throws(() => hq.planSource.list(), /could not be read/);
  } finally { hq.disconnect(); await pc.close(); }
});

test('plan source: while it runs, the office sends only GET and the WebSocket', async () => {
  const pc = await startFakePaperclip();
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  const board = createPlanBoard({ sources: [hq.planSource] });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    pc.emit('activity.logged', {});
    await until(() => pc.requests.filter((r) => r.path.endsWith('/issues')).length >= 2, 'a second read');
    board.snapshot();
    assert.ok(pc.requests.length > 3);
    for (const r of pc.requests) assert.ok(r.method === 'GET' || r.method === 'UPGRADE', `${r.method} ${r.path}`);
  } finally { board.close(); hq.disconnect(); await pc.close(); }
});

// ---------- #194: a Paperclip in login mode, read with the board key of the connect mode ----------
test('a board key goes in the Authorization header of every read and of the live stream, to the address it is for, and a refused key is said', async () => {
  const KEY = 'pcp_board_' + 'a'.repeat(40);
  const pc = await startFakePaperclip({ ...DEMO(), boardKey: KEY });
  const asked = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, key: (u) => { asked.push(u); return u === pc.url ? KEY : null; } });
  try {
    const r = await hq.connect({ url: pc.url, company: DEMO().companies[0].id });
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(hq.view().state, 'on');
    assert.ok(asked.every((u) => u === pc.url), 'the key is asked for only the address in use');
    assert.ok(pc.requests.filter((q) => q.method === 'GET').length > 3);
    assert.ok(!JSON.stringify(hq.view()).includes(KEY), 'the view never carries the key');
    const ws = pc.requests.find((q) => q.method === 'UPGRADE');
    assert.equal(ws && ws.authorization, `Bearer ${KEY}`, 'the live stream carries it too');
  } finally { hq.disconnect(); }
  const bad = createHq({ ...fast, hooksFile: () => HOOKS, key: () => 'pcp_board_' + 'b'.repeat(40) });
  try {
    await assert.rejects(bad.connect({ url: pc.url }), (e) => e.status === 502 && /does not accept the board key \(401\)/.test(e.message) && !e.message.includes('pcp_board_'));
  } finally { await pc.close(); }
  const none = await startFakePaperclip({ ...DEMO(), boardKey: KEY });
  const hq0 = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await assert.rejects(hq0.connect({ url: none.url }), (e) => e.status === 502 && /asks for sign-in \(403\)/.test(e.message) && /board key/.test(e.message));
  } finally { await none.close(); }
});

test('an employee on the office adapter is Supervised, whatever its agent kind; the adapter of another type is not (#200)', () => {
  assert.equal(OFFICE_ADAPTER, 'agent_office');
  const s = supervisionOf({ id: 'a1', adapterType: OFFICE_ADAPTER, adapterConfig: { agentKind: 'codex' } }, HOOKS);
  assert.deepEqual([s.state, s.label, s.can], ['supervised', '', false]);
  assert.match(s.why, /office adapter/);
  assert.equal(supervisionOf({ id: 'a1', adapterType: 'codex_local', adapterConfig: { cwd: 'C:/x' } }, HOOKS).state, 'unsupervised');
});
