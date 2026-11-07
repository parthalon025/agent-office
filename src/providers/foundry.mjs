// Azure AI Foundry provider (#24): an agent of the Foundry Agent Service behind the provider seam (providers/index.mjs).
// OFF until the owner configures it: no endpoint or no token means "Not configured", and the office makes no call. The office never
// signs in and never makes an Azure resource of its own accord. The owner sets OFFICE_FOUNDRY_ENDPOINT and a token they made
// (providers/cloud.mjs cloudConfig; docs/agents.md "Azure AI Foundry and Copilot Studio agents").
//
// What one message does: make a thread (once per session), add the message, start a run of the chosen agent as an event stream,
// and map the stream into the tracker's vocabulary: text, tool calls (code interpreter, file search, Bing, functions, MCP),
// connected agents as helpers, usage. A tool approval the service asks for (MCP tools) comes to you as a request; your answer goes
// back to the run. A run that needs the office to run a function is cancelled with a clear error: the office has no functions.
//
// The event shapes follow the public Agent Service documents. They are NOT yet checked against a recording; the live run waits
// for the owner's account (#24). The office keeps the thread after the session ends and deletes nothing of yours.
//
// Supervision: gated: false, "Partly supervised: only MCP approvals ask" (partly: { mcp }), because its MCP approvals go through
// events.permission and the Security room. Cost: unknown unless both PRICE_IN and PRICE_OUT are set (shared rules and the other
// cloud kind are in providers/cloud.mjs).
// deps.blocked (the server passes security.openRefusal for the kind): while the Cloud agent switch is off, readiness() is not
// ready with that reason, and readiness() and models() make no call. An MCP server label is made safe by serverLabel (never
// office, which risk.mjs rates as the office's own tool), and service ids go into paths through encodeURIComponent.
// Tested in test/cloud-providers.test.mjs with test/fixtures/fake-azure.mjs.
import { providerError } from './index.mjs';
import { cloudConfig, cloudSetup, cloudSend, jsonOf, readSse, createRemoteAgents, textOf } from './cloud.mjs';

export const FOUNDRY_HOSTS = ['.services.ai.azure.com', '.openai.azure.com', '.cognitiveservices.azure.com'];
const API_VERSION = '2025-05-01';
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_HOPS = 20; // approvals in one turn: a run that asks again and again is cut
const POLL_TRIES = 8; // after a cancel: reads of the run until it has ended and reports its tokens
const ENDED = new Set(['completed', 'failed', 'cancelled', 'expired', 'incomplete']);
// The Security room (security.mjs enforcement): an approval the service asks for is an MCP tool set to ask; it comes to the
// office through events.permission, so the rules decide it. Every other tool runs in the cloud without asking.
const MCP_PARTLY = 'Only an MCP tool that a Foundry agent sets to ask for approval comes to the office. The other cloud tools run without asking.';

const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const parse = (s) => { try { const j = JSON.parse(s); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };

// The label of an MCP server as the service sends it, made safe for a tool name `mcp__<label>__<tool>`: only letters, digits, `_`
// and `-`, no `__` inside, and never `office`: risk.mjs rates `mcp__office__*` as the office's own tool, not as MCP, so a service
// that named its server "office" would slip past the Cloud agent MCP cell.
function serverLabel(raw) {
  const l = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_').slice(0, 64) || 'server';
  return l.toLowerCase() === 'office' ? 'office-server' : l;
}
// A service id goes into a request path as one segment, whatever it holds.
const seg = encodeURIComponent;

// One tool call of a run step as the office shows it: the tool name, a short input and, for a connected agent, the helper's name.
function describeCall(tc) {
  const type = String(tc.type || 'tool');
  const d = tc[type] && typeof tc[type] === 'object' ? tc[type] : tc;
  const raw = d.arguments ?? d.input ?? d.requesturl ?? tc.arguments ?? '';
  const args = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (type === 'connected_agent') {
    const name = String(d.name || 'agent');
    return { tool: 'Agent', agent: name, input: { subagent_type: clip(name, 80), description: clip(parse(args).prompt || args, 200) } };
  }
  const name = type === 'mcp' ? `mcp__${serverLabel(tc.server_label || d.server_label)}__${tc.name || d.name || 'tool'}`
    : type === 'function' || type === 'azure_function' ? String(d.name || type) : type;
  return { tool: name, agent: null, input: { description: clip(args, 200) } };
}

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {object} deps.config cloudConfig(env, 'OFFICE_FOUNDRY').
 * @param {Function} [deps.fetch] fetch.  @param {boolean} [deps.allowLoopback] tests with a fake server only.
 * @param {() => string} [deps.makeId]  @param {number} [deps.stallMs]
 * @param {number} [deps.pollMs] the wait between reads of a cancelled run (default 1500 ms).
 */
export function createFoundry(deps) {
  const { events, config = cloudConfig({}, 'OFFICE_FOUNDRY') } = deps;
  // blocked(): why the Security room does not let this kind run now (its Agents screen: off until turned on), or null. Then the
  // kind is not ready and the office makes no call, also not to list the agents. The server passes security.openRefusal.
  const blocked = deps.blocked || (() => null);
  const doFetch = deps.fetch || globalThis.fetch;
  const stallMs = deps.stallMs || undefined;
  const pollMs = deps.pollMs || 1500;
  // Foundry reports tokens, not dollars: the office counts them only with both prices (one alone would count the rest as free).
  const priced = config.priceIn > 0 && config.priceOut > 0;

  const setup = () => cloudSetup(config, {
    prefix: 'OFFICE_FOUNDRY', hosts: FOUNDRY_HOSTS, allowLoopback: deps.allowLoopback === true,
    endpointHelp: 'the endpoint of your Foundry project (https://<resource>.services.ai.azure.com/api/projects/<project>)',
    tokenHelp: 'It is an Entra ID token for https://ai.azure.com.', readme: 'Azure AI Foundry and Copilot Studio agents',
  });
  const apiUrl = (u, path) => `${u.origin}${u.pathname.replace(/\/+$/, '')}${path}${path.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(config.apiVersion || API_VERSION)}`;
  // One call with a fresh token read: a token file the user renews works with no restart.
  function send(signal, method, path, body, stream = false) {
    const c = setup();
    if (!c.ok) throw new Error(c.needs[0]);
    return cloudSend({ fetch: doFetch, label: 'Foundry', url: apiUrl(c.url, path), method, token: c.token, body, signal, stream });
  }

  // ----- the run stream -----
  // x: what one run has shown so far. It lives for one turn and spans the approval hops.
  const fresh = () => ({ runId: null, state: null, required: null, error: null, usage: null, texts: new Map(), open: new Map() });

  function openCall(ctx, x, tc) {
    const id = String(tc.id || '') || `call_${ctx.makeId()}`;
    if (x.open.has(id)) return id;
    const d = describeCall(tc);
    const base = { tool_name: d.tool, tool_use_id: id, tool_input: d.input };
    ctx.hook({ hook_event_name: 'PreToolUse', ...base });
    if (d.agent) ctx.hook({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: d.agent });
    x.open.set(id, { base, agent: d.agent, t0: Date.now() });
    return id;
  }
  function closeCall(ctx, x, id, error = null) {
    const o = x.open.get(id);
    if (!o) return;
    x.open.delete(id);
    const ms = Date.now() - o.t0;
    if (o.agent) ctx.hook({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: o.agent });
    if (error) ctx.hook({ hook_event_name: 'PostToolUseFailure', ...o.base, error: clip(error, 240), duration_ms: ms });
    else ctx.hook({ hook_event_name: 'PostToolUse', ...o.base, duration_ms: ms });
  }

  function onEvent(ctx, st, x, e) {
    if (e.event === 'done' || e.data === '[DONE]') return;
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || typeof d !== 'object') return;
    switch (e.event) {
      case 'thread.run.created': case 'thread.run.queued': case 'thread.run.in_progress':
        if (d.id) { x.runId = d.id; st.runId = d.id; }
        break;
      case 'thread.message.delta': {
        const piece = (d.delta?.content || []).map((c) => c?.text?.value || '').join('');
        if (!piece) break;
        const m = x.texts.get(d.id) || { buf: '', final: null };
        m.buf += piece; x.texts.set(d.id, m);
        ctx.stream({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
        break;
      }
      case 'thread.message.completed': {
        const text = (d.content || []).map((c) => c?.text?.value || '').join('');
        const m = x.texts.get(d.id) || { buf: '', final: null };
        m.final = text; x.texts.set(d.id, m);
        break;
      }
      case 'thread.run.step.delta':
        for (const tc of d.delta?.step_details?.tool_calls || []) if (tc && tc.id && tc.type) openCall(ctx, x, tc);
        break;
      case 'thread.run.step.completed':
        for (const tc of d.step_details?.type === 'tool_calls' ? d.step_details.tool_calls || [] : []) closeCall(ctx, x, openCall(ctx, x, tc));
        break;
      case 'thread.run.step.failed': case 'thread.run.step.cancelled': case 'thread.run.step.expired': {
        const why = d.last_error?.message || (e.event.endsWith('cancelled') ? 'Cancelled' : 'The step failed.');
        for (const tc of d.step_details?.type === 'tool_calls' ? d.step_details.tool_calls || [] : []) closeCall(ctx, x, openCall(ctx, x, tc), why);
        break;
      }
      case 'thread.run.requires_action': x.runId = d.id || x.runId; x.state = 'requires_action'; x.required = d.required_action || null; break;
      case 'thread.run.completed': x.state = 'completed'; x.usage = d.usage || null; break;
      case 'thread.run.failed': x.state = 'failed'; x.usage = d.usage || null; x.error = d.last_error?.message || 'The run failed.'; break;
      case 'thread.run.cancelled': x.state = 'failed'; x.error = 'The run was cancelled.'; break;
      case 'thread.run.expired': x.state = 'failed'; x.error = 'The run took too long and expired.'; break;
      case 'thread.run.incomplete': x.state = 'failed'; x.usage = d.usage || null; x.error = `The run stopped before it finished${d.incomplete_details?.reason ? ': ' + d.incomplete_details.reason : '.'}`; break;
      case 'error': x.state = 'failed'; x.error = d.message || 'The service sent an error.'; break;
      default: break;
    }
  }

  // The cost of one run, counted once: Foundry reports the tokens of a run only when it has ended, in the stream or, for a run
  // the office stopped, when it is read after the cancel (settle).
  function chargeRun(st, id, usage) {
    if (!usage || !id || st.charged.has(id)) return;
    st.charged.add(id);
    const inTok = Number(usage.prompt_tokens) || 0, outTok = Number(usage.completion_tokens) || 0;
    remote.charge(st, (inTok * (config.priceIn || 0) + outTok * (config.priceOut || 0)) / 1e6);
  }

  // The reply, the tokens and the cost of the run, reported once when the run ends.
  function report(ctx, x) {
    const text = [...x.texts.values()].map((m) => m.final ?? m.buf).filter((t) => t && t.trim()).join('\n\n');
    const inTok = Number(x.usage?.prompt_tokens) || 0, outTok = Number(x.usage?.completion_tokens) || 0;
    ctx.stream({ type: 'assistant', message: { id: 'm' + (x.runId || ctx.makeId()), content: text ? [{ type: 'text', text }] : [], usage: { input_tokens: inTok, output_tokens: outTok } } });
    chargeRun(ctx.st, x.runId, x.usage);
    return text;
  }

  // Stops the run of the session (best effort). The tokens it spent until then are counted when Foundry says it has ended
  // (settle, not awaited), so a stopped run still counts against the spend limit of the next message.
  async function cancel(st) {
    if (!st.thread || !st.runId) return;
    const id = st.runId, thread = st.thread;
    st.runId = null;
    let run = null;
    try { run = await jsonOf(await send(undefined, 'POST', `/threads/${seg(thread)}/runs/${seg(id)}/cancel`, {})); } catch { /* best effort */ }
    void settle(st, thread, id, run);
  }
  async function settle(st, thread, id, run) {
    for (let i = 0; i < POLL_TRIES && !st.charged.has(id); i++) {
      if (run && ENDED.has(run.status)) { chargeRun(st, id, run.usage); return; }
      await new Promise((r) => setTimeout(r, i ? pollMs : 0));
      try { run = await jsonOf(await send(undefined, 'GET', `/threads/${seg(thread)}/runs/${seg(id)}`)); } catch { run = null; }
    }
    if (run && ENDED.has(run.status)) chargeRun(st, id, run.usage);
  }

  async function turn(ctx) {
    const { st } = ctx;
    const hereSend = (method, path, body, stream) => send(ctx.signal, method, path, body, stream);
    try {
      if (!st.thread) {
        const t = await jsonOf(await hereSend('POST', '/threads', {}));
        if (!t.id) throw new Error('Foundry did not make a thread.');
        st.thread = String(t.id);
        events.feed(ctx.s, 'start', `Foundry thread ${st.thread}`);
      }
      await hereSend('POST', `/threads/${seg(st.thread)}/messages`, { role: 'user', content: ctx.prompt });
      ctx.stream({ type: 'stream_event', event: { type: 'message_start' } });
      const x = fresh();
      let path = `/threads/${seg(st.thread)}/runs`, body = { assistant_id: st.agent, stream: true };
      for (let hop = 0; ; hop++) {
        x.state = null;
        const r = await hereSend('POST', path, body, true);
        await readSse(r.body, (e) => onEvent(ctx, st, x, e), { stallMs, signal: ctx.signal });
        if (x.state !== 'requires_action') break;
        if (hop >= MAX_HOPS) { await cancel(st); throw new Error('The agent asked for approval too many times in one turn.'); }
        // The limit is checked at each hop too: the tokens of a run stopped before can have come in since the turn began.
        if (ctx.overBudget()) { await cancel(st); report(ctx, x); return { last: '', overBudget: true }; }
        const need = x.required || {};
        if (need.type !== 'submit_tool_approval') {
          // The run waits for a result of a function the office would have to run. The office has none.
          const fn = (need.submit_tool_outputs?.tool_calls || []).map((c) => c.function?.name || c.type).filter(Boolean).join(', ') || 'a function';
          await cancel(st);
          report(ctx, x);
          throw new Error(`The agent asked the office to run ${fn}. The office has no functions. Remove it from the agent, or run the agent where it can call it.`);
        }
        const calls = need.submit_tool_approval?.tool_calls || [];
        const decisions = await Promise.all(calls.map((c) => ctx.ask(describeCall(c).tool, parse(c.arguments))));
        if (ctx.stopped()) return { last: '' };
        if (ctx.overBudget()) { await cancel(st); report(ctx, x); return { last: '', overBudget: true }; }
        path = `/threads/${seg(st.thread)}/runs/${seg(x.runId)}/submit_tool_outputs`;
        body = { tool_approvals: calls.map((c, i) => ({ tool_call_id: c.id, approve: decisions[i] === true })), stream: true };
      }
      st.runId = null;
      const last = report(ctx, x);
      if (x.state === 'failed') throw new Error(x.error);
      if (x.state !== 'completed') throw new Error('Foundry closed the connection before the run ended.');
      return { last };
    } catch (e) {
      // A run that is still on (a stall, a dropped stream, a failed call between hops) is cancelled, so it does not go on
      // spending in the cloud, and its tokens are counted. After an interrupt or a close, onStop has cancelled it already.
      if (!ctx.stopped()) void cancel(st);
      if (textOf(e) === 'stalled') throw new Error('Foundry stopped answering.');
      throw e;
    }
  }

  const remote = createRemoteAgents({
    events, label: 'Foundry', makeId: deps.makeId, turn, priced,
    newState: (s, o) => ({ agent: o.model, thread: null, runId: null, charged: new Set() }),
    onStop: (s, st) => { void cancel(st); },
  });

  async function listAgents(signal) {
    const j = await jsonOf(await send(signal, 'GET', '/assistants?limit=100'));
    return (Array.isArray(j.data) ? j.data : []).filter((a) => a && typeof a.id === 'string')
      .map((a) => ({ id: a.id, label: `${a.name || a.id}${a.model ? ` (${a.model})` : ''}` }));
  }

  return {
    kind: 'foundry',
    label: 'Azure AI Foundry',
    paid: true,        // it costs money in the owner's account; the spend limit counts it when the prices are set (docs/agents.md)
    ...(priced ? {} : { cost: 'unknown' }), // no prices: the office asks before it runs and shows "unknown" (Q22)
    cloud: true,       // it runs in the cloud, not on this machine
    // Its tools run in the cloud without the office (ADR 0001). Only an MCP approval the run asks for comes here.
    gated: false,
    supervision: 'Partly supervised: only MCP approvals ask',
    partly: { mcp: MCP_PARTLY },
    canResume: false,  // the office opens a new thread: Reopen starts a fresh session with the same agent
    needsModel: true,  // the user picks the agent
    modelLabel: 'Foundry agent', // the dialog already has a pick called Agent (the kind)

    async readiness() {
      const c = setup();
      if (!c.ok) return { ready: false, configured: false, version: null, needs: c.needs };
      const off = blocked();
      if (off) return { ready: false, configured: true, version: null, needs: [off] };
      try {
        const list = await listAgents();
        if (!list.length) return { ready: false, configured: true, version: null, needs: ['The project has no agents. Make an agent in the Foundry portal.'] };
        return { ready: true, configured: true, version: `${list.length} agent${list.length === 1 ? '' : 's'}`, needs: [] };
      } catch (e) { return { ready: false, configured: true, version: null, needs: [textOf(e)] }; }
    },

    async models() {
      if (!setup().ok || blocked()) return [];
      return listAgents();
    },

    // Before the office makes a worktree or a session: the kind must be configured, and a new session needs an agent.
    // check({}) asks only whether a session can start (Reopen).
    check(o = {}) {
      const c = setup();
      if (!c.ok) throw providerError(409, `Azure AI Foundry is not configured. ${c.needs.join(' ')}`);
      if (Object.keys(o).length === 0) return;
      if (typeof o.model !== 'string' || !AGENT_RE.test(o.model)) throw providerError(400, 'Pick an agent for this session.');
    },

    open(s, o = {}) {
      this.check(o);
      remote.open(s, o);
      // The session shows its agent like a Claude Code session shows its model, on a later tick (seam rule 1). No call is made.
      // It shows the agent id, because the session's model is what Reopen sends back to check().
      setImmediate(() => { if (remote.state(s)) events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: o.model, permissionMode: 'default' }); });
    },
    message: remote.message,
    answer: remote.answer,
    interrupt: remote.interrupt,
    close: remote.close,
  };
}
