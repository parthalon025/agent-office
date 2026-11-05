// Paperclip as an optional HQ (#76): the address rule, what makes an agent supervised, the one PATCH of Supervise in office,
// and the watcher against a fake Paperclip (REST and the live events WebSocket, test/fixtures/fake-paperclip.mjs). No paid
// call, no real Paperclip. Run: node --test test/paperclip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, supervisionOf, supervisePatch, argsWhy, configWhy, runIds, cleanIds, createHq, roleLabel, DEFAULT_URL } from '../paperclip.mjs';
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
  for (const command of [undefined, '', 'claude', 'CLAUDE', 'claude.exe', 'C:\\Users\\a\\.local\\bin\\claude.exe', 'C:/Users/a/.local/bin/Claude.EXE', '/usr/local/bin/claude']) {
    assert.equal(supervisionOf(agent({ ...SUPERVISED, command }), HOOKS).state, 'supervised', String(command));
  }
  for (const command of ['C:/tools/claude-wrap.cmd', 'node', 'claude.cmd', 'C:/x/claude.exe.bak', 'C:/claude/run.exe', 'claude --bare']) {
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
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on' && pc.requests.filter((q) => q.path.endsWith('/agents')).length >= 2, 'the read after the socket opened', { ms: 5000 });
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
    invoke('r2', 'C:\\Users\\a\\.local\\bin\\claude.exe', SUPERVISED.extraArgs);
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
