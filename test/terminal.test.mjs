// Desk terminals: the stats monitor's rows (terminal.js statsOf). The painting needs a canvas and is not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../public/screen-kit.js');
await import('../public/format.js');
await import('../public/vocab.js'); // terminal.js reads the supervision words (#73) and kind words from it, as on the page
await import('../public/terminal.js');
const T = globalThis.OfficeTerminal;
const labels = (S) => S.rows.map((r) => r[0]);
const row = (S, name) => (S.rows.find((r) => r[0] === name) || [])[1];

test('the stats monitor names the agent kind, and a to-do list keeps the rows it had before kinds came', () => {
  const s = { uid: 'u', headless: true, model: 'qwen2.5', mode: '', cost: 0, turns: 1, startedAt: Date.now(), calls: [], todos: [] };
  const none = T.stats(s, 'Ollama');
  assert.deepEqual(labels(none), ['Agent', 'Model', 'Context', 'Tokens', 'Spend', 'Time', 'Tools']);
  assert.equal(row(none, 'Agent'), 'Ollama · in the office');
  assert.equal(row(none, 'Model'), 'qwen2.5');

  const todo = T.stats({ ...s, model: 'opus', mode: 'plan', todos: [{ text: 'a', status: 'in_progress' }] }, 'Claude Code');
  assert.deepEqual(labels(todo), ['Agent', 'Context', 'Spend'], 'three rows, as before: the to-do list keeps its lines');
  assert.equal(row(todo, 'Agent'), 'Claude Code · opus · Plan only', 'the kind, the model and the mode in one row');
  assert.equal(todo.todos.length, 1);

  assert.equal(row(T.stats({ ...s, headless: false }, ''), 'Agent'), 'in a terminal', 'no kind word: where it runs only');
  assert.equal(row(T.stats({ ...s, model: '', todos: [{ text: 'a' }] }, ''), 'Agent'), 'default', 'no kind and no model');
  assert.equal(T.stats(null).note, 'No session at this desk.');
});

// #164: the Context row reads the one vocabulary rule: a percent when the agent reported both numbers, the word unknown otherwise.
test('the Context row: a percent when the agent reports its context, "unknown" and an empty bar when it does not', () => {
  const s = { uid: 'u', headless: true, model: 'm', cost: 0, turns: 1, startedAt: Date.now(), calls: [], todos: [] };
  const ctx = (x) => T.stats({ ...s, ...x }, 'Hermes Agent').rows.find((r) => r[0] === 'Context');
  assert.deepEqual(ctx({ ctxTokens: 15259, ctxWindow: 128000 }), ['Context', '12%', 'bar', 12]);
  assert.deepEqual(ctx({ ctxTokens: 0, ctxWindow: 128000 }), ['Context', '0%', 'bar', 0], 'an empty context is 0%, not unknown');
  assert.deepEqual(ctx({ ctxTokens: 900000, ctxWindow: 128000 }), ['Context', '100%', 'bar', 100]);
  for (const x of [{}, { ctxTokens: 5000 }, { ctxWindow: 128000 }, { ctxTokens: 5, ctxWindow: 0 }, { ctxTokens: null, ctxWindow: null }]) assert.deepEqual(ctx(x), ['Context', 'unknown', 'bar', null], JSON.stringify(x));
  assert.deepEqual(globalThis.OfficeVocab.context({ ctxTokens: 50, ctxWindow: 200 }), { pct: 25, word: '25%' });
  assert.equal(T.foot({ ...s, ctxTokens: 15259, ctxWindow: 128000 }).right, 'context 12% · $0.00');
  assert.equal(T.foot({ ...s }).right, 'context unknown · $0.00', 'the desk footer says unknown too, and draws no bar');
  assert.equal(T.foot({ ...s }).pct, null);
  assert.deepEqual(globalThis.OfficeVocab.context(null), { pct: null, word: 'unknown' });
});

test('desk trays (#93): the inbox tray holds queued office messages, the outbox tray holds what waits on the user', () => {
  assert.deepEqual(T.trays(null), { inbox: 0, outbox: 0 });
  assert.deepEqual(T.trays({}), { inbox: 0, outbox: 0 }, 'a session with no lists shows empty trays');
  const s = { inbox: [{ text: 'a' }, { text: 'b' }], pending: [{ id: 'p' }], questions: [{ id: 'q' }, { id: 'r' }] };
  assert.deepEqual(T.trays(s), { inbox: 2, outbox: 3 });
  assert.deepEqual(T.trays({ ...s, pseudo: true }), { inbox: 0, outbox: 0 }, 'a helper has no session of its own');
});
