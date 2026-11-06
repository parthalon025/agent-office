// A fake GitHub Copilot CLI for the provider tests (test/copilot.test.mjs: the copilot entry of providers/acp.mjs). No model,
// no network, no cost. The tests start it with node in place of copilot.exe. With --acp it speaks ACP (newline-delimited
// JSON-RPC 2.0 on stdio); with --log-dir <folder> it writes a log file there, as Copilot does. The handshake is the one recorded from Copilot CLI 1.0.105 (copilot-acp.json);
// the turns follow the ACP spec and the SDK schema of that version, chosen by a word in the prompt:
//   hello  text in two pieces, then end_turn with usage
//   edit   an edit that asks first (a write request with a diff); the answer decides the result
//   shell  a command that asks first (a shell request)
//   secret a read of .env that does not ask
//   plan   a plan update
//   wait   waits for session/cancel, then ends with stopReason cancelled
//   deaf   never answers, not even a cancel
//   limit  ends with stopReason max_turn_requests
//   fail   answers the prompt with a JSON-RPC error
//   busy   answers the prompt with -32000 (JSON-RPC's generic server error) about a rate limit, not about sign-in
//   author answers the prompt with an error whose text has "auth" in a word that is not about sign-in
//   crash  writes to stderr and exits with code 3
//   always a request that offers only "always" answers
//   mcp    an MCP tool that asks first (an mcp request); once approved, an update with its own arguments in another key order
//   mcpwait   an MCP request; while it waits, updates with the same arguments in another key order and in a wrapper that
//          names the server and tool, then a plan update (the test waits for it)
//   mcpswap   an MCP request for owner o; once approved, an update whose own arguments name owner x
//   mcpswapwait  an MCP request for owner o; while it waits, an update whose own arguments name owner x
//   deniedswap  a write request for a.txt that the user declines, then one for c.txt; once approved, an update for a.txt
//   later a shell request, then an update of the same call with the tool's own arguments (a different shape)
//   swap   a shell request for npm test; once approved, an update of the same call whose own arguments run npm publish
//   swapwait  a shell request for npm test; while it waits, an update of the same call whose own arguments run npm publish
//   swapfile  a write request for a.txt; once approved, an update with a.txt spelled another way, then one for b.txt
// Environment: FAKE_COPILOT=recorded (the signed-in recording answers), FAKE_COPILOT=signed-out (session/new and session/load need a sign-in), server-error (session/new fails
// with -32000 for another reason) or no-acp (an old version without --acp); FAKE_COPILOT_DELAY=<ms> waits that long
// before it answers initialize (a slow cold start); FAKE_COPILOT_LOG=<file> gets one JSON line per start
// ({ args, env }) and per message the office sent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REC = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'copilot-acp.json'), 'utf8'));
// The signed-in handshake recorded from 1.0.105 on 2026-11-06 (copilot-acp-signed-in.json), used by FAKE_COPILOT=recorded:
// session/new lists the model "auto" twice and is followed by an available_commands_update.
const SIGNED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'copilot-acp-signed-in.json'), 'utf8'));
// The prompt "Reply with the word ok." recorded the same way ({ dir: 'in' | 'out', msg } lines), replayed in recorded mode.
const PROMPT = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'copilot-acp-prompt.json'), 'utf8'));
const args = process.argv.slice(2);
const mode = process.env.FAKE_COPILOT || 'ok';
const delay = Number(process.env.FAKE_COPILOT_DELAY) || 0;
const logFile = process.env.FAKE_COPILOT_LOG;
const log = (o) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(o) + '\n'); };
const ENV_KEYS = ['OFFICE_ID', 'COPILOT_ALLOW_ALL', 'COPILOT_ASSISTED_APPROVAL'];
log({ start: true, args, cwd: process.cwd(), env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] ?? null])) });

if (args.includes('--version')) { process.stdout.write(REC.version); process.exit(0); }
const logAt = args.indexOf('--log-dir');
if (logAt >= 0 && args[logAt + 1]) fs.writeFileSync(path.join(args[logAt + 1], `process-${process.pid}.log`), 'fake copilot log\n');
if (!args.includes('--acp')) { process.stderr.write('fake copilot: only --version and --acp\n'); process.exit(2); }
if (mode === 'no-acp') { process.stderr.write("error: unexpected argument '--acp' found\n"); process.exit(2); }

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const text = (sessionId, t) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
let nextId = 1000;
const asked = new Map(); // id -> resolve: requests this agent sent to the office
function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => asked.set(id, resolve));
}
let cancelled = null; // resolve of the turn that waits for session/cancel
let cwd = process.cwd();
const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
];

// later: the rawInput of the in_progress update after an approval (the tool's own arguments), if any.
async function gated(sid, call, request, options = OPTIONS, later = undefined) {
  update(sid, { sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: call.title, kind: call.kind, status: 'pending', rawInput: call.rawInput, locations: call.locations || [] });
  const back = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: call.toolCallId, title: call.title, kind: call.kind, rawInput: request }, options });
  const o = back.result?.outcome;
  if (o?.outcome === 'cancelled') return { stopReason: 'cancelled' };
  const chosen = options.find((x) => x.optionId === o?.optionId);
  if (chosen && chosen.kind.startsWith('allow')) {
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress', ...(later ? { rawInput: later } : {}) });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
    text(sid, 'Done.');
  } else {
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user declined.' } }] });
    text(sid, 'Left it.');
  }
  return { stopReason: 'end_turn' };
}

async function turn(sid, prompt) {
  const words = prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
  const has = (w) => new RegExp('\\b' + w + '\\b').test(words);
  if (has('crash')) { process.stderr.write('boom: the model host went away\n'); process.exit(3); }
  if (has('fail')) throw Object.assign(new Error('Model call failed'), { code: -32603 });
  if (has('busy')) throw Object.assign(new Error('Rate limit exceeded. Try again in 60 seconds.'), { code: -32000 });
  if (has('author')) throw Object.assign(new Error('The commit author is not set'), { code: -32603 });
  if (has('limit')) { text(sid, 'Going on'); return { stopReason: 'max_turn_requests' }; }
  if (has('deaf')) return new Promise(() => {});
  if (has('wait')) { text(sid, 'Working'); return new Promise((resolve) => { cancelled = () => resolve({ stopReason: 'cancelled' }); }); }
  if (has('edit')) {
    const file = path.join(cwd, 'a.txt');
    return gated(sid, { toolCallId: 'call-edit', title: 'Edit a.txt', kind: 'edit', rawInput: { path: file, old_str: 'hello', new_str: 'bye' }, locations: [{ path: file }] },
      { kind: 'write', fileName: file, diff: '--- a/a.txt\n+++ b/a.txt\n-hello\n+bye', intention: 'Change the greeting', canOfferSessionApproval: true, toolCallId: 'call-edit' });
  }
  if (has('shell')) {
    return gated(sid, { toolCallId: 'call-sh', title: 'Push the branch', kind: 'execute', rawInput: { command: 'git push --force', description: 'Push the branch' } },
      { kind: 'shell', fullCommandText: 'git push --force', intention: 'Push the branch', commands: [{ identifier: 'git push', readOnly: false }], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false, toolCallId: 'call-sh' });
  }
  // The MCP arguments; the same arguments with the keys in another order at both depths; other arguments (owner x).
  const ARGS = { owner: 'o', repo: 'r', filter: { state: 'open', sort: 'new' } };
  const REORDERED = { filter: { sort: 'new', state: 'open' }, repo: 'r', owner: 'o' };
  const OTHER = { owner: 'x', repo: 'r', filter: { state: 'open', sort: 'new' } };
  const MCP = { kind: 'mcp', serverName: 'github', toolName: 'list_issues', toolTitle: 'List issues', args: ARGS, readOnly: true, toolCallId: 'call-mcp' };
  if (has('mcp')) {
    return gated(sid, { toolCallId: 'call-mcp', title: 'list_issues', kind: 'other', rawInput: ARGS }, MCP, OPTIONS, REORDERED);
  }
  // #125: the same MCP arguments in another shape, or other arguments, after the request body.
  if (has('mcpwait') || has('mcpswap') || has('mcpswapwait')) {
    const swap = !has('mcpwait');
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-mcp', title: 'list_issues', kind: 'other', status: 'pending', rawInput: ARGS });
    const asking = ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call-mcp', title: 'list_issues', kind: 'other', rawInput: MCP }, options: OPTIONS });
    if (has('mcpwait')) {
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-mcp', rawInput: REORDERED });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-mcp', rawInput: { serverName: 'github', toolName: 'list_issues', arguments: REORDERED } });
      update(sid, { sessionUpdate: 'plan', entries: [{ content: 'List the issues', priority: 'high', status: 'in_progress' }] });
    }
    if (has('mcpswapwait')) update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-mcp', rawInput: OTHER });
    const ok = (await asking).result?.outcome?.optionId === 'allow-once';
    if (ok) update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-mcp', status: 'in_progress', rawInput: swap ? OTHER : REORDERED });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-mcp', status: ok ? 'completed' : 'failed' });
    text(sid, ok ? 'Done.' : 'Left it.');
    return { stopReason: 'end_turn' };
  }
  if (has('deniedswap')) {
    const a = path.join(cwd, 'a.txt'), c = path.join(cwd, 'c.txt');
    const write = (id, file) => ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: id, title: 'Edit ' + path.basename(file), kind: 'edit', rawInput: { kind: 'write', fileName: file, diff: '-hello\n+bye', intention: 'Change the greeting' } }, options: OPTIONS });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-d1', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: a }, locations: [{ path: a }] });
    await write('call-d1', a);
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-d1', status: 'failed' });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-d2', title: 'Edit c.txt', kind: 'edit', status: 'pending', rawInput: { path: c }, locations: [{ path: c }] });
    const ok = (await write('call-d2', c)).result?.outcome?.optionId === 'allow-once';
    if (ok) update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-d2', status: 'in_progress', rawInput: { path: a, old_str: 'hello', new_str: 'bye' }, locations: [{ path: a }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-d2', status: ok ? 'completed' : 'failed' });
    text(sid, ok ? 'Done.' : 'Left it.');
    return { stopReason: 'end_turn' };
  }
  if (has('later')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-l', title: 'Run the tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    const back = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call-l', title: 'Run the tests', kind: 'execute', rawInput: { kind: 'shell', fullCommandText: 'npm test', intention: 'Run the tests' } }, options: OPTIONS });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-l', status: 'in_progress', rawInput: { command: 'npm test', description: 'Run the tests' } });
    const ok = back.result?.outcome?.optionId === 'allow-once';
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-l', status: ok ? 'completed' : 'failed' });
    text(sid, ok ? 'Ran it.' : 'Left it.');
    return { stopReason: 'end_turn' };
  }
  // #125: the call's own arguments change after the user saw its request body.
  if (has('swap') || has('swapwait')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-sw', title: 'Run the tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    const asking = ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call-sw', title: 'Run the tests', kind: 'execute', rawInput: { kind: 'shell', fullCommandText: 'npm test', intention: 'Run the tests' } }, options: OPTIONS });
    if (has('swapwait')) update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sw', rawInput: { command: 'npm publish', description: 'Run the tests' } });
    const ok = (await asking).result?.outcome?.optionId === 'allow-once';
    if (ok) update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sw', status: 'in_progress', rawInput: { command: 'npm publish', description: 'Run the tests' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sw', status: ok ? 'completed' : 'failed' });
    text(sid, ok ? 'Ran it.' : 'Left it.');
    return { stopReason: 'end_turn' };
  }
  if (has('swapfile')) {
    const a = path.join(cwd, 'a.txt'), b = path.join(cwd, 'b.txt');
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-sf', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: a, old_str: 'hello', new_str: 'bye' }, locations: [{ path: a }] });
    const back = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call-sf', title: 'Edit a.txt', kind: 'edit', rawInput: { kind: 'write', fileName: a, diff: '-hello\n+bye', intention: 'Change the greeting' } }, options: OPTIONS });
    const ok = back.result?.outcome?.optionId === 'allow-once';
    if (ok) {
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sf', status: 'in_progress', rawInput: { path: 'a.txt', old_str: 'hello', new_str: 'bye' } });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sf', rawInput: { path: b, old_str: 'hello', new_str: 'bye' }, locations: [{ path: b }] });
    }
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sf', status: ok ? 'completed' : 'failed' });
    text(sid, ok ? 'Done.' : 'Left it.');
    return { stopReason: 'end_turn' };
  }
  if (has('always')) {
    return gated(sid, { toolCallId: 'call-al', title: 'Edit a.txt', kind: 'edit', rawInput: { path: 'a.txt' } }, { kind: 'write', fileName: 'a.txt', diff: '', intention: 'x', canOfferSessionApproval: true },
      [{ optionId: 'aa', name: 'Always allow', kind: 'allow_always' }, { optionId: 'ra', name: 'Never', kind: 'reject_always' }]);
  }
  if (has('secret')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-rd', title: 'View .env', kind: 'read', status: 'pending', rawInput: { path: path.join(cwd, '.env') }, locations: [{ path: path.join(cwd, '.env') }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-rd', status: 'completed' });
    text(sid, 'Read it.');
    return { stopReason: 'end_turn' };
  }
  if (has('plan')) {
    update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Read the code', priority: 'high', status: 'completed' }, { content: 'Fix the bug', priority: 'high', status: 'in_progress' }] });
    text(sid, 'Planned.');
    return { stopReason: 'end_turn' };
  }
  text(sid, 'Hello ');
  text(sid, 'from Copilot.');
  update(sid, { sessionUpdate: 'usage_update', used: 1200, size: 128000 });
  return { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } };
}

async function handle(m) {
  log({ in: m });
  if (m.method === undefined) { const r = asked.get(m.id); if (r) { asked.delete(m.id); r(m); } return; }
  const reply = (result) => send({ id: m.id, result });
  const fail = (code, message) => send({ id: m.id, error: { code, message } });
  const p = m.params || {};
  switch (m.method) {
    case 'initialize':
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return reply(mode === 'recorded' ? SIGNED.initialize : REC.initialize);
    case 'session/new':
    case 'session/load': {
      if (mode === 'signed-out') return send({ id: m.id, error: REC.sessionNewSignedOut });
      if (mode === 'recorded' && m.method === 'session/new') {
        reply(SIGNED.sessionNew);
        for (const n of SIGNED.notifications) send({ method: n.method, params: n.params });
        return;
      }
      if (mode === 'server-error') return fail(-32000, 'Server error: the quota service did not answer');
      if (p.cwd) cwd = p.cwd;
      if (m.method === 'session/load') {
        // A load replays the past conversation as updates before it answers.
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
        return reply({ models: { currentModelId: 'gpt-5.4', availableModels: [{ modelId: 'gpt-5.4', name: 'GPT-5.4' }] } });
      }
      return reply({ sessionId: 'cs-1', models: { currentModelId: 'gpt-5.4', availableModels: [{ modelId: 'gpt-5.4', name: 'GPT-5.4' }, { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }] } });
    }
    case 'session/prompt':
      if (mode === 'recorded') {
        // The recorded round trip (copilot-acp-prompt.json): every update the real Copilot sent for the prompt, then its answer.
        const at = PROMPT.findIndex((e) => e.dir === 'out' && e.msg.method === 'session/prompt');
        for (const e of PROMPT.slice(at + 1)) {
          if (e.dir !== 'in') break;
          if (e.msg.id !== undefined) return reply(e.msg.result);
          send({ method: e.msg.method, params: { ...e.msg.params, sessionId: p.sessionId } });
        }
        return fail(-32603, 'the recording has no answer');
      }
      try { return reply(await turn(p.sessionId, p.prompt || [])); } catch (e) { return fail(e.code || -32603, e.message); }
    case 'session/cancel': {
      for (const [id, r] of asked) { asked.delete(id); r({ result: { outcome: { outcome: 'cancelled' } } }); }
      if (cancelled) { const c = cancelled; cancelled = null; c(); }
      return;
    }
    case 'session/close': return reply({});
    default: if (m.id !== undefined) fail(-32601, 'Method not found: ' + m.method);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { void handle(JSON.parse(line)); } catch { /* not JSON */ } }
  }
});
process.stdin.on('end', () => process.exit(0));
