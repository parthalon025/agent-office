// The ACP permission policy (#176): what a tool call is, what the user saw of it, and what the office answers. A call keeps what
// it learned in st.calls (track); a request is held on a frozen copy of its card (onPermission); a call the agent changes after
// the user saw it is declined or named (recheck); an approved call runs once (grant, read by acp-files.mjs); an edit the user
// declined is refused for the rest of the turn (st.denied); a call that ended without the office is told in the feed (endCall).
// OpenClaw's plugin gate (spec.plugin) ends the session when a call ran without the office's yes (gateFailed).
//
// Interface: createPolicy({ spec, label, events, emit, hook, asks, killChild }) -> { track, recheck, openCall, endCall,
// onPermission, CANCELLED, norm }. hook(s, st, payload) reports a hook event; killChild(st) stops the agent process.
import path from 'node:path';
import { fileKey, riskOf } from '../risk.mjs';
import { clip } from '../tracker.mjs';
import { PLUGIN_ID } from './openclaw.mjs';
import { rpcError } from './acp-rpc.mjs';

// ACP tool kinds as the tool names risk.mjs, payload.mjs and vocab.js know.
const KIND_TOOL = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Grep', execute: 'Bash', fetch: 'WebFetch', think: 'Think', switch_mode: 'SwitchMode' };
const EDIT_KINDS = new Set(['edit', 'delete', 'move']);
// JSON with the keys of every object sorted, so two values that differ only in key order give one text (undefined stays undefined).
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

export function createPolicy({ spec, label, events, emit, hook, asks, killChild }) {
  const { withdraw } = asks;
  // An ACP tool call as the tool name and input that the tracker, risk.mjs and payload.mjs know. A call keeps what it learned
  // in st.calls, because an update brings only the fields that changed. The kind picks the name; a kind the office does not
  // know is 'Tool', so riskOf rates it medium whatever name the agent gives it.
  function track(st, tc = {}) {
    const id = typeof tc.toolCallId === 'string' && tc.toolCallId ? tc.toolCallId : null;
    if (!id) return null;
    // held: request id -> what its card showed (frozen). approved: what the card showed when the user approved it.
    const c = st.calls.get(id) || { id, kind: 'other', title: '', path: null, raw: {}, opened: false, done: false, asked: false, served: false, held: new Map(), approved: null };
    if (typeof tc.kind === 'string') c.kind = tc.kind;
    if (typeof tc.title === 'string' && tc.title) c.title = clip(tc.title, 300);
    if (tc.rawInput && typeof tc.rawInput === 'object' && !Array.isArray(tc.rawInput)) c.raw = tc.rawInput;
    const loc = Array.isArray(tc.locations) ? tc.locations.find((l) => l && typeof l.path === 'string' && l.path) : null;
    if (loc) c.path = loc.path;
    if (Array.isArray(tc.content) && tc.content.some((x) => x && x.type === 'terminal' && st.terminalIds.has(x.terminalId))) c.served = true;
    const raw = c.raw, str = (v) => (typeof v === 'string' && v ? v : undefined);
    c.tool_name = KIND_TOOL[c.kind] || 'Tool';
    const file = c.path || str(raw.file_path) || str(raw.path) || str(raw.filePath);
    const command = Array.isArray(raw.command) ? raw.command.map(String).join(' ') : str(raw.command);
    const input = c.tool_name === 'Bash' ? { command: command || c.title }
      : c.tool_name === 'Grep' ? { pattern: str(raw.pattern) || str(raw.query) || c.title, path: file }
      : c.tool_name === 'WebFetch' ? { url: str(raw.url) || c.title }
      : KIND_TOOL[c.kind] && c.kind !== 'think' && c.kind !== 'switch_mode' ? { file_path: file }
      : { description: c.title };
    c.tool_input = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    // An agent whose requests carry its own request body (spec.callOf: Copilot CLI) is rated and shown by that body. Once a call
    // had one, the body names it: a later update with the tool's own arguments keeps the card the user saw.
    const req = spec.callOf && tc.rawInput ? spec.callOf(tc.rawInput) : null;
    if (req) { c.req = req; c.args = null; }
    if (c.req) {
      c.kind = c.req.kind;
      c.tool_name = c.req.tool_name;
      c.tool_input = { ...c.req.tool_input };
      if (c.tool_input.command === '') c.tool_input.command = c.title;
      if (c.tool_input.file_path === '') c.tool_input.file_path = c.path || '';
      // #125: what the call does now is its own arguments after the request body (spec.argsOf, in the card's shape), so
      // recheck sees a change. An update that does not say keeps the last that did; a new request body clears them. A file
      // that is the same file spelled another way (case, slashes, a relative path) keeps the card's spelling: no change.
      const args = !req && spec.argsOf && (tc.rawInput || loc) ? spec.argsOf({ tool_name: c.tool_name, tool_input: c.tool_input }, tc.rawInput || {}, loc && loc.path) : null;
      if (args) {
        const was = c.tool_input.file_path, now = args.tool_input.file_path;
        if (was && now && norm(st, was) === norm(st, now)) args.tool_input.file_path = was;
        c.args = args;
      }
    }
    st.calls.set(id, c);
    return c;
  }
  // What the user sees of a call: its tool and input. A request is answered for this, never for what the call says later.
  // Keys in any order, at any depth, are the same input: the same MCP arguments sent in another order are no change (#125).
  const sigOf = (c) => stable([c.tool_name, c.tool_input]);
  // A call in a few words: its command, file, address or pattern. A call that only its arguments name (an MCP tool) is the
  // tool and the arguments that are not what the user saw (was), so a feed line says what changed.
  const what = (c, was) => {
    const t = c.tool_input;
    const named = t.command || (t.file_path && path.basename(String(t.file_path))) || t.url || t.pattern;
    if (named) return clip(String(named), 100);
    const before = (was && was.tool_input) || {};
    const keys = [...new Set([...Object.keys(t), ...Object.keys(before)])].filter((k) => k !== 'description' && stable(t[k]) !== stable(before[k]));
    if (keys.length) return clip(`${c.tool_name} (${keys.map((k) => `${k}: ${clip(stable(t[k]) ?? 'none', 40)}`).join(', ')})`, 100);
    return clip(String(c.title || c.tool_name), 100);
  };
  // The agent changed a call after the user saw it. While a request for it waits, that request is declined at once (the
  // user cannot approve what the card no longer shows), and the files of both forms ask first for the rest of the turn.
  // After an approval, the feed says so: the agent runs its own tool with the new input, which the office cannot stop.
  // What the call says now is its card, or for an agent with request bodies its own later arguments (c.args, #125).
  function recheck(s, st, c) {
    const now = c.args || c, sig = sigOf(now);
    for (const [id, shown] of [...c.held]) {
      if (shown.sig === sig) continue;
      if (now.tool_input.file_path && EDIT_KINDS.has(c.kind)) st.askFirst.add(norm(st, now.tool_input.file_path));
      withdraw(s, st, id, `${label} changed the call while it waited for your answer, so the office declined it: ${what(now, shown)}`);
    }
    if (c.approved && !c.approved.told && c.approved.sig !== sig) {
      c.approved.told = true;
      const line = `${label} changed the call after you approved it: ${what(now, c.approved)}`;
      emit(st, () => events.feed(s, 'wait', line));
    }
  }
  function openCall(s, st, c) {
    if (c.opened) return;
    c.opened = true;
    hook(s, st, { hook_event_name: 'PreToolUse', tool_name: c.tool_name, tool_use_id: c.id, tool_input: c.tool_input });
  }
  function endCall(s, st, c, u) {
    if (c.done) return;
    c.done = true;
    // The agent finished a call the user has not answered yet: it did not wait (Hermes stops after its own time).
    for (const id of [...c.held.keys()]) withdraw(s, st, id, `${label} moved on without your answer.`);
    // What the user approved for this call is used up: a later command or write with the same text asks again.
    for (const [key, callId] of [...st.grants]) if (callId === c.id) st.grants.delete(key);
    // What the call did: its card, or for an agent with request bodies its own last arguments (c.args, #125), so an approved
    // edit that moved to a file the user declined is named. The hooks below keep the card, which the PreToolUse carried.
    const did = c.args || c, input = did.tool_input;
    const file = input.file_path ? norm(st, input.file_path) : null;
    const gated = st.gated.get(c.id);
    st.gated.delete(c.id);
    // spec.plugin: every call of the session goes to the office through the plugin before it runs (gate). A call that ran
    // without the office's yes means the plugin did not hold it: not loaded, a Gateway not restarted after the plugin was
    // turned on, or another call id. Nothing else stops OpenClaw's calls, so the session ends with an Error that says so.
    // A failed call the office never got may have run too: OpenClaw reports "failed" for every tool result that is an error
    // (src/acp/translator.agent-events.ts), so a push that ran and then exited 1 is "failed". Only a result OpenClaw marks as
    // blocked before the tool ran (rawOutput.details.status "blocked": agent-tools.before-tool-call.wrapper.ts
    // buildBlockedToolResult, also the plugin's own denials) did not run. Its text is never trusted: a command can print anything.
    const before = blockedBefore(u);
    if (spec.plugin && u.status === 'completed' && !before && !c.served && !(file && st.wrote.has(file)) && !(gated && gated.allow)) {
      gateFailed(s, st, c, gated);
    } else if (spec.plugin && u.status === 'failed' && !before && !c.served && !gated) {
      gateFailed(s, st, c, null, true);
    } else if (spec.plugin) {
      // held by the office: nothing to say
    } else if (u.status === 'completed' && EDIT_KINDS.has(c.kind) && file && st.denied.has(file)) {
      // Hermes #31682: an edit the user declined can come back through another of the agent's own tools. The office cannot
      // stop the agent's own tools, so it says so when one reports that file changed.
      emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(input.file_path))} after you declined that edit.`));
    } else if (u.status === 'completed' && !c.asked && !c.served) {
      if (c.kind === 'execute') emit(st, () => events.feed(s, 'wait', `${label} ran a command without asking the office: ${clip(input.command || c.title, 100)}`));
      else if (EDIT_KINDS.has(c.kind) && !(file && st.wrote.has(file))) {
        emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(input.file_path || c.title))} without asking the office.`));
      } else if (c.kind === 'read' || c.kind === 'search') {
        // A read the office cannot stop: the feed names it when it is not low risk (a secret, a settings file, outside the root).
        const risk = riskOf(did.tool_name, input, st.root);
        if (risk !== 'low') emit(st, () => events.feed(s, 'wait', `${label} read ${clip(String((input.file_path && path.basename(String(input.file_path))) || input.pattern || c.title), 100)} without asking the office (risk ${risk}).`));
      }
    }
    const said = (Array.isArray(u.content) ? u.content : []).map((x) => (x?.type === 'content' && x.content?.type === 'text' ? x.content.text : '')).find(Boolean);
    const base = { tool_name: c.tool_name, tool_use_id: c.id, tool_input: c.tool_input };
    if (u.status === 'completed') hook(s, st, { hook_event_name: 'PostToolUse', ...base });
    else hook(s, st, { hook_event_name: 'PostToolUseFailure', ...base, error: clip(String(said || 'Failed'), 240), is_interrupt: st.interrupted });
  }

  // OpenClaw marked the call's result as blocked before the tool ran (agent-tools.before-tool-call.wrapper.ts buildBlockedToolResult:
  // details.status "blocked"). The text of the result is not read: a command can print anything.
  function blockedBefore(u) {
    const d = u && u.rawOutput && typeof u.rawOutput === 'object' ? u.rawOutput.details : null;
    return !!(d && typeof d === 'object' && d.status === 'blocked');
  }
  // The plugin did not hold a call that ran (spec.plugin). The turn ends with an Error naming the plugin, and the agent stops:
  // its next calls would not be held either.
  function gateFailed(s, st, c, gated, failed = false) {
    if (st.closed || st.gateFail) return;
    const why = !gated ? 'the office never got it' : gated.pending ? 'before the office answered' : 'the office had declined it';
    const ran = failed
      ? `${label} reports a failed ${c.tool_name} ${what(c)} that the office never got. It may have run without the office's yes.`
      : `${label} ran ${c.tool_name} ${what(c)} without the office's yes (${why}).`;
    st.gateFail = `${ran} The ${PLUGIN_ID} plugin did not hold this call: it is not loaded, the Gateway was not restarted after openclaw plugins enable ${PLUGIN_ID}, or ${label} gave the call another id. The office stopped the session.`;
    emit(st, () => events.feed(s, 'wait', st.gateFail));
    try { st.rpc.notify('session/cancel', { sessionId: st.sid }); } catch { /* the agent is gone */ }
    if (st.endCancel) st.endCancel({ stopReason: 'cancelled' });
    setImmediate(() => killChild(st)); // the exit ends the session
  }

  // ----- approvals -----
  const CANCELLED = { outcome: { outcome: 'cancelled' } };
  const pick = (o) => ({ outcome: { outcome: 'selected', optionId: o.optionId } });
  const norm = (st, p) => fileKey(st.root, p);

  // The reason the agent gives for a request (dsh asks again with one), only for an agent kind that declares 'reason'. ACP names no
  // field for it: it is read from `reason` or `_meta.reason` of the request or its tool call. Not checked against a real dsh yet.
  function reasonOf(params) {
    if (!spec.features.includes('reason')) return null;
    for (const o of [params, params.toolCall]) {
      const v = o && (typeof o.reason === 'string' ? o.reason : o._meta && typeof o._meta.reason === 'string' ? o._meta.reason : null);
      if (v && v.trim()) return v;
    }
    return null;
  }

  // session/request_permission: held like any request. The answer is allow once or reject once, never an always option.
  // It is the answer to what the card showed: a frozen copy of the call (shown) gives the grant and the declined file.
  function onPermission(s, st, params) {
    const c = track(st, params.toolCall);
    if (!c) throw rpcError(-32602, 'The request names no tool call.');
    recheck(s, st, c); // a second request for a call that changed: the first one goes
    openCall(s, st, c);
    c.asked = true;
    const options = (Array.isArray(params.options) ? params.options : []).filter((o) => o && typeof o.optionId === 'string');
    const once = options.find((o) => o.kind === 'allow_once'), no = options.find((o) => o.kind === 'reject_once');
    if (!once && options.some((o) => o.kind === 'allow_always')) {
      emit(st, () => events.feed(s, 'wait', `${label} offers only Always allow for ${c.tool_name} ${c.title}. The office never gives a lasting allow, so Approve declines.`.replace(/\s+\./, '.')));
    }
    if (st.closed || st.interrupted || st.gateFail) return CANCELLED;
    // spec.plugin: the office already answered this call when the plugin sent it (gate). OpenClaw's own exec approval for the
    // same call gets a no at once, and a yes only for the command the office approved: that request shows the command that
    // will run, which another plugin may have changed after the office's yes. Another command, or a paired device, is held again.
    const g0 = st.gated.get(c.id), g = g0 && !g0.pending ? g0 : null; // a call the office has not answered yet is held as usual
    if (g && !g.allow) return no ? pick(no) : CANCELLED;
    if (g && g.allow) {
      // The approval carries only the command and the host (OpenClaw src/acp/permission-relay.ts), so env, workdir and elevated
      // cannot be compared here; a host the user approved by name must be the same.
      const host = c.raw && typeof c.raw.host === 'string' ? c.raw.host.trim() : '';
      const ran = String(c.tool_input.command || '').trim();
      const moved = !!(g.host && host && host !== g.host);
      if (c.tool_name === 'Bash' && g.command !== null && ran === g.command && host !== 'node' && !moved) return once ? pick(once) : CANCELLED;
      const why = host === 'node' ? 'on a paired device' : moved ? `on another host (${host}) than the one you approved (${g.host})` : 'another command than the one you approved';
      emit(st, () => events.feed(s, 'wait', `${label} asks to run ${why}: ${clip(ran || c.title, 100)}`));
    }
    const shown = { kind: c.kind, tool_name: c.tool_name, tool_input: { ...c.tool_input }, sig: sigOf(c), told: false };
    shown.file = EDIT_KINDS.has(c.kind) && shown.tool_input.file_path ? norm(st, shown.tool_input.file_path) : null;
    return new Promise((resolve) => {
      let id = null;
      id = asks.hold(s, st, { tool_name: shown.tool_name, tool_input: shown.tool_input, ask_reason: reasonOf(params) }, (v) => {
        if (id) c.held.delete(id);
        if (v === 'allow' && once) { grant(st, shown, c.id); c.approved = shown; resolve(pick(once)); }
        else if (v === 'cancel') resolve(CANCELLED);
        else if (v === 'withdraw' || v === 'allow') {
          // Not the user's no (the agent moved on or changed the call, or offered only Always allow): no refusal, but a
          // write of that file through the office asks first for the rest of the turn.
          if (shown.file) st.askFirst.add(shown.file);
          resolve(no ? pick(no) : CANCELLED);
        } else if (!no) resolve(CANCELLED);
        else {
          // A declined edit: that file is refused for the rest of the turn. One that names no file makes every write ask.
          if (shown.file) st.denied.add(shown.file);
          else if (EDIT_KINDS.has(shown.kind)) st.deniedVague = true;
          resolve(pick(no));
        }
      }, {
        // Hermes issue #63302: its edit approval stops after a fixed time (a command approval follows its own setting). When
        // the agent reports the call as failed first, endCall frees the hold the same way.
        ...(spec.askTimeoutMs && EDIT_KINDS.has(c.kind) ? { timeoutMs: spec.askTimeoutMs, onTimeout: (rid) => withdraw(s, st, rid, `${label} waits ${Math.round(spec.askTimeoutMs / 1000)} s for an answer to an edit. It moved on without yours.`) } : {}),
        firm: false,
      });
      if (!id) return;
      c.held.set(id, shown);
    });
  }
  // An approved call lets the office serve that same command or that same file's write once, without a second prompt, until
  // that call ends (endCall). The keys come from what the card showed.
  function grant(st, shown, callId) {
    if (shown.tool_name === 'Bash' && shown.tool_input.command) st.grants.set('Bash\n' + shown.tool_input.command, callId);
    if (shown.file) st.grants.set('Write\n' + shown.file, callId);
  }
  return { track, recheck, openCall, endCall, onPermission, CANCELLED, norm };
}
