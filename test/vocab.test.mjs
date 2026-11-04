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
