// Microsoft Copilot Studio provider (#24): a Copilot Studio agent behind the provider seam (providers/index.mjs).
// OFF until the owner configures it: no endpoint or no token means "Not configured", and the office makes no call. The office never
// signs in. If the agent asks for a sign-in (a connector that needs the user's own connection), the turn stops with words; the
// office does not complete the sign-in. The owner sets OFFICE_COPILOTSTUDIO_ENDPOINT (the agent's connection string from
// Copilot Studio) and a token they made (providers/cloud.mjs cloudConfig; README "Azure AI Foundry and Copilot Studio agents").
//
// What one message does: start a conversation (once per session; the agent greets nobody), send the text as an activity, and read
// the activities that come back as an event stream. Messages become replies. The plan events of generative orchestration become
// the plan (to-do list), knowledge lookups, connector calls and topics become tool calls, connected agents become helpers.
//
// The activity shapes follow the public Copilot Studio client documents. They are NOT yet checked against a recording; the live
// run waits for the owner's account (#24). Copilot Studio reports no tokens: the cost is the price the owner sets per message.
import { providerError } from './index.mjs';
import { cloudConfig, cloudSetup, cloudSend, readSse, createRemoteAgents, textOf } from './cloud.mjs';

export const STUDIO_HOSTS = ['.api.powerplatform.com', '.api.gov.powerplatform.microsoft.us', '.api.high.powerplatform.microsoft.us', '.api.appsplatform.us'];
const API_VERSION = '2022-03-01-preview';
const AGENT_PATH = /\/agents\/([A-Za-z0-9_.-]{1,100})\/conversations\/?$/;
const SIGN_IN = /oauth|signin|sign-in/i;

const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const parse = (s) => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : null; } catch { return null; } };
// 'cr123.topic.Weather' -> 'Weather'
const nice = (id) => clip(String(id || '').split(/[.:]/).filter(Boolean).pop() || 'step', 80);
// The kind of a plan step, from the type the service gives. It shows as the tool name.
function toolOf(v) {
  const t = String(v.type || '');
  if (/agent/i.test(t)) return 'Agent';
  if (/knowledge/i.test(t)) return 'Knowledge';
  if (/connector|action|flow|tool|mcp/i.test(t)) return 'Connector';
  if (/topic|dialog/i.test(t)) return 'Topic';
  return 'Step';
}
const needsSignIn = (a) => (a.attachments || []).some((x) => SIGN_IN.test(String(x?.contentType || '')) || (x?.content?.buttons || []).some((b) => SIGN_IN.test(String(b?.type || ''))));

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {object} deps.config cloudConfig(env, 'OFFICE_COPILOTSTUDIO').
 * @param {Function} [deps.fetch] fetch.  @param {boolean} [deps.allowLoopback] tests with a fake server only.
 * @param {() => string} [deps.makeId]  @param {number} [deps.stallMs]
 */
export function createCopilotStudio(deps) {
  const { events, config = cloudConfig({}, 'OFFICE_COPILOTSTUDIO') } = deps;
  // blocked(): why the Security room does not let this kind run now (off until turned on), or null. Then it is not ready.
  const blocked = deps.blocked || (() => null);
  const doFetch = deps.fetch || globalThis.fetch;
  const stallMs = deps.stallMs || undefined;
  // Copilot Studio reports neither tokens nor dollars: the office counts only the price per message the owner set.
  const priced = config.priceMessage > 0;

  const setup = () => cloudSetup(config, {
    prefix: 'OFFICE_COPILOTSTUDIO', hosts: STUDIO_HOSTS, allowLoopback: deps.allowLoopback === true,
    endpointHelp: 'the connection string of your agent (Copilot Studio, Channels, Native app: https://<environment>.api.powerplatform.com/copilotstudio/dataverse-backed/authentication/agents/<name>/conversations?api-version=...)',
    tokenHelp: 'It is an Entra ID token for https://api.powerplatform.com.',
    validate: (u) => (AGENT_PATH.test(u.pathname) ? '' : 'The address must end with /agents/<name>/conversations. Copy the connection string from Copilot Studio.'),
    readme: 'Azure AI Foundry and Copilot Studio agents',
  });
  // The conversations address, or one conversation of it. Both keep the api-version of the connection string.
  function urlOf(u, convId) {
    const root = u.origin + u.pathname.replace(/\/+$/, '');
    return `${root}${convId ? '/' + encodeURIComponent(convId) : ''}?api-version=${encodeURIComponent(config.apiVersion || u.searchParams.get('api-version') || API_VERSION)}`;
  }
  function send(signal, convId, body) {
    const c = setup();
    if (!c.ok) throw new Error(c.needs[0]);
    return cloudSend({ fetch: doFetch, label: 'Copilot Studio', url: urlOf(c.url, convId), method: 'POST', token: c.token, body, signal, stream: true });
  }

  async function startConversation(ctx) {
    // No start event: the agent would greet, and the greeting is not an answer to anything.
    const r = await send(ctx.signal, null, { emitStartConversationEvent: false });
    let id = r.headers.get('x-ms-conversationid') || '';
    if (id) { try { await r.body?.cancel(); } catch { /* done */ } } else {
      await readSse(r.body, (e) => { if (!id) id = parse(e.data)?.conversation?.id || ''; }, { stallMs, signal: ctx.signal });
    }
    if (!/^[\w.:=-]{1,200}$/.test(id)) throw new Error('Copilot Studio did not start a conversation.');
    return id;
  }

  // ----- the plan -----
  const todoWrite = (ctx, x) => {
    const id = `todo_${ctx.makeId()}`;
    const base = { tool_name: 'TodoWrite', tool_use_id: id, tool_input: { todos: x.todos.map((t) => ({ content: t.text, status: t.status })) } };
    ctx.hook({ hook_event_name: 'PreToolUse', ...base });
    ctx.hook({ hook_event_name: 'PostToolUse', ...base, duration_ms: 0 });
  };
  const setStep = (x, id, status) => {
    const t = x.todos.find((y) => y.id === id && y.status !== 'completed') || x.todos.find((y) => y.id === id);
    if (t) { t.status = status; return true; }
    return false;
  };

  function openCall(ctx, x, v) {
    const id = String(v.stepId || `${v.planIdentifier || 'plan'}:${v.taskDialogId || ctx.makeId()}`);
    if (x.open.has(id)) return id;
    const tool = toolOf(v), name = nice(v.taskDialogId);
    const input = { description: clip(v.thought || name, 200), ...(tool === 'Agent' ? { subagent_type: name } : {}) };
    ctx.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input });
    if (tool === 'Agent') ctx.hook({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: name });
    x.open.set(id, { tool, input, name, t0: Date.now() });
    return id;
  }
  function closeCall(ctx, x, id, error = null) {
    const o = x.open.get(id);
    if (!o) return;
    x.open.delete(id);
    const base = { tool_name: o.tool, tool_use_id: id, tool_input: o.input };
    if (o.tool === 'Agent') ctx.hook({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: o.name });
    if (error) ctx.hook({ hook_event_name: 'PostToolUseFailure', ...base, error: clip(error, 240), duration_ms: Date.now() - o.t0 });
    else ctx.hook({ hook_event_name: 'PostToolUse', ...base, duration_ms: Date.now() - o.t0 });
  }

  function onActivity(ctx, st, x, a) {
    if (!a || typeof a !== 'object' || a.from?.role === 'user') return;
    if (a.type === 'message') {
      // A sign-in card: the office does not sign in. Its link is not shown.
      if (needsSignIn(a)) throw new Error('The agent asks for a sign-in. The office never signs in for you. Set up the connection of the agent in Copilot Studio first, or remove the step that needs it.');
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (text) {
        x.last = text;
        ctx.stream({ type: 'assistant', message: { id: typeof a.id === 'string' && a.id ? a.id : 'm' + ctx.makeId(), content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } } });
      }
    } else if (a.type === 'endOfConversation') {
      st.conversation = null; // the next message starts a new conversation
    } else if (a.type === 'event' && a.value && typeof a.value === 'object') {
      const v = a.value;
      switch (a.valueType || a.name) {
        case 'DynamicPlanReceived': {
          const steps = (Array.isArray(v.steps) ? v.steps : []).map((y) => (typeof y === 'string' ? y : y?.taskDialogId || y?.name)).filter(Boolean).slice(0, 40);
          const before = new Map(x.todos.map((t) => [t.id, t.status]));
          x.todos = steps.map((id) => ({ id, text: nice(id), status: before.get(id) || 'pending' }));
          todoWrite(ctx, x);
          break;
        }
        case 'DynamicPlanStepTriggered':
          openCall(ctx, x, v);
          if (setStep(x, v.taskDialogId, 'in_progress')) todoWrite(ctx, x);
          break;
        case 'DynamicPlanStepFinished': {
          const id = openCall(ctx, x, v);
          const bad = /fail|error|cancel/i.test(String(v.state || '')) || !!v.error;
          const why = typeof v.error === 'string' ? v.error : v.error?.message || v.observation?.error || 'The step failed.';
          closeCall(ctx, x, id, bad ? why : null);
          if (setStep(x, v.taskDialogId, 'completed')) todoWrite(ctx, x);
          break;
        }
        case 'DynamicPlanFinished':
          if (!v.wasCancelled && x.todos.some((t) => t.status !== 'completed')) { for (const t of x.todos) t.status = 'completed'; todoWrite(ctx, x); }
          break;
        default: break; // bind updates, debug events and the rest are not shown
      }
    }
  }

  async function turn(ctx) {
    const { st } = ctx;
    try {
      if (!st.conversation) st.conversation = await startConversation(ctx);
      const r = await send(ctx.signal, st.conversation, { activity: { type: 'message', text: ctx.prompt, conversation: { id: st.conversation } } });
      ctx.charge(config.priceMessage || 0);
      ctx.stream({ type: 'stream_event', event: { type: 'message_start' } });
      const x = { todos: [], open: new Map(), last: '' };
      await readSse(r.body, (e) => {
        if (e.event !== 'activity' && e.event !== 'message') return;
        onActivity(ctx, st, x, parse(e.data));
      }, { stallMs, signal: ctx.signal });
      return { last: x.last };
    } catch (e) {
      if (!ctx.stopped()) st.conversation = null; // the conversation may be gone: the next message starts a new one
      if (textOf(e) === 'stalled') throw new Error('Copilot Studio stopped answering.');
      throw e;
    }
  }

  const remote = createRemoteAgents({ events, label: 'Copilot Studio', makeId: deps.makeId, turn, priced, newState: () => ({ conversation: null }) });
  const agentName = () => { const c = setup(); return c.ok ? (AGENT_PATH.exec(c.url.pathname) || [])[1] || null : null; };

  return {
    kind: 'copilot-studio',
    label: 'Copilot Studio',
    paid: true,        // it costs money in the owner's account; the spend limit counts the price per message the owner sets (README)
    ...(priced ? {} : { cost: 'unknown' }), // no price: the office asks before it runs and shows "unknown" (Q22)
    cloud: true,       // it runs in the cloud, not on this machine
    // Every step (knowledge, connectors, topics, connected agents) runs in the cloud: nothing comes to the office (ADR 0001).
    gated: false,
    supervision: 'Unsupervised: its tools run in the cloud',
    canResume: false,  // a new session starts a new conversation

    // Configured is ready. Copilot Studio has no call that is free and proves the agent works (a conversation can cost money), so
    // the office asks nothing. The first message shows a wrong endpoint or token in words.
    async readiness() {
      const c = setup();
      if (!c.ok) return { ready: false, configured: false, version: null, needs: c.needs };
      const off = blocked();
      if (off) return { ready: false, configured: true, version: null, needs: [off] };
      return { ready: true, configured: true, version: (AGENT_PATH.exec(c.url.pathname) || [])[1] || null, needs: [] };
    },

    async models() { return []; },

    check(o = {}) {
      const c = setup();
      if (!c.ok) throw providerError(409, `Copilot Studio is not configured. ${c.needs.join(' ')}`);
      if (o.model) throw providerError(400, 'A Copilot Studio agent takes no model. The connection string names the agent.');
    },

    open(s, o = {}) {
      this.check(o);
      remote.open(s, o);
      setImmediate(() => { if (remote.state(s)) events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: agentName() || 'Copilot Studio', permissionMode: 'default' }); });
    },
    message: remote.message,
    answer: remote.answer,
    interrupt: remote.interrupt,
    close: remote.close,
  };
}
