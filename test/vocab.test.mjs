// Session vocabulary: one table of session fixtures, one expected status, task line and figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';

const V = globalThis.OfficeVocab;
const base = { status: 'idle', turns: 0, pending: [], questions: [], calls: [], todos: [], usage: { tokens: 0 }, error: null, cost: null, lastEvent: 0, note: '', prompt: '', live: '', tool: null };
const mk = (o) => ({ ...base, ...o });

const table = [
  ['fresh idle session', mk({}), 'resting', 'Resting', 'Waiting for a prompt'],
  ['starting', mk({ status: 'starting' }), 'resting', 'Resting', 'Waiting for the first hook'],
  ['working with a tool', mk({ status: 'working', tool: { name: 'Bash', detail: 'npm test' } }), 'working', 'Working', 'Bash npm test'],
  ['working, streaming text', mk({ status: 'working', live: 'Thinking about\nthe plan' }), 'working', 'Working', 'Thinking about the plan'],
  ['working, no tool', mk({ status: 'working', prompt: 'fix the bug' }), 'working', 'Working', 'fix the bug'],
  ['finished a turn', mk({ turns: 1, prompt: 'fix the bug' }), 'finished', 'Finished', 'fix the bug'],
  ['failed turn', mk({ turns: 1, error: { id: 1, text: 'Out of budget.' } }), 'error', 'Error', 'Out of budget.'],
  ['pending prompt', mk({ status: 'waiting', pending: [{ id: 'p1' }], note: 'Bash rm -rf x' }), 'waiting', 'Needs you', 'Bash rm -rf x'],
  ['open question', mk({ status: 'waiting', questions: [{ id: 'q1' }], note: 'Which file?' }), 'waiting', 'Needs you', 'Which file?'],
  ['subagent tool call after a prompt (status flipped to working)', mk({ status: 'working', pending: [{ id: 'p1' }] }), 'waiting', 'Needs you', 'Needs your attention'],
  ['waiting beats a stale error', mk({ status: 'waiting', pending: [{ id: 'p1' }], error: { id: 1, text: 'x' } }), 'waiting', 'Needs you', 'Needs your attention'],
  ['ended', mk({ status: 'ended', turns: 2, pending: [{ id: 'p1' }] }), 'resting', 'Closed', 'Left the office'],
];
for (const [name, s, key, word, task] of table) {
  test('status and task line: ' + name, () => {
    const st = V.status(s);
    assert.equal(st.key, key);
    assert.equal(st.word, word);
    assert.equal(V.taskLine(s), task);
  });
}

test('a failed turn reads as an error until Dismiss clears it', () => {
  const failed = mk({ turns: 1, error: { id: 1, text: 'The turn failed.' } });
  assert.equal(V.status(failed).word, 'Error');
  const dismissed = { ...failed, error: null }; // the server sets error to null on Dismiss
  assert.equal(V.status(dismissed).word, 'Finished');
  assert.equal(V.figures([dismissed]).waiting, 0);
});

test('waiting is a pending prompt or an open question, nothing else', () => {
  assert.equal(V.isWaiting(mk({ status: 'waiting' })), false); // status word alone does not count
  assert.equal(V.isWaiting(mk({ pending: [{}] })), true);
  assert.equal(V.isWaiting(mk({ questions: [{}] })), true);
  assert.equal(V.isWaiting(null), false);
});

test('tool names and kinds', () => {
  assert.equal(V.toolKind('Bash'), 'terminal');
  assert.equal(V.toolKind('Read'), 'code');
  assert.equal(V.toolKind('Grep'), 'search');
  assert.equal(V.toolKind('mcp__office__office_room'), 'mcp');
  assert.equal(V.toolKind('Whatever'), 'api');
  assert.equal(V.toolShort('mcp__plugin_playwright_playwright__browser_click'), 'browser click');
  assert.equal(V.toolShort('mcp__office__office_room'), 'office office_room');
  assert.equal(V.toolKind('mcp__plugin_playwright_playwright__browser_click'), 'browser');
  const x = 'mcp__plugin_playwright_playwright__browser_click';
  assert.equal(V.toolShort(V.toolShort(x)), V.toolShort(x));
  assert.equal(V.toolShort('Edit'), 'Edit');
  assert.equal(V.toolArg('Bash'), 'command');
  assert.equal(V.toolArg('Zzz'), 'input');
});

test('to-do status', () => {
  assert.equal(V.todoStatus('pending'), 'resting');
  assert.equal(V.todoStatus({ status: 'in_progress' }), 'working');
  assert.equal(V.todoStatus('completed'), 'finished');
  assert.equal(V.todoStatus('odd'), 'resting');
});

test('room figures count once, with the same waiting rule', () => {
  const list = [
    mk({ status: 'working', calls: [1, 2], usage: { tokens: 1500 }, cost: 0.25, todos: [{ status: 'completed' }, { status: 'pending' }], lastEvent: 10 }),
    mk({ status: 'working', pending: [{ id: 'p' }], calls: [1], usage: { tokens: 500 }, lastEvent: 20 }),
    mk({ turns: 1, error: { id: 1, text: 'x' }, cost: 0.5 }),
  ];
  assert.deepEqual(V.figures(list), { sessions: 3, working: 1, waiting: 1, toolCalls: 3, tokens: 2000, cost: 0.75, priced: 2, unknown: 0, supervision: '', todosDone: 1, todosTotal: 2, lastEvent: 20 });
  assert.equal(V.figures([]).sessions, 0);
});

test('room figures count the sessions whose agent reports no cost, apart from the priced ones', () => {
  const f = V.figures([mk({ cost: 0.25 }), mk({ cost: null, costUnknown: true }), mk({ cost: null, costUnknown: true })]);
  assert.deepEqual([f.cost, f.priced, f.unknown], [0.25, 1, 2]);
});

const PARTLY = 'Partly supervised: commands ask, file edits do not';

test('supervision words (ADR 0001): the label of an ungated agent, its short form for a small sign, and the bot platform line', () => {
  assert.equal(V.supervision(mk({ supervision: PARTLY })), PARTLY);
  assert.equal(V.supervision(mk({})), '', 'a gated agent has none');
  assert.equal(V.supervision(null), '');
  assert.equal(V.supervisionHead(PARTLY), 'Partly supervised');
  assert.equal(V.supervisionHead('Unsupervised'), 'Unsupervised');
  assert.equal(V.supervisionHead(''), '');
  // The room sign and the desk screen show the whole label on two lines, split at the colon, never cut.
  assert.deepEqual(V.supervisionLines(PARTLY), ['Partly supervised:', 'commands ask, file edits do not']);
  assert.deepEqual(V.supervisionLines('Unsupervised'), ['Unsupervised']);
  assert.deepEqual(V.supervisionLines(''), []);
  assert.equal(V.platform(mk({})), 'Claude Code');
  assert.equal(V.platform(mk({ supervision: PARTLY })), PARTLY, 'the label is on the bot card');
});

test('room figures carry the supervision label of the least supervised agent in the room, "" when every agent is gated', () => {
  assert.equal(V.figures([mk({}), mk({})]).supervision, '');
  assert.equal(V.figures([mk({}), mk({ supervision: PARTLY })]).supervision, PARTLY);
  assert.equal(V.figures([mk({ supervision: PARTLY }), mk({ supervision: 'Unsupervised' })]).supervision, 'Unsupervised');
});

test('requests lists every permission prompt and question, oldest first', () => {
  const s = mk({
    pending: [{ id: 'p2', tool: 'Bash', detail: 'rm -rf x', risk: 'high', always: 'Bash(rm:*)', t: 30 }, { id: 'p1', tool: 'Read', detail: 'a.txt', risk: 'low', always: 'Read', t: 10 }],
    questions: [{ id: 'q1', text: 'Which file?', t: 20 }],
  });
  const r = V.requests(s);
  assert.deepEqual(r.map((x) => x.id), ['p1', 'q1', 'p2']);
  assert.deepEqual(r.map((x) => x.kind), ['permission', 'question', 'permission']);
  assert.equal(r[1].text, 'Which file?');
  assert.equal(r[0].text, 'Allow Read: a.txt?');
  assert.equal(r[1].risk, undefined);
});

test('requests is empty for no session, a closed session and a quiet one', () => {
  assert.deepEqual(V.requests(null), []);
  assert.deepEqual(V.requests(mk({})), []);
  assert.deepEqual(V.requests(mk({ status: 'ended', pending: [{ id: 'p', tool: 'Bash', t: 1 }] })), []);
});

test('always allow is offered for low and medium risk, never for high risk or a question', () => {
  const p = (id, risk, always) => ({ id, tool: 'Bash', detail: 'x', risk, always, t: 1 });
  assert.equal(V.alwaysOffer(mk({ pending: [p('a', 'high', 'Bash(rm:*)')] })), null);
  assert.equal(V.alwaysOffer(mk({ pending: [p('a', 'medium', null)] })), null);
  assert.equal(V.alwaysOffer(mk({ questions: [{ id: 'q', text: 'x', t: 1 }] })), null);
  assert.equal(V.alwaysOffer(mk({ pending: [p('a', 'high', 'Bash(rm:*)'), p('b', 'medium', 'Bash(ls:*)')] })).id, 'b');
  assert.equal(V.alwaysOffer(mk({ pending: [p('a', 'low', 'Read')] })).always, 'Read');
});

// ---------- the Security room grid (#70): one vocabulary for the wall screens and the server ----------
const S = V.security;
const RULES = (office = {}, buildings = {}) => ({ office, buildings });

test('security: six screens on three walls, each with its rows; six agent kinds as columns', () => {
  assert.deepEqual(S.screens.map((x) => x.title), ['Files', 'Commands', 'Network', 'Secrets', 'Agents', 'Spend']);
  assert.deepEqual(S.screens.find((x) => x.id === 'files').rows, ['read-inside', 'edit-inside', 'files-outside']);
  assert.deepEqual(S.screens.find((x) => x.id === 'secrets').rows, ['settings', 'secrets']);
  assert.deepEqual(S.columns.map((c) => c.label), ['Claude Code', 'Hermes', 'dsh', 'OpenClaw', 'Copilot', 'Local model', 'Agent Framework', 'Cloud agent']);
  // A kind that runs on a model of this machine costs nothing: the Spend screen says Free, never Not reported (#23).
  assert.deepEqual(S.columns.filter((c) => c.free).map((c) => c.id), ['local', 'agent-framework']);
  assert.equal(S.rows.shell.label, 'Shell commands');
  assert.equal(S.rows['files-outside'].label, 'Read or edit outside it');
});

test('security: an agent kind is the column of its provider; the two local providers share one', () => {
  assert.equal(S.columnOf('claude-code'), 'claude-code');
  assert.equal(S.columnOf('ollama'), 'local');
  assert.equal(S.columnOf('lmstudio'), 'local');
  assert.equal(S.columnOf('hermes'), 'hermes');
  assert.equal(S.columnOf('agent-framework'), 'agent-framework', 'an Agent Framework team has a column of its own (#23)');
  assert.equal(S.columnOf('copilot'), 'copilot');
  assert.equal(S.columnOf(undefined), 'claude-code', 'a session first seen in a hook is Claude Code');
  assert.equal(S.columnOf('something-new'), null);
});

test('security: every call row is Ask by default for every agent kind, also reads and edits inside the worktree (owner decision pending, Claude Code asks today)', () => {
  const none = RULES();
  for (const col of ['claude-code', 'hermes', 'dsh', 'openclaw', 'copilot', 'agent-framework']) {
    for (const row of ['read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets']) {
      if (S.applies(row, col)) assert.equal(S.valueOf(none, '', row, col), 'ask', row + ' ' + col);
    }
  }
  assert.equal(S.valueOf(none, '', 'ungated', 'copilot'), 'off', 'an ungated agent is off until the user turns it on');
  // Agent Framework (#23) is new, so it has no past behavior to keep: its reads and edits inside ask too, unlike the local model.
  assert.equal(S.sourceOf(none, '', 'read-inside', 'agent-framework'), 'default');
  // It is gated and free: no Turn on cell, no cost cell, and each says why.
  assert.deepEqual([S.applies('ungated', 'agent-framework'), S.na('ungated', 'agent-framework')], [false, 'Gated']);
  assert.deepEqual([S.applies('no-cost', 'agent-framework'), S.na('no-cost', 'agent-framework')], [false, 'Free']);
  // Copilot CLI (#22) reads in its folder and runs the commands it rates read-only without asking: ungated, so off too.
  assert.equal(S.valueOf(none, '', 'ungated', 'copilot'), 'off');
  assert.equal(S.valueOf(none, '', 'no-cost', 'copilot'), 'ask', 'it reports no cost: the office asks once per session');
});

test('security: the local model keeps what it did before the Security room: its reads and edits inside the worktree run without a question', () => {
  const none = RULES();
  // Its low calls never were requests (providers/local.mjs ran them at once); the other rows were asked.
  assert.equal(S.valueOf(none, '', 'read-inside', 'local'), 'allow');
  assert.equal(S.valueOf(none, '', 'edit-inside', 'local'), 'allow');
  assert.equal(S.sourceOf(none, '', 'edit-inside', 'local'), 'default');
  for (const row of ['files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets']) assert.equal(S.valueOf(none, '', row, 'local'), 'ask', row);
});

test('security: a click cycles Ask, Allow, Deny; the Secrets rows offer only Ask and Deny', () => {
  assert.equal(S.next('shell', 'ask'), 'allow');
  assert.equal(S.next('shell', 'allow'), 'deny');
  assert.equal(S.next('shell', 'deny'), 'ask');
  assert.equal(S.next('secrets', 'ask'), 'deny');
  assert.equal(S.next('secrets', 'deny'), 'ask');
  assert.deepEqual(S.options('settings'), ['ask', 'deny']);
  assert.equal(S.next('ungated', 'off'), 'on');
});

test('security: a loosening change is a change to Allow or On; Ask and Deny apply at once', () => {
  assert.equal(S.loosens('shell', 'ask', 'allow'), true);
  assert.equal(S.loosens('shell', 'deny', 'allow'), true);
  assert.equal(S.loosens('shell', 'allow', 'deny'), false);
  assert.equal(S.loosens('shell', 'deny', 'ask'), false);
  assert.equal(S.loosens('ungated', 'off', 'on'), true);
  assert.equal(S.loosens('shell', 'allow', 'allow'), false, 'no change is no loosening');
});

test('security: a building override wins over the office-wide rule; the Agents rows are office-wide only', () => {
  const repo = 'c:/work/repo';
  const r = RULES({ 'shell|claude-code': 'deny', 'ungated|copilot': 'on' }, { [repo]: { 'shell|claude-code': 'allow', 'ungated|copilot': 'off' } });
  assert.equal(S.valueOf(r, repo, 'shell', 'claude-code'), 'allow');
  assert.equal(S.sourceOf(r, repo, 'shell', 'claude-code'), 'building');
  assert.equal(S.valueOf(r, 'c:/work/other', 'shell', 'claude-code'), 'deny');
  assert.equal(S.sourceOf(r, 'c:/work/other', 'shell', 'claude-code'), 'office');
  assert.equal(S.sourceOf(r, 'c:/work/other', 'web', 'claude-code'), 'default');
  assert.equal(S.valueOf(r, repo, 'ungated', 'copilot'), 'on', 'no building override on the Agents screen');
  assert.equal(S.valueOf(r, null, 'shell', 'claude-code'), 'deny', 'no building known: the office-wide rule');
});

test('security: a stored value the row does not offer is never used (Secrets is never Allow)', () => {
  const r = RULES({ 'secrets|claude-code': 'allow', 'shell|local': 'maybe' }, { b: { 'settings|local': 'allow' } });
  assert.equal(S.valueOf(r, '', 'secrets', 'claude-code'), 'ask');
  assert.equal(S.valueOf(r, '', 'shell', 'local'), 'ask');
  assert.equal(S.valueOf(r, 'b', 'settings', 'local'), 'ask');
});

test('security: a row that is only for some agent kinds has no cell in the others', () => {
  assert.equal(S.applies('ungated', 'copilot'), true);
  assert.equal(S.applies('ungated', 'openclaw'), false, 'OpenClaw is gated through its office plugin (#77)');
  assert.equal(S.applies('ungated', 'claude-code'), false);
  assert.equal(S.rows.supervise, undefined, 'Supervise in office is per Paperclip agent, on the Agents screen (#76), not a cell');
  assert.equal(S.applies('supervise', 'claude-code'), false);
  assert.equal(S.applies('no-cost', 'hermes'), true);
  assert.equal(S.applies('no-cost', 'claude-code'), false);
  assert.equal(S.applies('shell', 'local'), true);
  assert.equal(typeof S.na('ungated', 'claude-code'), 'string', 'a cell with no rule says why');
  assert.deepEqual([S.word('ask'), S.word('allow'), S.word('deny'), S.word('off'), S.word('on')], ['Ask', 'Allow', 'Deny', 'Off', 'On']);
});

test('the agent kind word: the label of the session\'s kind, from the snapshot\'s kinds', () => {
  const kinds = [{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'lmstudio', label: 'LM Studio' }];
  assert.equal(V.kindWord(mk({ provider: 'lmstudio' }), kinds), 'LM Studio');
  assert.equal(V.kindWord(mk({ provider: 'claude-code' }), kinds), 'Claude Code');
  assert.equal(V.kindWord(mk({ provider: 'copilot' }), kinds), 'copilot', 'a kind the list does not know shows its id, never nothing');
  assert.equal(V.kindWord(mk({ provider: 'ollama' })), 'ollama', 'no list yet');
  assert.equal(V.kindWord(mk({}), kinds), '', 'no kind: no word');
  assert.equal(V.kindWord(null, kinds), '');
});

// The agent kinds of the Open dialog, a room's Add agent and the Agent kinds view (page-core.js and dialogs.js read these).
const CC = { kind: 'claude-code', label: 'Claude Code', paid: true, terminal: true, modes: ['default', 'plan', 'acceptEdits'], needsModel: false, models: [{ id: 'opus', label: 'Opus' }] };
const OL = { kind: 'ollama', label: 'Ollama', paid: false, terminal: false, modes: [], needsModel: true, models: [{ id: 'qwen' }, { id: 'llama', label: 'Llama' }] };
const FALL = [{ value: '', label: 'Default' }, { value: 'opus', label: 'Opus' }];

test('the state of a kind: Checking until it answers, then Ready or Not ready', () => {
  assert.deepEqual(V.kindState(null), { key: 'resting', word: 'Checking' });
  assert.deepEqual(V.kindState({ ...CC, checking: true }), { key: 'resting', word: 'Checking' });
  assert.deepEqual(V.kindState({ ...CC, ready: true }), { key: 'finished', word: 'Ready' });
  assert.deepEqual(V.kindState({ ...OL, ready: false }), { key: 'waiting', word: 'Not ready' });
});

test('model choices: a kind with a default model starts with Default; a local model offers only its models', () => {
  assert.deepEqual(V.modelChoices(CC, FALL), [{ value: '', label: 'Default' }, { value: 'opus', label: 'Opus' }]);
  assert.deepEqual(V.modelChoices(OL, FALL), [{ value: 'qwen', label: 'qwen' }, { value: 'llama', label: 'Llama' }], 'no Default, the id when there is no label');
  assert.equal(V.modelChoices(null, FALL), FALL, 'no kinds yet: the fallback list');
  assert.equal(V.modelChoices({ ...CC, models: [] }, FALL), FALL, 'Claude Code before its answer: the fallback list');
  assert.deepEqual(V.modelChoices({ ...CC, models: [] }), [{ value: '', label: 'Default' }], 'no fallback: Default only');
  assert.deepEqual(V.modelChoices({ ...OL, models: [], checking: true }, FALL), [{ value: '', label: 'Looking for models' }]);
  assert.deepEqual(V.modelChoices({ ...OL, models: [] }, FALL), [{ value: '', label: 'No models' }], 'a local kind never gets the Claude list');
});

test('a kind that needs a model opens only with one; its first model is picked', () => {
  assert.equal(V.firstModel(OL), 'qwen');
  assert.equal(V.firstModel(CC), '', 'a kind with a default model starts on Default');
  assert.equal(V.firstModel({ ...OL, models: [] }), '');
  assert.equal(V.firstModel(null), '');
  assert.equal(V.noModelFor({ ...OL, models: [] }), true);
  assert.equal(V.noModelFor(OL), false);
  assert.equal(V.noModelFor({ ...CC, models: [] }), false, 'Claude Code has a default model');
  assert.equal(V.noModelFor(null), false);
});

test('a kind change keeps only the options that kind takes', () => {
  const form = { provider: 'claude-code', model: 'opus', where: 'terminal', permissionMode: 'plan', name: 'x' };
  assert.deepEqual(V.withKind(form, OL, 'ollama'), { provider: 'ollama', model: 'qwen', where: 'office', permissionMode: '', name: 'x' });
  assert.deepEqual(V.withKind({ ...form, provider: 'ollama' }, CC, 'claude-code'), { ...form, model: '' }, 'Claude Code keeps the window and the mode');
  assert.deepEqual(V.withKind({ ...form, permissionMode: 'bypassPermissions' }, CC, 'claude-code'), { ...form, model: '', permissionMode: '' }, 'a mode the kind does not take is dropped');
  assert.deepEqual(V.withKind(form, null, 'copilot'), { ...form, provider: 'copilot', model: '' }, 'an unknown kind changes nothing else');
});

test('the note of a kind says where it runs and what it costs', () => {
  assert.match(V.kindNote(null, false), /^Runs Claude Code inside the office\./);
  assert.match(V.kindNote(null, true), /^Starts Claude Code in a new terminal window/);
  assert.match(V.kindNote(CC, false), /^Runs Claude Code inside the office\./);
  assert.match(V.kindNote(OL, false), /^Runs a model from Ollama on this machine.*It costs nothing\.$/);
  assert.match(V.kindNote(OL, true), /^Starts Ollama in a new terminal window/);
  // A team (Agent Framework): where its team comes from, how its members show, and that it costs nothing
  const AF = { kind: 'agent-framework', label: 'Agent Framework', paid: false, team: true };
  // Its column of the Security room asks about every call by default, a read inside the worktree too (#23): the note says so.
  assert.equal(V.kindNote(AF, false), 'Runs a team of Agent Framework agents on a model on this machine, inside the office. The team comes from agent-team.json in the folder, '
    + 'or it is a lead, a coder and a reviewer. A member shows as a helper bot while it has the work. Each tool call comes to you for approval, until you set a rule in the Security room. It costs nothing.');
});

test('the agents of a building as one word: the kinds of its sessions, in the order of the kinds, each once', () => {
  const kinds = [{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }];
  assert.equal(V.kindsWord([{ provider: 'ollama' }, { provider: 'claude-code' }, { provider: 'ollama' }], kinds), 'Claude Code, Ollama');
  assert.equal(V.kindsWord([{ provider: 'ollama' }], kinds), 'Ollama');
  assert.equal(V.kindsWord([{ provider: 'copilot' }, { provider: 'ollama' }], kinds), 'Ollama, copilot', 'a kind the list does not know comes last, as its id');
  assert.equal(V.kindsWord([{}], kinds), '', 'a session with no kind adds nothing');
  assert.equal(V.kindsWord([], kinds), '');
});

// ----- adapter features (#72) -----
test('features: only what the agent kind declares, in the table order, with the words the page shows', () => {
  assert.deepEqual(V.featuresOf(mk({ features: ['fork', 'skills', 'resume', 'images', 'nonsense'] })).map((f) => f.key), ['skills', 'fork']);
  assert.deepEqual(V.featuresOf(mk({ features: ['reason', 'teams', 'schedules'] })).map((f) => f.label), ['Reasons', 'Agent teams', 'Scheduled tasks']);
  assert.deepEqual(V.featuresOf(mk({})), []);
  assert.deepEqual(V.featuresOf(null), []);
  assert.equal(V.hasFeature(mk({ features: ['skills'] }), 'skills'), true);
  assert.equal(V.hasFeature(mk({ features: ['skills'] }), 'fork'), false);
  assert.equal(V.hasFeature(mk({}), 'skills'), false);
});

test('requests: the reason an agent gives for a request comes with it, trimmed to one line', () => {
  const s = mk({ pending: [{ id: 'p1', tool: 'Bash', detail: 'npm test', risk: 'medium', t: 1, reason: 'To check\nthe fix.' }, { id: 'p2', tool: 'Read', detail: 'a', risk: 'low', t: 2 }] });
  const r = V.requests(s);
  assert.equal(r[0].reason, 'To check the fix.');
  assert.equal(r[1].reason, '');
});

// Review M2: an agent kind that reports no cost has no spend limit (nothing could stop it), so the Open dialog shows no limit
// field and no "stops at this limit" hint for it: it says that cost is unknown.
test('M2: the spend limit field is for a paid kind that reports cost; a cost-unknown kind says why it has none', () => {
  const CC = { kind: 'claude-code', label: 'Claude Code', paid: true };
  const HERMES = { kind: 'hermes', label: 'Hermes Agent', paid: true, cost: 'unknown' };
  const LOCAL = { kind: 'ollama', label: 'Ollama', paid: false };
  assert.equal(V.limitShown(null), true, 'before the kinds come: Claude Code');
  assert.equal(V.limitShown(CC), true);
  assert.equal(V.limitShown(HERMES), false);
  assert.equal(V.limitShown(LOCAL), false, 'a local model costs nothing');
  assert.equal(V.costNote(HERMES), 'Hermes Agent does not report cost, so the office shows it as unknown and no spend limit can stop it. Check the spend in its own account.');
  assert.equal(V.costNote(CC), '');
  assert.equal(V.costNote(LOCAL), '');
});

// The cloud kinds (#24): off until the owner sets them up, so they read "Not configured", not "Not ready".
const FD = { kind: 'foundry', label: 'Azure AI Foundry', paid: true, cloud: true, terminal: false, modes: [], needsModel: true, modelLabel: 'Foundry agent', models: [] };
const CS = { kind: 'copilot-studio', label: 'Copilot Studio', paid: true, cloud: true, terminal: false, modes: [], needsModel: false, models: [] };

test('a cloud kind that is not set up reads Not configured, blocks Open session, and says so in its title', () => {
  assert.deepEqual(V.kindState({ ...FD, ready: false, configured: false }), { key: 'resting', word: 'Not configured' });
  assert.deepEqual(V.kindState({ ...FD, ready: false, configured: true }), { key: 'waiting', word: 'Not ready' }, 'set up, but the service said no');
  assert.deepEqual(V.kindState({ ...FD, ready: true, configured: true }), { key: 'finished', word: 'Ready' });
  assert.deepEqual(V.kindState({ ...FD, checking: true, configured: false }), { key: 'resting', word: 'Checking' });
  assert.deepEqual(V.kindState({ ...OL, ready: false }), { key: 'waiting', word: 'Not ready' }, 'a kind that does not say configured is as before');
  assert.equal(V.notConfigured({ ...CS, ready: false, configured: false }), true);
  assert.equal(V.notConfigured({ ...CS, ready: false }), false);
  assert.equal(V.notConfigured({ ...CS, ready: false, configured: false, checking: true }), false, 'still asking');
  assert.equal(V.notConfigured(null), false);
  assert.equal(V.needsTitle({ ...CS, configured: false }), 'Copilot Studio is not configured');
  assert.equal(V.needsTitle({ ...CS, configured: true }), 'Copilot Studio is not ready');
  assert.equal(V.needsTitle({ ...OL }), 'Ollama is not ready');
});

test('the pick is called Foundry agent for Foundry and Model for the rest', () => {
  assert.equal(V.modelLabel(FD), 'Foundry agent');
  assert.equal(V.modelLabel(OL), 'Model');
  assert.equal(V.modelLabel(null), 'Model');
});

test('the note of a cloud kind says it runs in your cloud account, costs money, cannot read the folder and never signs in', () => {
  const n = V.kindNote(CS, false);
  assert.match(n, /^Runs Copilot Studio in your Microsoft cloud account\./);
  assert.match(n, /cost money/);
  assert.match(n, /cannot read the folder/);
  assert.match(n, /never signs in/);
});

test('the note of a cloud kind does not promise approvals the office cannot hold: its tools run in the cloud', () => {
  for (const k of [CS, FD]) {
    const n = V.kindNote(k, false);
    assert.doesNotMatch(n, /approve its steps/, k.kind);
    assert.match(n, /tools run in the cloud with no approval here/, k.kind);
    assert.match(n, /Only a request the service sends for approval comes to you/, k.kind);
  }
});

test('the pick of Foundry speaks of agents, not models, in every word around it', () => {
  assert.equal(V.modelNoun(FD), 'agent');
  assert.equal(V.modelNoun(OL), 'model');
  assert.equal(V.modelNoun(null), 'model');
  assert.deepEqual(V.modelChoices(FD), [{ value: '', label: 'No agents' }]);
  assert.deepEqual(V.modelChoices({ ...FD, checking: true }), [{ value: '', label: 'Looking for agents' }]);
  assert.equal(V.pickFact(FD), 'You pick the Foundry agent');
  assert.equal(V.pickFact(OL), 'You pick the model');
  assert.equal(V.pickFact({ ...OL, needsModel: false }), null);
});

test('Paperclip HQ words (#76): an agent\'s state is never "Needs you", budgets, heartbeats, supervision, the connection', () => {
  const H = V.hq;
  assert.deepEqual(H.status({ status: 'running', run: { status: 'running' } }), { key: 'working', word: 'Runs in Paperclip' });
  assert.deepEqual(H.status({ status: 'idle', run: { status: 'queued' } }), { key: 'working', word: 'Queued in Paperclip' });
  assert.deepEqual(H.status({ status: 'idle', run: { status: 'failed' } }), { key: 'error', word: 'Last run failed' });
  assert.deepEqual(H.status({ status: 'error' }), { key: 'error', word: 'Last run failed' });
  assert.deepEqual(H.status({ status: 'paused' }), { key: 'resting', word: 'Paused in Paperclip' });
  assert.equal(H.status({ status: 'pending_approval' }).key, 'resting', 'a Paperclip approval is Paperclip\'s, not an office request');
  assert.deepEqual(H.status({ status: 'idle', run: { status: 'succeeded' } }), { key: 'resting', word: 'Idle' });
  assert.equal(H.budget({ spent: 8.3, limit: 50 }), '$8.30 of $50.00 this month');
  assert.equal(H.budget({ spent: 0, limit: 0 }), '$0.00 this month, no budget');
  assert.equal(H.budget(null), '');
  assert.deepEqual([H.every(30), H.every(1800), H.every(7200), H.every(5400)], ['every 30 s', 'every 30 min', 'every 2 h', 'every 1 h 30 min']);
  assert.equal(H.supervision({ supervision: { state: 'supervised', label: '' } }), 'Supervised in office');
  assert.equal(H.supervision({ supervision: { state: 'unsupervised', label: 'Unsupervised' } }), 'Unsupervised');
  assert.equal(H.state(null), 'Not connected');
  assert.equal(H.state({ state: 'on', url: 'http://127.0.0.1:3100', company: { name: 'Acme' } }), 'Watching Acme at http://127.0.0.1:3100');
  assert.match(H.state({ state: 'lost', url: 'http://127.0.0.1:3100', error: 'No Paperclip answers.' }), /^Lost http:\/\/127\.0\.0\.1:3100: No Paperclip answers\. The office tries again\.$/);
  // a Paperclip run: its role first on the card; its task in place of Paperclip's long wake-up prompt
  const run = mk({ turns: 1, prompt: 'You are Ada. Read your inbox...', hq: { role: 'Engineer', task: 'ACM-12 Add a route' } });
  assert.equal(V.platform(run, [{ kind: 'claude-code', label: 'Claude Code' }]), 'Paperclip Engineer, Claude Code');
  assert.equal(V.platform(mk({ provider: 'claude-code' }), [{ kind: 'claude-code', label: 'Claude Code' }]), 'Claude Code');
  assert.equal(V.taskLine(run), 'ACM-12 Add a route');
  assert.equal(V.taskLine({ ...run, status: 'working' }), 'ACM-12 Add a route');
  assert.equal(V.taskLine({ ...run, status: 'working', tool: { name: 'Bash', detail: 'npm test' } }), 'Bash npm test', 'a running tool still shows');
});

test('tool calls of the cloud agents get a DS tool kind', () => {
  assert.equal(V.toolKind('code_interpreter'), 'terminal');
  assert.equal(V.toolKind('file_search'), 'search');
  assert.equal(V.toolKind('bing_grounding'), 'search');
  assert.equal(V.toolKind('Knowledge'), 'search');
  assert.equal(V.toolKind('Connector'), 'mcp');
  assert.equal(V.toolKind('Topic'), 'flow');
  assert.equal(V.toolKind('Whatever'), 'api');
});

test('todoStatus shows a failed manager step as error', () => {
  assert.equal(V.todoStatus('error'), 'error');
});

test('#101: a model added to the kind reaches the schedule options, the dock switch and the model word', () => {
  const grown = { ...CC, models: [{ id: 'opus', label: 'Opus' }, { id: 'claude-new-9', label: 'Newcomer' }] };
  assert.ok(V.modelChoices(grown, FALL).some((o) => o.value === 'claude-new-9' && o.label === 'Newcomer'), 'schedule form options');
  assert.deepEqual(V.modelSwitch(grown, '', FALL).map((o) => o.value), ['opus', 'claude-new-9'], 'dock switch: no Default entry');
  assert.equal(V.modelWord(grown, 'claude-new-9-20271101', FALL), 'Newcomer');
  assert.equal(V.modelWord(grown, '', FALL), 'Default model');
});

test('#101: the dock switch keeps an unknown current model, and an unknown id is its own word', () => {
  const k = { ...CC, models: [{ id: 'opus', label: 'Opus' }] };
  assert.deepEqual(V.modelSwitch(k, 'claude-old-3', FALL).map((o) => o.value), ['claude-old-3', 'opus']);
  assert.equal(V.modelWord(k, 'claude-old-3', FALL), 'claude-old-3');
});

test('#101: before the first answer Claude Code uses the fallback; a local kind never shows Claude models', () => {
  assert.equal(V.modelWord({ ...CC, models: [] }, 'opus', FALL), 'Opus');
  assert.equal(V.modelWord(null, 'opus', FALL), 'Opus');
  assert.deepEqual(V.modelSwitch({ ...CC, models: [] }, '', FALL).map((o) => o.value), ['opus']);
  assert.equal(V.modelWord(OL, 'opus', FALL), 'opus', 'a local kind has no Claude labels');
  assert.deepEqual(V.modelSwitch({ ...OL, models: [] }, '', FALL), []);
});

// The Manager board (#157): one view of the snapshot's plans field, for the panel, the room wall, Ctrl+K and Needs you.
const st = (id, state, o = {}) => ({ id, title: 'Step ' + id, state, word: V.plan.stepWord(state), owner: '', cost: null, raw: '', model: '', budget: null, uid: '', skipped: false, skippedWhy: '', ...o });
const pl = (o) => ({ id: 'g1', building: 'b', goal: 'Ship it', status: '', reason: '', frozen: false, source: 'office', sourceWord: 'Office', steps: [], ...o });
test('plan board: the source word, the read-only state and the counts of each goal', () => {
  const v = V.plan.board({ plans: [pl({ status: 'running', steps: [st('a', 'finished'), st('b', 'working')] }), pl({ id: 'p', source: 'paperclip', sourceWord: 'Paperclip', goal: 'Co tasks', steps: [st('t', 'pending')] })], unreadable: [] });
  assert.deepEqual(v.groups.map((g) => [g.sourceWord, g.readOnly, g.stateWord, g.done, g.total]), [['Office', false, 'Running', 1, 2], ['Paperclip', true, '', 0, 1]]);
  assert.equal(v.groups[1].note, 'Read only. Paperclip plans this work.');
  assert.equal(v.groups[0].note, '');
});
test('plan board: a frozen plan says Not connected, an unreadable source says it could not be read', () => {
  const v = V.plan.board({ plans: [pl({ source: 'paperclip', sourceWord: 'Paperclip', status: 'not-connected', frozen: true, reason: V.plan.notConnectedReason('gone'), steps: [st('t', 'working')] })], unreadable: [{ source: 'paperclip', word: 'Paperclip' }] });
  assert.equal(v.groups[0].stateWord, 'Not connected');
  assert.equal(v.groups[0].note, 'Not connected. gone The steps are the last ones read.');
  assert.deepEqual(v.unreadable, ['The Paperclip plan could not be read. It is not shown.']);
});
test('plan board: a building filter, and the goals that wait for the owner', () => {
  const plans = [pl({ id: 'x', building: 'b', status: 'awaiting-approval', steps: [st('a', 'pending')] }), pl({ id: 'y', building: 'c', status: 'awaiting-approval' }), pl({ id: 'z', building: 'b', status: 'running', steps: [st('e', 'error', { title: 'Fix' })] })];
  assert.deepEqual(V.plan.board({ plans, unreadable: [] }, 'b').groups.map((g) => g.id), ['x', 'z']);
  assert.deepEqual(V.plan.waits({ plans, unreadable: [] }).map((w) => [w.id, w.text]), [['x', 'Approve the plan: Ship it'], ['y', 'Approve the plan: Ship it'], ['z', 'Step failed: Fix']]);
  assert.deepEqual(V.plan.board(undefined).groups, []);
});
test('plan board: no plans is one empty answer, and an unknown state is neutral, never done', () => {
  assert.equal(V.plan.board({ plans: [], unreadable: [] }).empty, true);
  const g = V.plan.board({ plans: [pl({ source: 'paperclip', sourceWord: 'Paperclip', steps: [st('u', 'unknown', { raw: 'weird' })] })], unreadable: [] }).groups[0];
  assert.equal(g.done, 0);
  assert.equal(g.steps[0].word, 'Unknown');
});

// The goal handoff (#159): what the Manager board shows around the painted Confirm, the failed state and the link to Paperclip.
test('plan board: a goal that can go to Paperclip, and what a handoff record says', () => {
  const g = (o) => V.plan.board({ plans: [pl({ steps: [st('a', 'pending'), st('b', 'pending')], ...o })], unreadable: [] }).groups[0];
  for (const s of ['awaiting-approval', 'blocked', 'stopped', 'handoff-failed']) assert.equal(g({ status: s }).handoffable, true, s);
  for (const s of ['planning', 'running', 'finished', 'failed', 'cancelled', 'handed-off']) assert.equal(g({ status: s }).handoffable, false, s);
  assert.equal(g({ status: 'blocked', steps: [st('a', 'working')] }).handoffable, false, 'a step runs');
  assert.equal(g({ status: 'blocked', steps: [] }).handoffable, false, 'no steps');
  assert.equal(g({ status: 'blocked', source: 'paperclip' }).handoffable, false, 'a Paperclip plan is read only');
  assert.equal(g({ status: 'blocked' }).handoff, null);
  const h = g({ status: 'handoff-failed', handoff: { company: 'Acme', tasks: { a: 'i1' } } }).handoff;
  assert.deepEqual([h.company, h.written, h.left, h.failed, h.done], ['Acme', 1, 1, true, false]);
  const d = g({ status: 'handed-off', handoff: { company: 'Acme', tasks: { a: 'i1', b: 'i2' } } }).handoff;
  assert.deepEqual([d.written, d.left, d.failed, d.done], [2, 0, false, true]);
});
test('plan handoff words: the preview rows mark the tasks already written, and the notes are plain', () => {
  const rows = V.plan.handoffRows([{ step: 'a', title: 'One', description: 'm\n\nbody' }, { step: 'b', title: 'Two', description: 'm2' }], { a: 'i1' });
  assert.deepEqual(rows.map((r) => [r.step, r.title, r.written]), [['a', 'One', true], ['b', 'Two', false]]);
  assert.equal(rows[1].description, 'm2');
  assert.deepEqual(V.plan.handoffRows(undefined, undefined), []);
  assert.equal(V.plan.handoffFailed({ company: 'Acme', written: 2, left: 1 }), 'Handoff failed. 2 tasks are in Acme. 1 task is left. Retry writes only the rest.');
  assert.equal(V.plan.handoffDone({ company: 'Acme', written: 1 }), '1 task is in Acme. Paperclip plans this work now. The office does not run it.');
});
