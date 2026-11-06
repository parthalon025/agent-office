// The server half of the waiting rule: which tool results settle a pending request.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/vocab.js';
import { describeTool, callKey, settles, slimPayload } from '../src/payload.mjs';

const V = globalThis.OfficeVocab;
const base = { status: 'waiting', turns: 1, pending: [], questions: [], calls: [], todos: [], usage: { tokens: 0 }, error: null, cost: null, lastEvent: 0, note: '', prompt: '', live: '', tool: null };
// A hook payload as the server gets it (trimmed by slimPayload), and the request a PermissionRequest makes.
const hook = (ev, o = {}) => slimPayload({ hook_event_name: ev, session_id: 's', cwd: 'C:\\r', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...o });
const req = (o = {}) => { const p = hook('PermissionRequest', o); return { id: 'p1', key: callKey(p), agent: p.agent_id, tool: p.tool_name, detail: describeTool(p.tool_name, p.tool_input) }; };
const post = (o = {}) => hook('PostToolUse', { tool_use_id: 'tu', tool_response: { stdout: 'x' }, ...o });
// What the server does on a PostToolUse: drop the requests the result settles.
const apply = (pending, p) => pending.filter((r) => !settles(r, p));

test('describeTool labels a call', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(describeTool('Read', { file_path: 'C:\\a\\b.txt' }), 'b.txt');
  assert.equal(describeTool('mcp__plugin_playwright_playwright__browser_click', { element: 'Save' }), 'Save');
  assert.equal(describeTool('Other', { query: 'q' }), 'q');
});
test('the PermissionRequest and the PostToolUse of one call give the same key', () => {
  const input = { description: 'Run the tests', command: 'npm test', timeout: 5000 };
  assert.equal(callKey(hook('PermissionRequest', { tool_input: input })), callKey(post({ tool_input: { ...input } })));
  assert.ok(callKey(post()).includes('npm test'));
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
test('a result for another input with the same short label does not settle', () => {
  // Same basename in two folders: describeTool gives "index.js" for both.
  const one = req({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/one/index.js' } });
  const two = req({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/two/index.js' } });
  assert.equal(one.detail, two.detail, 'the labels are the same');
  const left = apply([one, two], post({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/one/index.js' } }));
  assert.deepEqual(left, [two]);
  // Two commands with the same first 89 characters: the label clips both to the same text.
  const head = 'x'.repeat(95);
  const a = req({ tool_input: { command: head + ' a' } }), b = req({ tool_input: { command: head + ' b' } });
  assert.equal(a.detail, b.detail);
  assert.deepEqual(apply([a, b], post({ tool_input: { command: head + ' b' } })), [a]);
});
test('a subagent request is settled only by the same subagent', () => {
  const r = req({ agent_id: 'a1' });
  assert.equal(apply([r], post()).length, 1);
  assert.equal(apply([r], post({ agent_id: 'a2' })).length, 1);
  assert.equal(apply([r], post({ agent_id: 'a1' })).length, 0);
});

// The Security room rates a PreToolUse call before it runs (#70): it needs the whole path and the glob, never contents.
test('PreToolUse keeps the path fields the rating needs, whole: file_path, notebook_path, path, pattern, glob', () => {
  const long = 'C:/work/repo/' + 'a/'.repeat(200) + '../'.repeat(210) + '.env';
  const p = slimPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Grep',
    tool_input: { pattern: 'KEY', glob: '.env*', path: long, content: 'secret text', old_string: 'x' } });
  assert.deepEqual(p.rate_input, { path: long, pattern: 'KEY', glob: '.env*' });
  assert.ok(p.tool_input.path.length < long.length, 'the shown input stays short');
  assert.equal(p.tool_input.glob, undefined, 'the shown input is unchanged');
  const e = slimPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb', new_source: 'code' } });
  assert.deepEqual(e.rate_input, { notebook_path: 'n.ipynb' });
  assert.equal(slimPayload({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: 'a' } }).rate_input, undefined);
});
