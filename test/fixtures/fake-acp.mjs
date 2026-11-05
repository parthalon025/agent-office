// A fake ACP agent (Agent Client Protocol, agentclientprotocol.com) for test/acp-provider.test.mjs: newline-delimited JSON-RPC
// on stdio, like `hermes acp` and `dsh --profile acp`. No model, no network, no paid call.
//
// A prompt that is plain text gets the reply "echo: <text>". A prompt that is a JSON list runs those steps in order:
//   { say: 'text' }                     an agent_message_chunk
//   { tool: { toolCallId, ... } }        a tool_call update        { update: { toolCallId, ... } }  a tool_call_update
//   { plan: [entries] }                  a plan update
//   { ask: { toolCall, options } }       session/request_permission, then says "asked: <outcome> <optionId>"
//   { giveUp: { toolCall, options, ms } } asks, then after ms stops waiting: a failed tool_call_update, "gave up"
//   { read: { path, line, limit } }      fs/read_text_file, then says "read: <content>" or "read error: <message>"
//   { write: { path, content } }         fs/write_text_file, then says "write: ok" or "write error: <message>"
//   { term: { command, args, cwd, env, outputByteLimit } }  terminal/create, wait_for_exit, output, release, then says
//                                        "term: exit <code>: <output>" or "term error: <message>"
//   { hang: true }                       waits until the client sends session/cancel
//   { wait: ms }                         waits ms
//   { stop: 'refusal' }                  ends the turn with that stop reason
// A session/cancel ends the turn at once with stopReason cancelled.
// Environment: FAKE_ACP_LOAD=1 advertises loadSession (session/load replays one exchange), FAKE_ACP_IMAGE=1 image prompts,
// FAKE_ACP_VERSION the version in agentInfo, FAKE_ACP_EXIT=1 writes to stderr and exits 2 at once,
// FAKE_ACP_LOG a file where every message from the client is written, one JSON line each.
import fs from 'node:fs';

const env = process.env;
if (env.FAKE_ACP_EXIT === '1') { process.stderr.write('fake-acp: no config found\n'); process.exit(2); }

const log = (m) => { if (env.FAKE_ACP_LOG) fs.appendFileSync(env.FAKE_ACP_LOG, JSON.stringify(m) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let next = 1;
const waiting = new Map();
let turn = null; // { cancelled, wake }

function request(method, params) {
  const id = 'a' + next++;
  return new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); });
}
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
// Each say is its own message: a new messageId starts a new message (ACP prompt turn).
let said = 0;
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg' + ++said, content: { type: 'text', text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runStep(sid, step) {
  if (step.say) say(sid, step.say);
  else if (step.tool) update(sid, { sessionUpdate: 'tool_call', ...step.tool });
  else if (step.update) update(sid, { sessionUpdate: 'tool_call_update', ...step.update });
  else if (step.plan) update(sid, { sessionUpdate: 'plan', entries: step.plan });
  else if (step.ask) {
    const r = await request('session/request_permission', { sessionId: sid, ...step.ask });
    const o = r.result?.outcome || {};
    say(sid, `asked: ${o.outcome} ${o.optionId || ''}`.trim());
  } else if (step.giveUp) {
    const { ms, ...ask } = step.giveUp;
    void request('session/request_permission', { sessionId: sid, ...ask }).then((r) => log({ late: r }));
    await sleep(ms);
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: ask.toolCall.toolCallId, status: 'failed' });
    say(sid, 'gave up');
  } else if (step.read) {
    const r = await request('fs/read_text_file', { sessionId: sid, ...step.read });
    say(sid, r.error ? `read error: ${r.error.message}` : `read: ${r.result.content}`);
  } else if (step.write) {
    const r = await request('fs/write_text_file', { sessionId: sid, ...step.write });
    say(sid, r.error ? `write error: ${r.error.message}` : 'write: ok');
  } else if (step.term) {
    const c = await request('terminal/create', { sessionId: sid, ...step.term });
    if (c.error) return say(sid, `term error: ${c.error.message}`);
    const terminalId = c.result.terminalId;
    const w = await request('terminal/wait_for_exit', { sessionId: sid, terminalId });
    const o = await request('terminal/output', { sessionId: sid, terminalId });
    await request('terminal/release', { sessionId: sid, terminalId });
    say(sid, `term: exit ${w.result?.exitCode}: ${String(o.result?.output || '').trim()}`);
  } else if (step.hang) {
    await new Promise((resolve) => { turn.wake = resolve; });
  } else if (step.wait) {
    await sleep(step.wait);
  }
  return null;
}

async function prompt(id, p) {
  const sid = p.sessionId;
  const text = (p.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let steps;
  try { steps = text.trim().startsWith('[') ? JSON.parse(text) : null; } catch { steps = null; }
  turn = { cancelled: false, wake: null };
  const mine = turn;
  let stopReason = 'end_turn';
  if (!steps) say(sid, 'echo: ' + text);
  else {
    for (const step of steps) {
      if (mine.cancelled) break;
      if (step.stop) { stopReason = step.stop; break; }
      await runStep(sid, step);
    }
  }
  if (mine.cancelled) stopReason = 'cancelled';
  turn = null;
  send({ id, result: { stopReason } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    log(m);
    if (m.method === undefined) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } continue; }
    if (m.method === 'initialize') {
      send({ id: m.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: env.FAKE_ACP_LOAD === '1', promptCapabilities: { image: env.FAKE_ACP_IMAGE === '1' } },
        authMethods: [], agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: env.FAKE_ACP_VERSION || '0.0.1' },
      } });
    } else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'fake-sess-1' } });
    else if (m.method === 'session/load') {
      const sid = m.params.sessionId;
      update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an old question' } });
      say(sid, 'an old answer');
      send({ id: m.id, result: {} });
    } else if (m.method === 'session/prompt') void prompt(m.id, m.params);
    else if (m.method === 'session/cancel') { if (turn) { turn.cancelled = true; if (turn.wake) turn.wake(); } }
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
