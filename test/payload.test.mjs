// The server half of the waiting rule: which tool results settle a pending request.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/vocab.js';
import { describeTool, settles } from '../payload.mjs';

const V = globalThis.OfficeVocab;
const base = { status: 'waiting', turns: 1, pending: [], questions: [], calls: [], todos: [], usage: { tokens: 0 }, error: null, cost: null, lastEvent: 0, note: '', prompt: '', live: '', tool: null };
const req = (o = {}) => ({ id: 'p1', agent: null, tool: 'Bash', detail: 'npm test', ...o });
const post = (o) => ({ tool_name: 'Bash', tool_input: { command: 'npm test' }, agent_id: null, ...o });
// What the server does on a PostToolUse: drop the requests the result settles.
const apply = (pending, p) => pending.filter((r) => !settles(r, p));

test('describeTool labels a call', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(describeTool('Read', { file_path: 'C:\\a\\b.txt' }), 'b.txt');
});
test('a subagent result does not settle the main request, and the session keeps waiting', () => {
  const pending = apply([req()], post({ agent_id: 'a1' }));
  assert.equal(pending.length, 1);
  assert.equal(V.isWaiting({ ...base, pending }), true);
  assert.equal(V.status({ ...base, status: 'working', pending }).key, 'waiting');
});
test('a parallel main-agent result for another tool does not settle', () => {
  assert.equal(apply([req()], post({ tool_name: 'Read', tool_input: { file_path: 'x.js' } })).length, 1);
});
test('the matching main-agent result settles', () => {
  assert.equal(apply([req()], post()).length, 0);
});
test('a subagent request is settled only by the same subagent', () => {
  const r = req({ agent: 'a1' });
  assert.equal(apply([r], post()).length, 1);
  assert.equal(apply([r], post({ agent_id: 'a2' })).length, 1);
  assert.equal(apply([r], post({ agent_id: 'a1' })).length, 0);
});
