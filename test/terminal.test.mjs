// Desk terminals: the stats monitor's rows (terminal.js statsOf). The painting needs a canvas and is not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
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
