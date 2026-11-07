// Remote tool providers (#218, Paperclip HQ spec #191): two agent kinds whose work runs somewhere else, behind the provider seam
// (providers/index.mjs). Learned from the cursor-cloud and hermes-gateway adapters of Paperclip (https://github.com/paperclipai/paperclip,
// MIT licence, Copyright (c) Paperclip AI): what to send, which calls to poll, which words to show. No Paperclip code is copied.
//
//   cursor-cloud     a Cursor cloud agent: the office launches it on a GitHub repository, polls its status and conversation, and
//                    follows up on the same agent. Cursor runs the tools in its own cloud.
//   hermes-gateway   a Hermes Agent gateway the user runs (its OpenAI-compatible API server): the office streams a chat completion.
//                    The gateway runs the tools on its own host.
//
// Honesty (ADR 0001): the office cannot hold a call of either one. Neither service offers a hook that sends a tool call to a client
// before it runs, so both are gated: false, labelled Unsupervised, off until the Security room's Agents screen turns on Cloud agent,
// and open only in a room of their own. The office shows what the service says, never a rule it cannot enforce. Neither reports
// dollars, so cost is unknown (no spend limit can stop it). The user makes the token; the office never signs in.
//
// The API shapes are NOT checked against a recording (no account, no paid call): they follow Paperclip's adapters and the vendors'
// public notes. The live check waits for the owner's accounts. The plumbing (setup, token, calls, turn loop) is providers/cloud.mjs.
//
// This file owns createCursorCloud and createHermesGateway.
// - createCursorCloud launches a Cursor cloud agent on OFFICE_CURSORCLOUD_REPOSITORY with no pull request, polls its status and
//   conversation, follows up on the same agent, and stops it.
// - createHermesGateway streams a chat completion from a Hermes gateway the user runs: https on any host or http on loopback.
//   The key goes only there.
// - Both ride createRemoteAgents and cloudConfig/cloudSetup of cloud.mjs, and share the Cloud agent column
//   (public/vocab-security.js). They have cloud: true and a host (words for where their tools run; describe() sends it and
//   OfficeVocab.kindNote uses it), cost: 'unknown', and are gated: false with "Unsupervised: ...". They take deps.blocked like the
//   other cloud kinds: off until the Agents screen turns on Cloud agent, and no call before.
// - Tested in test/remote-tools.test.mjs with a fake fetch.
import { providerError } from './index.mjs';
import { cloudSetup, cloudSend, jsonOf, readSse, createRemoteAgents } from './cloud.mjs';

const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

// ---------- Cursor cloud ----------

const CURSOR_ENDPOINT = 'https://api.cursor.com';
const CURSOR_HOSTS = ['.cursor.com'];
const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const DONE = new Set(['FINISHED']);
const FAILED = new Set(['ERROR', 'FAILED']);
const GONE = new Set(['EXPIRED', 'DELETED', 'CANCELLED', 'STOPPED']);
const CURSOR_MAX_MS = 2 * 60 * 60 * 1000; // one turn waits at most this long for Cursor, then fails in words

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {object} deps.config cloudConfig(env, 'OFFICE_CURSORCLOUD'): the token (the endpoint defaults to https://api.cursor.com).
 * @param {object} [deps.env] the environment for OFFICE_CURSORCLOUD_REPOSITORY and _REF (the repository the cloud agent works on:
 *   it works on GitHub, not in the office folder, so the owner names it).
 * @param {Function} [deps.fetch]  @param {() => string|null} [deps.blocked] why the Security room keeps the kind off, or null.
 * @param {number} [deps.pollMs] time between status calls.  @param {() => string} [deps.makeId]
 */
export function createCursorCloud(deps) {
  const { events, config, env = {} } = deps;
  const blocked = deps.blocked || (() => null);
  const doFetch = deps.fetch || globalThis.fetch;
  const pollMs = deps.pollMs || 3000;
  const repoOf = () => String(env.OFFICE_CURSORCLOUD_REPOSITORY || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const refOf = () => String(env.OFFICE_CURSORCLOUD_REF || '').trim();

  // Setup: the token and the endpoint (cloudSetup), then the repository. Every problem is a step for the user, in words.
  function setup() {
    const base = cloudSetup({ ...config, endpoint: config.endpoint || CURSOR_ENDPOINT }, {
      prefix: 'OFFICE_CURSORCLOUD', hosts: CURSOR_HOSTS, vendor: 'Cursor', allowLoopback: deps.allowLoopback === true,
      endpointHelp: 'https://api.cursor.com', tokenHelp: 'It is a Cursor API key (Cursor Dashboard, Integrations).',
      readme: 'Cursor cloud agents and the Hermes gateway',
    });
    const needs = base.ok ? [] : [...base.needs];
    const repo = repoOf(), ref = refOf();
    if (!repo) needs.unshift('Set OFFICE_CURSORCLOUD_REPOSITORY to the GitHub repository the Cursor agent works on, for example https://github.com/owner/name.');
    else if (!REPO_RE.test(repo)) needs.unshift('OFFICE_CURSORCLOUD_REPOSITORY cannot be used. It must look like https://github.com/owner/name.');
    if (ref && !REF_RE.test(ref)) needs.unshift('OFFICE_CURSORCLOUD_REF cannot be used. It is a branch or tag name.');
    return needs.length ? { ok: false, needs } : { ok: true, url: base.url, token: base.token, repo, ref };
  }
  const call = (c, signal, method, path, body) => cloudSend({
    fetch: doFetch, label: 'Cursor', url: c.url.origin + path, method, token: c.token, body, signal,
  });
  const enc = encodeURIComponent;

  async function turn(ctx) {
    const { st } = ctx;
    const c = setup();
    if (!c.ok) throw new Error(c.needs[0]);
    ctx.stream({ type: 'stream_event', event: { type: 'message_start' } });
    const followup = !!st.agent;
    if (!st.agent) {
      const r = await jsonOf(await call(c, ctx.signal, 'POST', '/v0/agents', {
        prompt: { text: ctx.prompt },
        source: { repository: c.repo, ...(c.ref ? { ref: c.ref } : {}) },
        target: { autoCreatePr: false }, // the office never asks Cursor to open a pull request: that is the user's click
      }));
      if (!/^[\w.:-]{1,200}$/.test(String(r.id || ''))) throw new Error('Cursor did not start an agent.');
      st.agent = String(r.id);
    } else {
      await call(c, ctx.signal, 'POST', `/v0/agents/${enc(st.agent)}/followup`, { prompt: { text: ctx.prompt } });
    }
    const t0 = Date.now();
    st.said = false; // per turn: the summary below is the fallback only when this turn's conversation said nothing
    // After a follow-up the first status can still be FINISHED from the run before. Accept FINISHED only after the agent was seen
    // running again, or after a short grace (three polls) with no sign of work.
    let active = !followup;
    const grace = t0 + pollMs * 3;
    let info = {};
    for (;;) {
      if (ctx.stopped()) return { last: st.last || '' };
      info = await jsonOf(await call(c, ctx.signal, 'GET', `/v0/agents/${enc(st.agent)}`));
      await said(ctx, st, c);
      const status = String(info.status || '').toUpperCase();
      if (!DONE.has(status) && !FAILED.has(status) && !GONE.has(status)) active = true;
      if (DONE.has(status) && (active || Date.now() >= grace)) break;
      if (FAILED.has(status)) throw new Error(`Cursor stopped with an error${info.summary ? ': ' + clip(info.summary, 200) : '.'}`);
      if (GONE.has(status)) { st.agent = null; throw new Error('The Cursor agent expired or was stopped. The next message starts a new agent.'); }
      if (Date.now() - t0 > CURSOR_MAX_MS) throw new Error('Cursor did not finish in 2 hours. Stop the session and check the agent in Cursor.');
      await sleep(pollMs, ctx.signal);
    }
    // The summary and the branch are shown when the conversation said nothing new.
    const where = typeof info.target?.url === 'string' && info.target.url.startsWith('https://') ? ` See it at ${info.target.url}` : '';
    if (!st.said && info.summary) say(ctx, st, `${clip(info.summary, 2000)}${where}`);
    return { last: st.last || '' };
  }

  // The conversation: each assistant message not shown yet becomes a reply.
  async function said(ctx, st, c) {
    const conv = await jsonOf(await call(c, ctx.signal, 'GET', `/v0/agents/${encodeURIComponent(st.agent)}/conversation`));
    st.said = st.said || false; st.seen = st.seen || new Set();
    for (const m of Array.isArray(conv.messages) ? conv.messages : []) {
      const id = String(m?.id || '');
      if (!id || st.seen.has(id)) continue;
      st.seen.add(id);
      if (m.type === 'assistant_message' && typeof m.text === 'string' && m.text.trim()) { st.said = true; say(ctx, st, m.text.trim(), id); }
    }
  }
  function say(ctx, st, text, id) {
    st.last = text;
    ctx.stream({ type: 'assistant', message: { id: id || 'm' + ctx.makeId(), content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  const remote = createRemoteAgents({
    events, label: 'Cursor', makeId: deps.makeId, turn, priced: false, newState: () => ({ agent: null, last: '', said: false, seen: new Set() }),
    // Best effort: tell Cursor to stop the agent when the user interrupts or closes.
    onStop: (s, st) => {
      const c = setup();
      if (c.ok && st.agent) call(c, undefined, 'POST', `/v0/agents/${encodeURIComponent(st.agent)}/stop`).catch(() => {});
    },
  });

  return {
    kind: 'cursor-cloud',
    label: 'Cursor cloud agent',
    paid: true,
    cost: 'unknown',   // Cursor reports no dollars in this API: the office asks before it runs and sets no spend limit (Q22)
    cloud: true,
    host: "Cursor's cloud",
    gated: false,      // the tools run in Cursor's cloud; nothing comes to the office (ADR 0001)
    supervision: "Unsupervised: its tools run in Cursor's cloud",
    canResume: false,

    async readiness() {
      const c = setup();
      if (!c.ok) return { ready: false, configured: false, version: null, needs: c.needs };
      const off = blocked();
      if (off) return { ready: false, configured: true, version: null, needs: [off] };
      // No free call proves the key (an agent costs money), so configured is ready; the first message shows a wrong key in words.
      return { ready: true, configured: true, version: c.repo.replace('https://github.com/', ''), needs: [] };
    },
    async models() { return []; },
    check(o = {}) {
      const c = setup();
      if (!c.ok) throw providerError(409, `Cursor cloud agent is not configured. ${c.needs.join(' ')}`);
      if (o.model) throw providerError(400, 'A Cursor cloud agent takes no model here. Cursor picks it.');
    },
    open(s, o = {}) {
      this.check(o);
      remote.open(s, o);
      const c = setup();
      setImmediate(() => { if (remote.state(s)) events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: c.ok ? c.repo.replace('https://github.com/', '') : 'Cursor', permissionMode: 'default' }); });
    },
    message: remote.message,
    answer: remote.answer,
    interrupt: remote.interrupt,
    close: remote.close,
  };
}

// ---------- Hermes gateway ----------

const HISTORY_MAX = 60; // messages kept and sent back: the chat API holds no session for the office

/**
 * @param {object} deps
 * @param {object} deps.events  @param {object} deps.config cloudConfig(env, 'OFFICE_HERMESGATEWAY'): the endpoint and the key.
 * @param {object} [deps.env] OFFICE_HERMESGATEWAY_MODEL (the model name the gateway shows; default hermes-agent).
 * @param {Function} [deps.fetch]  @param {() => string|null} [deps.blocked]  @param {number} [deps.stallMs]  @param {() => string} [deps.makeId]
 */
export function createHermesGateway(deps) {
  const { events, config, env = {} } = deps;
  const blocked = deps.blocked || (() => null);
  const doFetch = deps.fetch || globalThis.fetch;
  const modelOf = () => { const m = String(env.OFFICE_HERMESGATEWAY_MODEL || '').trim(); return /^[\w.:/-]{1,100}$/.test(m) ? m : 'hermes-agent'; };

  // The gateway is the user's own server: https on any host, or http on this PC. The key goes only to the address they set.
  const setup = () => cloudSetup(config, {
    prefix: 'OFFICE_HERMESGATEWAY', hosts: [], anyHost: true, allowLoopback: true,
    endpointHelp: 'the base address of your Hermes gateway API server, for example http://127.0.0.1:8642/v1',
    tokenHelp: 'It is the API key of the gateway (API_SERVER_KEY), 16 characters or more.',
    readme: 'Cursor cloud agents and the Hermes gateway',
  });

  async function turn(ctx) {
    const { st } = ctx;
    const c = setup();
    if (!c.ok) throw new Error(c.needs[0]);
    const messages = [...st.messages, { role: 'user', content: ctx.prompt }];
    const url = c.url.origin + c.url.pathname.replace(/\/+$/, '') + '/chat/completions' + c.url.search;
    const r = await cloudSend({ fetch: doFetch, label: 'The Hermes gateway', url, token: c.token, body: { model: modelOf(), messages, stream: true }, signal: ctx.signal, stream: true });
    ctx.stream({ type: 'stream_event', event: { type: 'message_start' } });
    let text = '', usage = null;
    await readSse(r.body, (e) => {
      if (e.data.trim() === '[DONE]') return;
      let j; try { j = JSON.parse(e.data); } catch { return; }
      const d = j?.choices?.[0]?.delta?.content;
      if (typeof d === 'string') text += d;
      if (j?.usage && typeof j.usage === 'object') usage = j.usage;
    }, { stallMs: deps.stallMs, signal: ctx.signal });
    if (ctx.stopped()) return { last: '' };
    text = text.trim();
    st.messages = [...messages, ...(text ? [{ role: 'assistant', content: text }] : [])].slice(-HISTORY_MAX);
    if (text) {
      ctx.stream({ type: 'assistant', message: { id: 'm' + ctx.makeId(), content: [{ type: 'text', text }], usage: { input_tokens: Number(usage?.prompt_tokens) || 0, output_tokens: Number(usage?.completion_tokens) || 0 } } });
    }
    return { last: text };
  }

  const remote = createRemoteAgents({ events, label: 'The Hermes gateway', makeId: deps.makeId, turn, priced: false, newState: () => ({ messages: [] }) });

  return {
    kind: 'hermes-gateway',
    label: 'Hermes gateway',
    paid: true,
    cost: 'unknown',   // the gateway reports no dollars: its model account is behind it
    cloud: true,
    host: 'the Hermes gateway',
    gated: false,      // the gateway runs its tools itself and has no hook that asks a client first (ADR 0001)
    supervision: 'Unsupervised: its tools run on the gateway',
    canResume: false,

    async readiness() {
      const c = setup();
      if (!c.ok) return { ready: false, configured: false, version: null, needs: c.needs };
      const off = blocked();
      if (off) return { ready: false, configured: true, version: null, needs: [off] };
      return { ready: true, configured: true, version: c.url.host, needs: [] };
    },
    async models() { return []; },
    check(o = {}) {
      const c = setup();
      if (!c.ok) throw providerError(409, `The Hermes gateway is not configured. ${c.needs.join(' ')}`);
      if (o.model) throw providerError(400, 'The Hermes gateway takes no model here. Set OFFICE_HERMESGATEWAY_MODEL if the gateway names one.');
    },
    open(s, o = {}) {
      this.check(o);
      remote.open(s, o);
      setImmediate(() => { if (remote.state(s)) events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: modelOf(), permissionMode: 'default' }); });
    },
    message: remote.message,
    answer: remote.answer,
    interrupt: remote.interrupt,
    close: remote.close,
  };
}

/** A wait that ends at once when the signal fires (the turn was stopped). */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
