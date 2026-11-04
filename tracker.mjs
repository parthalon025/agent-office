// Session tracker: the rules that turn Claude Code events into the office's sessions.
// Two inputs: a hook payload (onHook, permissionRequest) and a stream line (onStream).
// One output: tracker.sessions, which the server sends as the sessions snapshot.
//
// Everything outside the rules is injected, so a test needs no server, no timers, no git and no
// child process. Importing this module starts nothing. The server passes real adapters; tests pass
// in-memory ones (see test/tracker.test.mjs).
import path from 'node:path';
import crypto from 'node:crypto';
import { riskOf } from './risk.mjs';

export const MAX_CALLS = 60;
const LIVE_MS = 300;

const basename = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
export const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

export function describeTool(name, input = {}) {
  const base = (v) => basename(String(v || ''));
  switch (name) {
    case 'Bash': return clip(input.command, 90);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return base(input.file_path);
    case 'Grep': case 'Glob': return clip(input.pattern, 60);
    case 'WebFetch': return clip(input.url, 70);
    case 'WebSearch': return clip(input.query, 70);
    case 'Task': case 'Agent': return clip(input.description || input.subagent_type, 70);
    case 'Skill': return clip(input.skill, 70);
    default:
      // browser tools (Playwright and the like): the page, the element or the key
      if (/playwright|browser/i.test(name)) return clip(input.url || input.element || input.key || '', 80);
      return clip(input.description || input.command || input.file_path || input.query || '', 70);
  }
}
const isAgentTool = (n) => n === 'Task' || n === 'Agent';

// A readable picture of what a permission prompt would change, shown on the Approve card.
export function makePreview(tool, input = {}) {
  const cap = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n) + '\n… (' + (t.length - n) + ' more characters)' : t; };
  const lines = (t, mark) => cap(t, 1500).split('\n').map((l) => mark + ' ' + l).join('\n');
  try {
    if (tool === 'Bash') return cap(input.command, 1800);
    if (tool === 'Edit') return `${input.file_path}\n${lines(input.old_string, '-')}\n${lines(input.new_string, '+')}`;
    if (tool === 'MultiEdit') return `${input.file_path}\n` + (input.edits || []).slice(0, 6).map((e) => `${lines(e.old_string, '-')}\n${lines(e.new_string, '+')}`).join('\n···\n');
    if (tool === 'Write') return `${input.file_path} (new content)\n${lines(String(input.content ?? '').split('\n').slice(0, 40).join('\n'), '+')}`;
    if (tool === 'NotebookEdit') return `${input.notebook_path || input.file_path}\n${lines(input.new_source, '+')}`;
    if (tool === 'WebFetch') return `${input.url}\n${cap(input.prompt, 300)}`;
    return cap(JSON.stringify(input, null, 1), 900);
  } catch { return ''; }
}
// Rules Claude offers for "always allow". Only plain allow rules are ever passed back.
export const allowRules = (sug) => (Array.isArray(sug) ? sug : []).filter((x) => x && x.type === 'addRules' && x.behavior === 'allow' && Array.isArray(x.rules));
export const ruleLabel = (sug) => allowRules(sug).flatMap((x) => x.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))).join(', ');

const ID_BYTES = { session: 4, permission: 5, question: 5 };
const ID_PREFIX = { session: '', permission: 'p', question: 'q' };
const defaultId = (kind) => (ID_PREFIX[kind] ?? '') + crypto.randomBytes(ID_BYTES[kind] ?? 4).toString('hex');

/**
 * @param {object} [deps] every field is optional; the defaults are real clocks and no-ops.
 * @param {() => number} [deps.now] the clock, in milliseconds.
 * @param {(kind: 'session'|'permission'|'question') => string} [deps.makeId] id maker.
 * @param {(cwd: string) => Promise<object|null>} [deps.locate] git location of a folder: { repo, root, branch } or null.
 * @param {() => void} [deps.onChange] called after a state change (the server broadcasts).
 * @param {(id: string, decision: object) => void} [deps.releaseHold] frees a held permission request or question.
 * @param {(response: object) => void} [deps.onControlResponse] a control_response stream line arrived.
 * @param {(fn: Function, ms: number) => unknown} [deps.setTimer] timer for the throttled live text.
 * @param {object} [deps.persist] persistence sink.
 * @param {(s: object) => void} [deps.persist.history] a session reached a point worth saving.
 * @param {(dir: string) => void} [deps.persist.recentDir] a folder a session started in.
 * @param {(list: {commands: string[], skills: string[]}) => void} [deps.persist.commands] last known slash commands.
 * @param {(s: object, git: object|null) => void} [deps.persist.placed] a session's place was looked up.
 */
export function createTracker(deps = {}) {
  const now = deps.now || Date.now;
  const makeId = deps.makeId || defaultId;
  const locate = deps.locate || (async () => null);
  const changed = deps.onChange || (() => {});
  const releaseHold = deps.releaseHold || (() => {});
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const persist = deps.persist || {};

  /** @type {Map<string, any>} uid -> session */
  const sessions = new Map();
  const feed = [];

  function addFeed(s, kind, text) {
    feed.push({ t: now(), uid: s.uid, name: s.name, kind, text });
    if (feed.length > 200) feed.splice(0, feed.length - 200);
  }

  function newSession(fields) {
    const t = now();
    const s = {
      uid: makeId('session'),
      sid: null, officeId: null, name: '', cwd: '', model: null, status: 'idle',
      tool: null, prompt: '', note: '', pending: [], questions: [], inbox: [], replies: [], replySeq: 0, headless: false, commands: [], skills: [], cost: null, costBase: 0, live: '', mode: null,
      ctxTokens: null, ctxWindow: null, worktree: null, budget: null, scheduleId: null, interrupted: false, turns: 0,
      // calls: tool calls, newest last. agents: subagents (Task or Agent tool). todos: the TodoWrite plan.
      calls: [], agents: [], todos: [], usage: { tokens: 0, cached: 0, input: 0 }, error: null, errorSeq: 0,
      // git: { repo, root, branch } of cwd, or null outside git. placed: git was looked up at least once.
      git: null, placed: false, gitCwd: '', gitAt: 0,
      startedAt: t, lastEvent: t, endedAt: null,
      pid: null, launched: false, ...fields,
    };
    sessions.set(s.uid, s);
    return s;
  }

  // The office draws a repository as a building, a branch as a floor and a worktree as a room.
  // Look the place up when the folder changes, at the start and end of each turn, and at most every 15 s.
  // Resolves when s.git is current (at once when the last lookup is recent enough).
  function placeSession(s, force = false) {
    if (s.status === 'ended') return Promise.resolve();
    if (!s.cwd) { s.placed = true; return Promise.resolve(); }
    if (!force && s.gitCwd === s.cwd && now() - s.gitAt < 15000) return Promise.resolve();
    s.gitCwd = s.cwd; s.gitAt = now();
    return locate(s.cwd).then((g) => {
      const diff = !s.placed || JSON.stringify(g) !== JSON.stringify(s.git);
      s.git = g; s.placed = true;
      persist.placed?.(s, g);
      if (diff) changed();
    });
  }

  // ---------- tool calls ----------
  // One tool call: opened by PreToolUse, closed by PostToolUse or PostToolUseFailure.
  function openCall(s, p) {
    if (!p.tool_use_id || s.calls.some((c) => c.id === p.tool_use_id)) return;
    const input = p.tool_input || {};
    // file: the path inside the worktree, for the room board's repo view
    const fp = input.file_path || input.path;
    const top = s.git?.root || s.cwd;
    const rel = fp && top ? path.relative(top, String(fp)).replace(/\\/g, '/') : null;
    s.calls.push({ id: p.tool_use_id, name: p.tool_name, detail: describeTool(p.tool_name, input), file: rel && !rel.startsWith('..') ? rel : null, agent: p.agent_id, t: now(), ms: null, ok: null, err: null });
    if (isAgentTool(p.tool_name)) s.agents.push({ call: p.tool_use_id, id: null, type: input.subagent_type || 'general-purpose', task: describeTool(p.tool_name, input), done: false, ok: null });
    // Keep every open call; drop the oldest closed ones.
    while (s.calls.length > MAX_CALLS) { const i = s.calls.findIndex((c) => c.ok !== null); if (i < 0) break; s.calls.splice(i, 1); }
  }
  function closeCall(s, id, ok, ms, err) {
    const c = s.calls.find((x) => x.id === id);
    if (!c || c.ok !== null) return;
    c.ok = ok; c.ms = ms ?? now() - c.t; c.err = err || null;
    const a = s.agents.find((x) => x.call === id);
    if (a && !a.done) { a.done = true; a.ok = ok; }
  }
  // A turn ended: nothing is still running.
  function closeAll(s, why) {
    for (const c of s.calls) if (c.ok === null) closeCall(s, c.id, false, null, why);
    for (const a of s.agents) if (!a.done) { a.done = true; a.ok = false; }
    if (s.agents.length > 20) s.agents = s.agents.slice(-20);
  }

  // ---------- questions and permission prompts ----------
  function dropPending(s) { for (const r of [...s.pending]) releaseHold(r.id, {}); s.pending = []; }
  function dropQuestions(s, text) { for (const r of [...s.questions]) releaseHold(r.id, { text }); s.questions = []; }
  // A held request ended (answered, timed out, or cancelled): the session stops waiting when nothing else waits.
  function settle(uid, id) {
    const s = sessions.get(uid);
    if (!s) return;
    s.pending = s.pending.filter((r) => r.id !== id);
    s.questions = s.questions.filter((r) => r.id !== id);
    if (!s.pending.length && !s.questions.length && s.status === 'waiting') s.status = 'working';
  }

  function findSession(p) {
    if (p.office_id) for (const s of sessions.values()) if (s.officeId === p.office_id) return s;
    for (const s of sessions.values()) if (s.sid === p.session_id) return s;
    return null;
  }

  // Queued messages reach a session at its next tool call (PostToolUse), its next prompt, or the end
  // of its turn (Stop). A session sitting idle at its prompt receives them when it next wakes.
  function deliver(s, ev) {
    if (!s.inbox.length) return null;
    const text = s.inbox.map((m) => '- ' + m.text).join('\n');
    s.inbox = [];
    addFeed(s, 'tool', 'read a message from the office');
    const note = 'Message from the user in Agent Office:\n' + text;
    if (ev === 'Stop') return { decision: 'block', reason: note + '\n\nAnswer it, then continue.' };
    return { hookSpecificOutput: { hookEventName: ev, additionalContext: note } };
  }

  function endSession(s, why) {
    if (s.status === 'ended') return;
    dropPending(s);
    dropQuestions(s, 'The session ended before the user answered.');
    s.status = 'ended'; s.endedAt = now(); s.tool = null; s.live = ''; closeAll(s, 'The session ended.');
    addFeed(s, 'end', why);
    persist.history?.(s);
  }

  // ---------- input one: hook payloads ----------
  // Returns the hook's answer (queued office messages) or null.
  function onHook(p) {
    if (!p.session_id) return null;
    const ev = p.hook_event_name;
    let s = findSession(p);
    if (!s) {
      if (ev === 'SessionEnd') return null;
      s = newSession({ name: basename(p.cwd) || 'session' });
    }
    s.sid = p.session_id;
    if (p.cwd) s.cwd = p.cwd;
    if (!s.name) s.name = basename(s.cwd) || 'session';
    if (p.model) s.model = p.model;
    s.lastEvent = now();
    if (s.status === 'ended' && ev !== 'SessionEnd') { s.endedAt = null; s.status = 'idle'; }
    const input = p.tool_input || {};

    let out = null;
    switch (ev) {
      case 'SessionStart':
        s.status = 'idle'; s.tool = null; s.note = ''; closeAll(s, 'The session restarted.');
        addFeed(s, 'start', `sat down (${p.source || 'startup'})`);
        break;
      case 'UserPromptSubmit':
        s.status = 'working'; s.prompt = p.prompt || ''; s.note = ''; s.turns += 1; s.error = null; s.promptAt = now();
        out = deliver(s, ev);
        addFeed(s, 'prompt', clip(s.prompt, 140));
        break;
      case 'PreToolUse':
        s.status = 'working'; s.note = '';
        openCall(s, p);
        // The bot's task line shows the main agent's tool; a subagent's tools show on its helper.
        if (!p.agent_id) s.tool = { name: p.tool_name, detail: describeTool(p.tool_name, input) };
        break;
      case 'PostToolUse':
        if (!p.agent_id) s.tool = null;
        dropPending(s);
        closeCall(s, p.tool_use_id, true, p.duration_ms);
        if (p.tool_name === 'TodoWrite' && Array.isArray(input.todos) && !p.agent_id) s.todos = input.todos;
        out = deliver(s, ev);
        addFeed(s, 'tool', `${p.tool_name} ${describeTool(p.tool_name, input)}`.trim());
        break;
      case 'PostToolUseFailure':
        if (!p.agent_id) s.tool = null;
        dropPending(s);
        closeCall(s, p.tool_use_id, false, p.duration_ms, p.is_interrupt ? 'Stopped' : p.error || 'Failed');
        addFeed(s, 'tool', `${p.tool_name} failed${p.is_interrupt ? ' (stopped)' : ''}`);
        break;
      case 'SubagentStart': {
        // Link the subagent to the oldest Task or Agent call of the same type that has no subagent yet.
        const a = s.agents.find((x) => !x.id && !x.done && x.type === p.agent_type) || s.agents.find((x) => !x.id && !x.done);
        if (a && p.agent_id) a.id = p.agent_id;
        break;
      }
      case 'Notification':
        s.note = p.message || '';
        addFeed(s, 'wait', clip(s.note || 'sent a notification', 140));
        break;
      case 'Stop':
        s.status = 'idle'; s.tool = null; s.note = ''; dropPending(s); closeAll(s, 'The turn ended first.');
        out = deliver(s, ev);
        if (out) s.status = 'working';
        addFeed(s, 'stop', 'finished the turn');
        break;
      case 'SubagentStop': {
        const a = s.agents.find((x) => x.id && x.id === p.agent_id);
        if (a && !a.done) { a.done = true; a.ok = true; }
        addFeed(s, 'tool', 'a helper finished');
        break;
      }
      case 'SessionEnd':
        endSession(s, p.reason ? `left (${p.reason})` : 'left');
        break;
      default: break;
    }
    if (p.cwd && ev === 'SessionStart') persist.recentDir?.(p.cwd);
    void placeSession(s, ev === 'SessionStart' || ev === 'UserPromptSubmit' || ev === 'Stop');
    changed();
    return out;
  }

  // A PermissionRequest hook. Records the prompt on the session and returns what the server needs to
  // hold the request: { s, id, suggestions }. Null when no session is known (the server answers {}).
  function permissionRequest(p) {
    onHook({ ...p, hook_event_name: 'PermissionRequest' });
    const s = findSession(p);
    if (!s) return null;
    const id = makeId('permission');
    const detail = describeTool(p.tool_name, p.tool_input);
    const suggestions = allowRules(p.permission_suggestions);
    s.pending.push({ id, tool: p.tool_name, detail, risk: riskOf(p.tool_name, p.full_input || p.tool_input, s.cwd), preview: makePreview(p.tool_name, p.full_input || p.tool_input), always: ruleLabel(suggestions), t: now() });
    s.status = 'waiting'; s.note = `${p.tool_name} ${detail}`.trim();
    addFeed(s, 'wait', `asks to use ${s.note}`);
    changed();
    return { s, id, suggestions };
  }

  // An office_ask question from the agent. Returns its id.
  function askQuestion(s, question) {
    const id = makeId('question');
    const text = String(question || '');
    s.questions.push({ id, text: text.slice(0, 600), t: now() });
    s.status = 'waiting'; s.note = clip(text, 120);
    addFeed(s, 'wait', 'asks: ' + clip(text, 120));
    changed();
    return id;
  }

  // The user stopped the turn.
  function interrupt(s) {
    s.interrupted = true;
    dropPending(s); dropQuestions(s, 'The user stopped this turn.');
    addFeed(s, 'stop', 'stopped the turn from the office');
  }

  // ---------- input two: stream lines ----------
  function pushReply(s, text) {
    s.replies.push({ id: ++s.replySeq, text: clip(String(text), 8000), t: now() });
    if (s.replies.length > 40) s.replies.shift();
    addFeed(s, 'tool', 'replied: ' + clip(String(text).replace(/\s+/g, ' '), 100));
    changed();
  }

  const liveTimers = new Map();
  function pushLive(s, text) {
    s.live = (s.live + text).slice(-600);
    if (liveTimers.has(s.uid)) return;
    liveTimers.set(s.uid, setTimer(() => { liveTimers.delete(s.uid); changed(); }, LIVE_MS));
  }

  function onStream(s, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'control_response') {
      deps.onControlResponse?.(m.response);
    } else if (m.type === 'stream_event') {
      const e = m.event || {};
      if (m.parent_tool_use_id) return;
      if (e.type === 'message_start') s.live = '';
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') pushLive(s, e.delta.text || '');
    } else if (m.type === 'system' && m.subtype === 'init') {
      if (m.model) s.model = m.model;
      if (m.permissionMode) s.mode = m.permissionMode;
      if (!s.sid && m.session_id) s.sid = m.session_id;
      if (Array.isArray(m.slash_commands)) s.commands = m.slash_commands.filter((x) => typeof x === 'string').slice(0, 400);
      if (Array.isArray(m.skills)) s.skills = m.skills.filter((x) => typeof x === 'string').slice(0, 400);
      // Claude reports these only after its first message, so keep the last list for sessions that have not spoken yet.
      if (s.commands.length) persist.commands?.({ commands: s.commands, skills: s.skills });
    } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
      s.live = '';
      const u = m.message?.usage;
      if (u) s.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      // One API call can arrive as several assistant lines with the same id; count its usage once.
      const mid = m.message?.id;
      if (u && mid && mid !== s.lastUsageId) {
        s.lastUsageId = mid;
        s.usage.tokens += s.ctxTokens + (u.output_tokens || 0);
        s.usage.input += s.ctxTokens;
        s.usage.cached += u.cache_read_input_tokens || 0;
      }
      for (const b of m.message?.content || []) if (b.type === 'text' && b.text && b.text.trim()) pushReply(s, b.text);
    } else if (m.type === 'result') {
      s.live = '';
      if (typeof m.total_cost_usd === 'number') s.cost = (s.costBase || 0) + m.total_cost_usd;
      const mu = m.modelUsage && Object.values(m.modelUsage)[0];
      if (mu?.contextWindow) s.ctxWindow = mu.contextWindow;
      // The turn is over: show the bot at rest even when the stop hook did not run (a stopped turn, a spending limit).
      dropPending(s);
      if (s.status === 'working' || s.status === 'waiting') { s.status = 'idle'; s.tool = null; }
      closeAll(s, s.interrupted ? 'Stopped' : 'The turn ended first.');
      const sub = String(m.subtype || '');
      let why = null;
      if (sub.startsWith('error_max_budget')) why = `This session reached its spending limit of $${s.budget}.`;
      else if (m.is_error && m.result && !s.interrupted) why = String(m.result);
      if (why) {
        pushReply(s, 'Stopped: ' + why);
        s.error = { id: ++s.errorSeq, text: clip(why, 200) };
      }
      persist.history?.(s);
      changed();
    }
  }

  return {
    sessions, feed, addFeed, newSession, findSession, placeSession,
    onHook, permissionRequest, askQuestion, settle, interrupt, deliver,
    onStream, pushReply, endSession, dropPending, dropQuestions, closeAll,
  };
}
