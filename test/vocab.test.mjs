// Session vocabulary: one table of session fixtures, one expected status, task line and figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/vocab.js';

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
  assert.deepEqual(V.figures(list), { sessions: 3, working: 1, waiting: 1, toolCalls: 3, tokens: 2000, cost: 0.75, priced: 2, todosDone: 1, todosTotal: 2, lastEvent: 20 });
  assert.equal(V.figures([]).sessions, 0);
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

test('security: six screens on three walls, each with its rows; five agent kinds as columns', () => {
  assert.deepEqual(S.screens.map((x) => x.title), ['Files', 'Commands', 'Network', 'Secrets', 'Agents', 'Spend']);
  assert.deepEqual(S.screens.find((x) => x.id === 'files').rows, ['read-inside', 'edit-inside', 'files-outside']);
  assert.deepEqual(S.screens.find((x) => x.id === 'secrets').rows, ['settings', 'secrets']);
  assert.deepEqual(S.columns.map((c) => c.label), ['Claude Code', 'Hermes', 'dsh', 'OpenClaw', 'Local model']);
  assert.equal(S.rows.shell.label, 'Shell commands');
  assert.equal(S.rows['files-outside'].label, 'Read or edit outside it');
});

test('security: an agent kind is the column of its provider; the two local providers share one', () => {
  assert.equal(S.columnOf('claude-code'), 'claude-code');
  assert.equal(S.columnOf('ollama'), 'local');
  assert.equal(S.columnOf('lmstudio'), 'local');
  assert.equal(S.columnOf('hermes'), 'hermes');
  assert.equal(S.columnOf(undefined), 'claude-code', 'a session first seen in a hook is Claude Code');
  assert.equal(S.columnOf('something-new'), null);
});

test('security: defaults copy riskOf: reads and edits inside the worktree are Allow, the rest is Ask', () => {
  const none = RULES();
  for (const col of ['claude-code', 'local']) {
    assert.equal(S.valueOf(none, '', 'read-inside', col), 'allow');
    assert.equal(S.valueOf(none, '', 'edit-inside', col), 'allow');
    for (const row of ['files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets']) assert.equal(S.valueOf(none, '', row, col), 'ask', row);
  }
  assert.equal(S.valueOf(none, '', 'ungated', 'openclaw'), 'off', 'an ungated agent is off until the user turns it on');
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
  assert.equal(S.loosens('supervise', 'off', 'on'), true);
  assert.equal(S.loosens('shell', 'allow', 'allow'), false, 'no change is no loosening');
});

test('security: a building override wins over the office-wide rule; the Agents rows are office-wide only', () => {
  const repo = 'c:/work/repo';
  const r = RULES({ 'shell|claude-code': 'deny', 'ungated|openclaw': 'on' }, { [repo]: { 'shell|claude-code': 'allow', 'ungated|openclaw': 'off' } });
  assert.equal(S.valueOf(r, repo, 'shell', 'claude-code'), 'allow');
  assert.equal(S.sourceOf(r, repo, 'shell', 'claude-code'), 'building');
  assert.equal(S.valueOf(r, 'c:/work/other', 'shell', 'claude-code'), 'deny');
  assert.equal(S.sourceOf(r, 'c:/work/other', 'shell', 'claude-code'), 'office');
  assert.equal(S.sourceOf(r, 'c:/work/other', 'web', 'claude-code'), 'default');
  assert.equal(S.valueOf(r, repo, 'ungated', 'openclaw'), 'on', 'no building override on the Agents screen');
  assert.equal(S.valueOf(r, null, 'shell', 'claude-code'), 'deny', 'no building known: the office-wide rule');
});

test('security: a stored value the row does not offer is never used (Secrets is never Allow)', () => {
  const r = RULES({ 'secrets|claude-code': 'allow', 'shell|local': 'maybe' }, { b: { 'settings|local': 'allow' } });
  assert.equal(S.valueOf(r, '', 'secrets', 'claude-code'), 'ask');
  assert.equal(S.valueOf(r, '', 'shell', 'local'), 'ask');
  assert.equal(S.valueOf(r, 'b', 'settings', 'local'), 'ask');
});

test('security: a row that is only for some agent kinds has no cell in the others', () => {
  assert.equal(S.applies('ungated', 'openclaw'), true);
  assert.equal(S.applies('ungated', 'claude-code'), false);
  assert.equal(S.applies('supervise', 'claude-code'), true);
  assert.equal(S.applies('supervise', 'local'), false);
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

// The agent kinds of the Open dialog, a room's Add agent and the Agent kinds view (office.js reads these).
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
});

test('the agents of a building as one word: the kinds of its sessions, in the order of the kinds, each once', () => {
  const kinds = [{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }];
  assert.equal(V.kindsWord([{ provider: 'ollama' }, { provider: 'claude-code' }, { provider: 'ollama' }], kinds), 'Claude Code, Ollama');
  assert.equal(V.kindsWord([{ provider: 'ollama' }], kinds), 'Ollama');
  assert.equal(V.kindsWord([{ provider: 'copilot' }, { provider: 'ollama' }], kinds), 'Ollama, copilot', 'a kind the list does not know comes last, as its id');
  assert.equal(V.kindsWord([{}], kinds), '', 'a session with no kind adds nothing');
  assert.equal(V.kindsWord([], kinds), '');
});
