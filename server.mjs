#!/usr/bin/env node
// Agent Office server: receives Claude Code hook events, streams office state to the
// browser, and opens / closes Claude Code sessions. Zero dependencies. Windows-first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as git from './git.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.OFFICE_PORT) || 4317;
const HOST = '127.0.0.1';
const TOKEN_FILE = path.join(ROOT, '.office-token');
// Reuse the token across restarts, so hooks of sessions that are already running keep working.
const TOKEN = (() => {
  try { const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token; if (/^[0-9a-f]{48}$/.test(t)) return t; } catch { /* first run */ }
  return crypto.randomBytes(24).toString('hex');
})();
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const HOOKS_CMD_FILE = path.join(ROOT, 'office-hooks.json');
const HOOKS_HTTP_FILE = path.join(ROOT, 'office-hooks-http.json');
const STATE_FILE = path.join(ROOT, 'state.json');
const MCP_FILE = path.join(ROOT, 'office-mcp.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');

const MODEL_RE = /^(opus|sonnet|haiku|claude-[\w.-]+)$/;
const MODES = new Set(['default', 'acceptEdits', 'plan']);
const MAX_ATTACH_CHARS = 9_000_000; // base64 characters across all attachments of one message
const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
];
// How long the office holds a permission prompt before handing it back to the terminal dialog.
const HEADLESS_ASK_MS = 15 * 60 * 1000; // sessions run inside the office have no terminal dialog to fall back to
const ASK_TIMEOUT_MS = (Number(process.env.OFFICE_ASK_TIMEOUT_S) || 60) * 1000;

// ---------- setup: hook settings ----------
let persisted = { recent: [] };
try { persisted = { ...persisted, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
// Drop folders that are gone, and worktree folders from older runs.
persisted.recent = (persisted.recent || []).filter((d) => fs.existsSync(d) && !/[\\/]\.agent-office[\\/]worktrees/.test(d));
const savePersisted = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2)); } catch { /* ignore */ } };
const rememberDir = (dir) => {
  persisted.recent = [dir, ...persisted.recent.filter((d) => d.toLowerCase() !== dir.toLowerCase())].slice(0, 12);
  savePersisted();
};


const NODE = process.execPath.replace(/\\/g, '/');
// The hook may wait as long as the longest hold below; the server decides when to give up.
const askSeconds = 1000;
const hookCommand = `"${NODE}" "${path.join(ROOT, 'hook.mjs').replace(/\\/g, '/')}"`;
// The office tools are safe to pre-allow: they only talk to this server.
const PERMISSIONS = { allow: ['mcp__office__office_inbox', 'mcp__office__office_ask'] };

// Command hooks: one Node process per event (~60 ms). Works on every Claude Code version.
const commandSettings = {
  hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => {
    const entry = { hooks: [{ type: 'command', command: hookCommand, timeout: ev === 'PermissionRequest' ? askSeconds : 10 }] };
    if (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PermissionRequest') entry.matcher = '*';
    return [ev, [entry]];
  })),
  permissions: PERMISSIONS,
};
// HTTP hooks: Claude posts straight to the office, with no Node start-up. Session start and end stay
// command hooks (start needs the process walk, end runs while the process exits). An HTTP failure is
// non-blocking, so a stopped office never stalls a session.
const HTTP_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStop']);
const httpSettings = {
  hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => {
    const hook = HTTP_EVENTS.has(ev)
      ? { type: 'http', url: `http://127.0.0.1:${PORT}/hook/http`, headers: { 'x-office-token': TOKEN, 'x-office-id': '$OFFICE_ID' }, allowedEnvVars: ['OFFICE_ID'], timeout: ev === 'PermissionRequest' ? askSeconds : 10 }
      : { type: 'command', command: hookCommand, timeout: 10 };
    const entry = { hooks: [hook] };
    if (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PermissionRequest') entry.matcher = '*';
    return [ev, [entry]];
  })),
  permissions: PERMISSIONS,
};
fs.writeFileSync(HOOKS_CMD_FILE, JSON.stringify(commandSettings, null, 2));
fs.writeFileSync(HOOKS_HTTP_FILE, JSON.stringify(httpSettings, null, 2));

// Use HTTP hooks only after a probe proved them on this Claude Code version (npm run probe).
let CLAUDE_VERSION = 'unknown';
try { CLAUDE_VERSION = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch { /* keep unknown */ }
const httpProven = () => persisted.httpHooks?.ok === true && persisted.httpHooks.version === CLAUDE_VERSION;
let hooksMode = process.env.OFFICE_HOOKS === 'command' ? 'command' : (process.env.OFFICE_HOOKS === 'http' || httpProven() ? 'http' : 'command');
const activeHooksFile = () => (hooksMode === 'http' ? HOOKS_HTTP_FILE : HOOKS_CMD_FILE);
const mcpConfig = { mcpServers: { office: { command: process.execPath.replace(/\\/g, '/'), args: [path.join(ROOT, 'mcp.mjs').replace(/\\/g, '/')] } } };
fs.writeFileSync(MCP_FILE, JSON.stringify(mcpConfig, null, 2));

// ---------- past sessions ----------
// Sessions that run inside the office are saved, so a restart or a closed session can be reopened
// with `claude --resume`. They are listed under Past sessions, never on the floor.
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }
for (const h of history) h.endedAt = h.endedAt || Date.now(); // whatever was running died with the last server
let historyTimer = null;
function saveHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch { /* ignore */ } }, 800);
}
function recordHistory(s) {
  if (!s.headless || !s.sid) return;
  const rec = {
    uid: s.uid, sid: s.sid, name: s.name, cwd: s.cwd, model: s.model, mode: s.mode, cost: s.cost, turns: s.turns,
    startedAt: s.startedAt, endedAt: s.endedAt, worktree: s.worktree, replies: s.replies.slice(-40), prompt: s.prompt, budget: s.budget,
  };
  const i = history.findIndex((h) => h.uid === s.uid);
  if (i >= 0) history[i] = rec; else history.unshift(rec);
  history = history.slice(0, 60);
  saveHistory();
}

// ---------- state ----------
/** @type {Map<string, any>} uid -> session */
const sessions = new Map();
const feed = [];
const clients = new Set();

const basename = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function newSession(fields) {
  const s = {
    uid: crypto.randomBytes(4).toString('hex'),
    sid: null, officeId: null, name: '', cwd: '', model: null, status: 'idle',
    tool: null, prompt: '', note: '', pending: [], questions: [], inbox: [], replies: [], replySeq: 0, headless: false, commands: [], skills: [], cost: null, costBase: 0, live: '', mode: null,
    ctxTokens: null, ctxWindow: null, worktree: null, budget: null, scheduleId: null, interrupted: false, helpers: 0, tools: 0, turns: 0,
    startedAt: Date.now(), lastEvent: Date.now(), endedAt: null,
    pid: null, launched: false, ...fields,
  };
  sessions.set(s.uid, s);
  return s;
}

function addFeed(s, kind, text) {
  feed.push({ t: Date.now(), uid: s.uid, name: s.name, kind, text });
  if (feed.length > 200) feed.splice(0, feed.length - 200);
}

function describeTool(name, input = {}) {
  const base = (v) => basename(String(v || ''));
  switch (name) {
    case 'Bash': return clip(input.command, 90);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return base(input.file_path);
    case 'Grep': case 'Glob': return clip(input.pattern, 60);
    case 'WebFetch': return clip(input.url, 70);
    case 'WebSearch': return clip(input.query, 70);
    case 'Task': case 'Agent': return clip(input.description || input.subagent_type, 70);
    default: return clip(input.description || input.command || input.file_path || input.query || '', 70);
  }
}
const isAgentTool = (n) => n === 'Task' || n === 'Agent';
function riskOf(tool, input = {}) {
  if (tool === 'Bash') return /\b(rm|sudo|git\s+push|git\s+reset|del|rmdir|format|curl|wget|chmod|kill|taskkill|drop)\b/i.test(input.command || '') ? 'high' : 'medium';
  if (tool === 'WebFetch' || String(tool).startsWith('mcp__')) return 'medium';
  return 'low';
}

// A readable picture of what a permission prompt would change, shown on the Approve card.
function makePreview(tool, input = {}) {
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
const allowRules = (sug) => (Array.isArray(sug) ? sug : []).filter((x) => x && x.type === 'addRules' && x.behavior === 'allow' && Array.isArray(x.rules));
const ruleLabel = (sug) => allowRules(sug).flatMap((x) => x.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))).join(', ');

function findSession(p) {
  if (p.office_id) for (const s of sessions.values()) if (s.officeId === p.office_id) return s;
  for (const s of sessions.values()) if (s.sid === p.session_id) return s;
  return null;
}

// Finds the claude process above a hook's parent, so the office can close sessions it did not launch.
// The hook's parent shell dies right after the hook returns, so the walk has to happen while the hook
// still waits. A persistent PowerShell helper makes that walk in ~100 ms instead of a ~550 ms cold start.
const WALK = [
  'while (($l = [Console]::In.ReadLine()) -ne $null) {',
  '  $i = [int]$l; $found = 0',
  '  for ($n = 0; $n -lt 10; $n++) {',
  '    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$i"',
  '    if (-not $p) { break }',
  "    if ($p.Name -eq 'claude.exe' -or ($p.Name -eq 'node.exe' -and $p.CommandLine -match 'claude-code')) { $found = $p.ProcessId; break }",
  '    $i = $p.ParentProcessId',
  '  }',
  '  [Console]::Out.WriteLine("$l=$found"); [Console]::Out.Flush()',
  '}',
].join('\n');
let walker = null;
const walks = new Map();
function startWalker() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WALK], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const [key, pid] = buf.slice(0, i).trim().split('=');
      buf = buf.slice(i + 1);
      const done = walks.get(key);
      if (done) { walks.delete(key); done(Number(pid) || null); }
    }
  });
  child.on('exit', () => { walker = null; for (const done of walks.values()) done(null); walks.clear(); });
  child.stdin.on('error', () => {});
  return child;
}
function walkToClaude(ppid) {
  if (process.platform !== 'win32') return Promise.resolve(ppid);
  const key = String(Number(ppid) | 0);
  if (!walker) walker = startWalker();
  return new Promise((resolve) => {
    const t = setTimeout(() => { walks.delete(key); resolve(null); }, 1200);
    walks.set(key, (pid) => { clearTimeout(t); resolve(pid); });
    walker.stdin.write(key + '\n');
  });
}
// Warm the helper now so the first session start is fast too.
if (process.platform === 'win32') walker = startWalker();

const SLIM_KEEP = ['command', 'file_path', 'pattern', 'url', 'description', 'path', 'query', 'subagent_type'];
// HTTP hooks deliver Claude's full payload; keep only what the office displays.
function slim(b, officeId) {
  const tool_input = {};
  if (b.tool_input && typeof b.tool_input === 'object') for (const k of SLIM_KEEP) if (b.tool_input[k] != null) tool_input[k] = String(b.tool_input[k]).slice(0, 300);
  return {
    hook_event_name: b.hook_event_name, session_id: b.session_id, cwd: b.cwd, source: b.source, model: b.model,
    tool_name: b.tool_name, tool_input, prompt: clip(b.prompt, 400), message: clip(b.message, 300), reason: b.reason,
    office_id: officeId || null,
    ...(b.hook_event_name === 'PermissionRequest' ? { full_input: b.tool_input, permission_suggestions: b.permission_suggestions } : {}),
  };
}
let probeSeen = null; // while probing: which events arrived over HTTP

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
  s.lastEvent = Date.now();
  if (s.status === 'ended' && ev !== 'SessionEnd') { s.endedAt = null; s.status = 'idle'; }

  let out = null;
  switch (ev) {
    case 'SessionStart':
      s.status = 'idle'; s.tool = null; s.helpers = 0; s.note = '';
      addFeed(s, 'start', `sat down (${p.source || 'startup'})`);
      break;
    case 'UserPromptSubmit':
      s.status = 'working'; s.prompt = p.prompt || ''; s.note = ''; s.turns += 1;
      out = deliver(s, ev);
      addFeed(s, 'prompt', clip(s.prompt, 140));
      break;
    case 'PreToolUse':
      s.status = 'working'; s.note = '';
      s.tool = { name: p.tool_name, detail: describeTool(p.tool_name, p.tool_input) };
      if (isAgentTool(p.tool_name)) s.helpers += 1;
      break;
    case 'PostToolUse':
      s.tools += 1; s.tool = null; dropPending(s);
      out = deliver(s, ev);
      if (isAgentTool(p.tool_name)) s.helpers = Math.max(0, s.helpers - 1);
      addFeed(s, 'tool', `${p.tool_name} ${describeTool(p.tool_name, p.tool_input)}`.trim());
      break;
    case 'Notification':
      s.note = p.message || '';
      addFeed(s, 'wait', clip(s.note || 'sent a notification', 140));
      break;
    case 'Stop':
      s.status = 'idle'; s.tool = null; s.helpers = 0; s.note = ''; dropPending(s);
      out = deliver(s, ev);
      if (out) s.status = 'working';
      addFeed(s, 'stop', 'finished the turn');
      break;
    case 'SubagentStop':
      addFeed(s, 'tool', 'a helper finished');
      break;
    case 'SessionEnd':
      endSession(s, p.reason ? `left (${p.reason})` : 'left');
      break;
    default: break;
  }
  if (p.cwd && ev === 'SessionStart') rememberDir(p.cwd);
  broadcast();
  return out;
}

function endSession(s, why) {
  if (s.status === 'ended') return;
  dropPending(s);
  dropQuestions(s, 'The session ended before the user answered.');
  s.status = 'ended'; s.endedAt = Date.now(); s.tool = null; s.helpers = 0; s.live = '';
  addFeed(s, 'end', why);
  recordHistory(s);
}

// ---------- messages to a session ----------
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

function sendMessage(uid, text, attachments = []) {
  const s = sessions.get(uid);
  if (!s || s.status === 'ended') throw httpError(404, 'That session has left the office.');
  const clean = String(text || '').trim().slice(0, 4000);
  if (!clean && !attachments.length) throw httpError(400, 'The message is empty.');
  if (attachments.length && !s.headless) throw httpError(400, 'Attachments work in sessions that run inside the office.');
  // A pending office_ask takes the next message as its answer.
  const q = s.questions[0];
  if (q && clean && holds.has(q.id)) { releaseHold(q.id, { text: clean }); addFeed(s, 'prompt', 'answered in the office: ' + clip(clean, 100)); return { answered: true }; }
  if (s.headless && (s.status !== 'working' || attachments.length)) {
    writeUser(s, clean, attachments);
    s.prompt = clean || '(attachment)';
    addFeed(s, 'prompt', 'sent from the office: ' + clip(clean, 100));
    broadcast();
    return { sent: true };
  }
  if (!clean) throw httpError(400, 'The message is empty.');
  s.inbox.push({ t: Date.now(), text: clean });
  addFeed(s, 'prompt', 'queued from the office: ' + clip(clean, 100));
  broadcast();
  return { queued: s.inbox.length };
}

// ---------- permission prompts (the office answers the PermissionRequest hook) ----------
/** @type {Map<string, {uid: string, res: http.ServerResponse, timer: NodeJS.Timeout}>} */
const holds = new Map();

function forget(id) {
  const h = holds.get(id);
  if (!h) return null;
  holds.delete(id); clearTimeout(h.timer);
  const s = sessions.get(h.uid);
  if (s) {
    s.pending = s.pending.filter((r) => r.id !== id);
    s.questions = s.questions.filter((r) => r.id !== id);
    if (!s.pending.length && !s.questions.length && s.status === 'waiting') s.status = 'working';
  }
  broadcast();
  return h;
}
function releaseHold(id, decision) {
  const h = forget(id);
  if (!h) return false;
  if (!h.res.writableEnded) { h.res.writeHead(200, { 'content-type': 'application/json' }); h.res.end(JSON.stringify(decision || {})); }
  return true;
}
function dropPending(s) { for (const r of [...s.pending]) releaseHold(r.id, {}); s.pending = []; }
function dropQuestions(s, text) { for (const r of [...s.questions]) releaseHold(r.id, { text }); s.questions = []; }

function onPermission(p, res) {
  onHook({ ...p, hook_event_name: 'PermissionRequest' });
  const s = findSession(p);
  if (!s) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const id = 'p' + crypto.randomBytes(5).toString('hex');
  const detail = describeTool(p.tool_name, p.tool_input);
  const sug = allowRules(p.permission_suggestions);
  s.pending.push({ id, tool: p.tool_name, detail, risk: riskOf(p.tool_name, p.full_input || p.tool_input), preview: makePreview(p.tool_name, p.full_input || p.tool_input), always: ruleLabel(sug), t: Date.now() });
  s.status = 'waiting'; s.note = `${p.tool_name} ${detail}`.trim();
  addFeed(s, 'wait', `asks to use ${s.note}`);
  const hold = s.headless ? HEADLESS_ASK_MS : ASK_TIMEOUT_MS;
  const timer = setTimeout(() => { if (releaseHold(id, {})) addFeed(s, 'wait', s.headless ? 'question timed out, Claude moved on' : 'question went back to the terminal'); }, hold);
  holds.set(id, { uid: s.uid, res, timer, suggestions: sug });
  // The terminal answered first and Claude cancelled the hook: drop the question.
  res.on('close', () => forget(id));
  broadcast();
}

function sessionFor(p) {
  for (const s of sessions.values()) if (p.office_id && s.officeId === p.office_id) return s;
  for (const s of sessions.values()) if (p.pid && s.pid === p.pid && s.status !== 'ended') return s;
  return null;
}

function onMcpInbox(p, res) {
  const s = sessionFor(p);
  let text = 'Agent Office does not recognise this session. Start it from the office or with the office settings file.';
  if (s) {
    if (!s.inbox.length) text = 'No new messages.';
    else { text = s.inbox.map((m) => '- ' + m.text).join('\n'); s.inbox = []; addFeed(s, 'tool', 'read the office inbox'); broadcast(); }
  }
  send(res, 200, { text });
}

function onMcpAsk(p, res) {
  const s = sessionFor(p);
  if (!s) return send(res, 200, { text: 'Agent Office does not recognise this session, so the question was not shown. Ask in the terminal.' });
  const id = 'q' + crypto.randomBytes(5).toString('hex');
  s.questions.push({ id, text: String(p.question || '').slice(0, 600), t: Date.now() });
  s.status = 'waiting'; s.note = clip(String(p.question || ''), 120);
  addFeed(s, 'wait', 'asks: ' + clip(String(p.question || ''), 120));
  const timer = setTimeout(() => releaseHold(id, { text: 'No answer from the office after 10 minutes. Continue without it, or ask in the terminal.' }), 10 * 60 * 1000);
  holds.set(id, { uid: s.uid, res, timer, kind: 'ask' });
  res.on('close', () => forget(id));
  broadcast();
}

function answer(id, allow, always = false) {
  const h = holds.get(id);
  if (!h) throw httpError(409, 'That question was already answered or went back to the terminal.');
  if (h.kind === 'ask') {
    const s0 = sessions.get(h.uid);
    if (s0) addFeed(s0, 'prompt', allow ? 'answered yes in the office' : 'answered no in the office');
    return void releaseHold(id, { text: allow ? 'Yes.' : 'No.' });
  }
  const decision = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Declined from Agent Office.' },
    },
  };
  if (allow && always && h.suggestions?.length) decision.hookSpecificOutput.decision.updatedPermissions = h.suggestions;
  const s = sessions.get(h.uid);
  if (s) addFeed(s, 'tool', allow ? (always ? 'approved and always allowed from the office' : 'approved from the office') : 'declined from the office');
  releaseHold(id, decision);
}

// ---------- sessions that run inside the office (no terminal) ----------
// Claude Code runs headless in stream-json mode: prompts go in on stdin, replies come back on stdout.
// Hooks still report activity and permission prompts, so the office behaves the same as for a terminal.
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const procs = new Map();

function pushReply(s, text) {
  s.replies.push({ id: ++s.replySeq, text: clip(String(text), 8000), t: Date.now() });
  if (s.replies.length > 40) s.replies.shift();
  addFeed(s, 'tool', 'replied: ' + clip(String(text).replace(/\s+/g, ' '), 100));
  broadcast();
}

// Images go in as image blocks and text files inline. Anything else is refused, never silently dropped.
function blocksFor(text, attachments) {
  const content = [];
  let total = 0;
  for (const a of attachments.slice(0, 6)) {
    const data = String(a.data || '');
    total += data.length;
    if (total > MAX_ATTACH_CHARS) throw httpError(413, 'The attachments are too large. The limit is about 6 MB in total.');
    const mime = String(a.mime || ''), name = String(a.name || 'file').slice(0, 80);
    if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
    else if (/^text\//.test(mime) || /\.(md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|css|html|csv|log|yml|yaml|toml|xml|sh|ps1|sql)$/i.test(name)) {
      content.push({ type: 'text', text: `Attached file ${name}:\n\`\`\`\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 200000)}\n\`\`\`` });
    } else throw httpError(415, `Cannot attach ${name}. Attach images or text files.`);
  }
  if (text) content.push({ type: 'text', text });
  return content;
}

function writeUser(s, text, attachments = []) {
  const c = procs.get(s.uid);
  if (!c || !c.stdin.writable) throw httpError(409, 'That session is not running.');
  const content = attachments.length ? blocksFor(text, attachments) : [{ type: 'text', text }];
  s.interrupted = false;
  c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
}

// Control requests (stop this turn, change mode or model) go down the same pipe as messages.
const controls = new Map();
function control(s, request, onDone) {
  const c = procs.get(s.uid);
  if (!c || !c.stdin.writable) throw httpError(409, 'That session is not running.');
  const id = 'c' + crypto.randomBytes(4).toString('hex');
  if (onDone) controls.set(id, onDone);
  c.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
}
const CONTROL_MODES = new Set(['default', 'plan', 'acceptEdits']);
function doControl(uid, action, value) {
  const s = sessions.get(uid);
  if (!s || !s.headless || s.status === 'ended') throw httpError(404, 'That session is not running in the office.');
  if (action === 'interrupt') {
    s.interrupted = true;
    dropPending(s); dropQuestions(s, 'The user stopped this turn.');
    control(s, { subtype: 'interrupt' });
    addFeed(s, 'stop', 'stopped the turn from the office');
  } else if (action === 'mode') {
    if (!CONTROL_MODES.has(value)) throw httpError(400, 'Unknown permission mode.');
    control(s, { subtype: 'set_permission_mode', mode: value }, (r) => { if (r.response?.mode) s.mode = r.response.mode; broadcast(); });
  } else if (action === 'model') {
    if (!MODEL_RE.test(String(value))) throw httpError(400, 'Unknown model.');
    control(s, { subtype: 'set_model', model: value }, (r) => { if (r.response?.model) s.model = r.response.model; broadcast(); });
  } else throw httpError(400, 'Unknown action.');
}

const liveTimers = new Map();
function pushLive(s, text) {
  s.live = (s.live + text).slice(-600);
  if (liveTimers.has(s.uid)) return;
  liveTimers.set(s.uid, setTimeout(() => { liveTimers.delete(s.uid); broadcast(); }, 300));
}

function onStream(s, line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') {
    const done = controls.get(m.response?.request_id);
    if (done) { controls.delete(m.response.request_id); done(m.response); }
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
    if (s.commands.length) { persisted.commands = { commands: s.commands, skills: s.skills }; savePersisted(); }
  } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
    s.live = '';
    const u = m.message?.usage;
    if (u) s.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    for (const b of m.message?.content || []) if (b.type === 'text' && b.text && b.text.trim()) pushReply(s, b.text);
  } else if (m.type === 'result') {
    s.live = '';
    if (typeof m.total_cost_usd === 'number') s.cost = (s.costBase || 0) + m.total_cost_usd;
    const mu = m.modelUsage && Object.values(m.modelUsage)[0];
    if (mu?.contextWindow) s.ctxWindow = mu.contextWindow;
    // The turn is over: show the bot at rest even when the stop hook did not run (a stopped turn, a spending limit).
    dropPending(s);
    if (s.status === 'working' || s.status === 'waiting') { s.status = 'idle'; s.tool = null; s.helpers = 0; }
    const sub = String(m.subtype || '');
    if (sub.startsWith('error_max_budget')) pushReply(s, `Stopped: this session reached its spending limit of $${s.budget}.`);
    else if (m.is_error && m.result && !s.interrupted) pushReply(s, 'Stopped with an error: ' + m.result);
    recordHistory(s);
    broadcast();
  }
}

function openHeadless({ cwd, name, prompt, worktree = null, budget = null, resume = null, scheduleId = null, model = null, prior = null }, baseArgs) {
  const officeId = 'o' + crypto.randomBytes(4).toString('hex');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...baseArgs];
  if (resume) args.push('--resume', resume);
  if (budget) args.push('--max-budget-usd', String(budget));
  const s = newSession({ uid: officeId, officeId, name, cwd, launched: true, headless: true, status: 'starting', worktree, budget, scheduleId, model,
    commands: persisted.commands?.commands || [], skills: persisted.commands?.skills || [] });
  if (prior) { s.replies = prior.replies || []; s.replySeq = s.replies.reduce((n, r) => Math.max(n, r.id || 0), 0); s.costBase = prior.cost || 0; s.cost = prior.cost || null; s.turns = prior.turns || 0; s.prompt = prior.prompt || ''; }
  const child = spawn('claude', args, {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OFFICE_ID: officeId },
  });
  procs.set(officeId, child);
  s.pid = child.pid;
  let buf = '', err = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onStream(s, line); }
  });
  child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
  child.stdin.on('error', () => {});
  child.on('error', (e) => { pushReply(s, 'Could not start Claude Code: ' + e.message); endSession(s, 'could not start'); broadcast(); });
  child.on('exit', (code) => {
    procs.delete(officeId);
    if (s.status !== 'ended') {
      if (code && !s.sid) pushReply(s, 'Claude Code stopped before it started: ' + (clip(err.trim(), 400) || 'exit code ' + code));
      endSession(s, code ? `exited (${code})` : 'finished');
    }
    broadcast();
  });
  if (!worktree) rememberDir(cwd); // a worktree folder is an implementation detail, not a place to start from
  addFeed(s, 'start', resume ? 'reopened in the office' : worktree ? `started in the office on branch ${worktree.branch}` : 'started in the office');
  if (prompt) { s.prompt = prompt; writeUser(s, prompt); addFeed(s, 'prompt', clip(prompt, 100)); }
  broadcast();
  return s.uid;
}

// ---------- open / close ----------
async function openSession(opts) {
  if (process.platform !== 'win32') throw httpError(501, 'Opening sessions is only implemented for Windows.');
  const cwd = String(opts.cwd || '').trim();
  let stat;
  try { stat = fs.statSync(cwd); } catch { /* handled below */ }
  if (!stat || !stat.isDirectory()) throw httpError(400, `Folder not found: ${cwd || '(empty)'}`);

  const args = ['--settings', activeHooksFile(), '--mcp-config', MCP_FILE];
  if (opts.model) {
    if (!MODEL_RE.test(opts.model)) throw httpError(400, 'Unknown model.');
    args.push('--model', opts.model);
  }
  if (opts.permissionMode) {
    if (!MODES.has(opts.permissionMode)) throw httpError(400, 'Unknown permission mode.');
    args.push('--permission-mode', opts.permissionMode);
  }
  const prompt = String(opts.prompt || '').slice(0, 8000);
  const termArgs = prompt ? [...args, prompt] : args;

  const name = String(opts.name || '').trim().slice(0, 40) || basename(cwd) || 'session';
  if (opts.where !== 'terminal') {
    let workdir = cwd, worktree = null;
    if (opts.isolation === 'worktree') {
      const wt = await git.createWorktree(cwd, name);
      workdir = wt.path; worktree = { root: wt.root, branch: wt.branch, repo: wt.repo };
    }
    if (worktree) rememberDir(cwd);
    const budget = Number(opts.maxBudget) > 0 ? Math.min(Number(opts.maxBudget), 1000) : null;
    return openHeadless({ cwd: workdir, name, prompt, worktree, budget, scheduleId: opts.scheduleId || null, model: opts.model || null }, args);
  }
  const officeId = 'o' + crypto.randomBytes(4).toString('hex');
  const title = ('Office - ' + name).replace(/[^\w .-]/g, '');
  const s = newSession({ uid: officeId, officeId, name, cwd, launched: true, status: 'starting', model: opts.model || null });
  // `start /wait` gives the session its own console window while cmd.exe stays alive as the
  // process-tree root, so closing = taskkill /T on that one pid.
  // The quoted "Office" is the window title; unquoted, `start` would try to run a program named Office.
  const launcher = path.join(ROOT, 'launch.ps1');
  const child = spawn('cmd.exe', [
    '/d', '/s', '/c', `start "Office" /wait powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "${launcher}"`,
  ], {
    windowsVerbatimArguments: true,
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, OFFICE_ID: officeId, OFFICE_ARGS: JSON.stringify(termArgs), OFFICE_TITLE: title },
  });
  s.pid = child.pid;
  child.on('error', (e) => { addFeed(s, 'end', `could not start: ${e.message}`); endSession(s, 'could not start'); broadcast(); });
  child.on('exit', () => { endSession(s, 'window closed'); broadcast(); });
  child.unref();
  rememberDir(cwd);
  addFeed(s, 'start', 'opened a new window');
  broadcast();
  return s.uid;
}

async function reopenSession(uid) {
  const rec = history.find((h) => h.uid === uid);
  if (!rec) throw httpError(404, 'That past session is gone.');
  if (!fs.existsSync(rec.cwd)) throw httpError(409, `Its folder is gone: ${rec.cwd}. It may have been a removed worktree.`);
  const args = ['--settings', activeHooksFile(), '--mcp-config', MCP_FILE];
  if (rec.model) args.push('--model', rec.model);
  const id = openHeadless({ cwd: rec.cwd, name: rec.name, prompt: '', worktree: rec.worktree, budget: rec.budget, resume: rec.sid, model: rec.model, prior: rec }, args);
  history = history.filter((h) => h.uid !== uid);
  saveHistory();
  return id;
}

function closeSession(uid) {
  const s = sessions.get(uid);
  if (!s) throw httpError(404, 'No such session.');
  if (s.status === 'ended') { sessions.delete(uid); broadcast(); return; }
  if (!s.pid || s.pid === process.pid) throw httpError(409, 'This session has no known process to close. Close it in its own terminal.');
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true }, (err, _o, stderr) => {
      if (err && !/not found|no running instance/i.test(String(stderr))) {
        return reject(httpError(500, `Could not close it: ${String(stderr || err.message).trim()}`));
      }
      endSession(s, 'closed from the office');
      broadcast();
      resolve();
    });
  });
}

// ---------- HTTP hook probe ----------
// Runs one tiny Haiku session with the HTTP hook settings and checks the events arrived over HTTP.
async function probeHttp() {
  const need = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
  probeSeen = new Set();
  const run = await new Promise((resolve) => {
    execFile('claude', ['--settings', HOOKS_HTTP_FILE, '--model', 'haiku', '--permission-mode', 'default', '-p', 'Run the bash command: echo http-probe-ok  Then say done.'],
      { cwd: ROOT, env: { ...process.env, OFFICE_ID: 'probe' }, timeout: 120000, windowsHide: true },
      (err, out) => resolve({ err: err && err.message, out: String(out || '').slice(0, 200) }));
  });
  const seen = [...probeSeen];
  probeSeen = null;
  for (const [uid, s] of sessions) if (s.officeId === 'probe') sessions.delete(uid);
  const missing = need.filter((e) => !seen.includes(e));
  const ok = !run.err && !missing.length;
  persisted.httpHooks = { ok, version: CLAUDE_VERSION, at: new Date().toISOString(), seen, missing };
  savePersisted();
  if (!ok) hooksMode = 'command';
  else if (process.env.OFFICE_HOOKS !== 'command') hooksMode = 'http';
  broadcast();
  return { ok, mode: hooksMode, version: CLAUDE_VERSION, seen, missing, error: run.err || null };
}

// ---------- templates and schedules ----------
persisted.templates = persisted.templates || [];
persisted.schedules = persisted.schedules || [];
const newId = () => crypto.randomBytes(4).toString('hex');

function saveTemplate(t) {
  const name = String(t.name || '').trim().slice(0, 60), text = String(t.text || '').trim().slice(0, 8000);
  if (!name || !text) throw httpError(400, 'A template needs a name and some text.');
  const i = persisted.templates.findIndex((x) => x.id === t.id);
  const rec = { id: i >= 0 ? t.id : newId(), name, text };
  if (i >= 0) persisted.templates[i] = rec; else persisted.templates.push(rec);
  savePersisted();
  return rec;
}

function saveSchedule(x) {
  const name = String(x.name || '').trim().slice(0, 60), prompt = String(x.prompt || '').trim().slice(0, 8000), cwd = String(x.cwd || '').trim();
  if (!name || !prompt || !cwd) throw httpError(400, 'A schedule needs a name, a folder and a prompt.');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { throw httpError(400, `Folder not found: ${cwd}`); }
  const kind = x.kind === 'daily' ? 'daily' : 'every';
  const every = Math.max(5, Math.min(7 * 24 * 60, Number(x.every) || 60));
  const at = /^\d{1,2}:\d{2}$/.test(String(x.at)) ? String(x.at) : '09:00';
  const rec = {
    id: persisted.schedules.find((y) => y.id === x.id)?.id || newId(), name, prompt, cwd, kind, every, at,
    model: MODEL_RE.test(String(x.model || '')) ? x.model : '', permissionMode: MODES.has(x.permissionMode) ? x.permissionMode : '',
    isolation: x.isolation === 'worktree' ? 'worktree' : 'same', maxBudget: Number(x.maxBudget) > 0 ? Number(x.maxBudget) : 0,
    enabled: x.enabled !== false, lastRun: Date.now(),
  };
  const i = persisted.schedules.findIndex((y) => y.id === rec.id);
  if (i >= 0) { rec.lastRun = persisted.schedules[i].lastRun; persisted.schedules[i] = rec; } else persisted.schedules.push(rec);
  savePersisted();
  return rec;
}

function dueNow(sch, now) {
  if (!sch.enabled) return false;
  if (sch.kind === 'every') return now - sch.lastRun >= sch.every * 60000;
  const d = new Date(now), [h, m] = sch.at.split(':').map(Number);
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return now >= slot && sch.lastRun < slot && now - slot < 10 * 60000; // a missed slot is skipped, not made up
}

async function runSchedule(sch) {
  sch.lastRun = Date.now();
  savePersisted();
  for (const s of sessions.values()) if (s.scheduleId === sch.id && s.status !== 'ended') return null; // still busy with the last run
  try {
    const uid = await openSession({ cwd: sch.cwd, name: sch.name, prompt: sch.prompt, model: sch.model, permissionMode: sch.permissionMode, isolation: sch.isolation, maxBudget: sch.maxBudget, scheduleId: sch.id, where: 'office' });
    return uid;
  } catch (e) {
    feed.push({ t: Date.now(), uid: 'schedule', name: sch.name, kind: 'end', text: 'schedule could not start: ' + e.message });
    broadcast();
    return null;
  }
}
setInterval(() => { const now = Date.now(); for (const sch of persisted.schedules) if (dueNow(sch, now)) void runSchedule(sch); }, 30000).unref();

// ---------- past sessions: list and search ----------
function pastSummary(h) {
  const last = h.replies?.length ? h.replies[h.replies.length - 1].text : '';
  return { uid: h.uid, name: h.name, cwd: h.cwd, model: h.model, cost: h.cost, turns: h.turns, startedAt: h.startedAt, endedAt: h.endedAt,
    branch: h.worktree?.branch || null, worktreeRoot: h.worktree?.root || null, last: clip(String(last).replace(/\s+/g, ' '), 140), firstAsk: clip(h.prompt || '', 140) };
}
function search(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const out = [];
  const scan = (rec, where) => {
    const hay = [[rec.name, 'name'], [rec.cwd, 'folder'], [rec.prompt, 'ask'], ...(rec.replies || []).map((r) => [r.text, 'reply'])];
    for (const [text, kind] of hay) {
      const t = String(text || ''), i = t.toLowerCase().indexOf(needle);
      if (i < 0) continue;
      out.push({ uid: rec.uid, name: rec.name, where, kind, snippet: clip(t.slice(Math.max(0, i - 50), i + 110).replace(/\s+/g, ' '), 160), t: rec.endedAt || rec.startedAt });
      return;
    }
  };
  for (const h of history) scan(h, 'past');
  for (const s of sessions.values()) if (s.headless) scan(s, 'live');
  return out.slice(0, 30);
}
// A session's folder, whether it is running or in the past list.
const folderOf = (uid) => { const s = sessions.get(uid) || history.find((h) => h.uid === uid); if (!s) throw httpError(404, 'No such session.'); return s; };

// ---------- housekeeping ----------
setInterval(() => {
  let changed = false;
  for (const [uid, s] of sessions) {
    if (s.status === 'ended') {
      if (Date.now() - s.endedAt > 120_000) { sessions.delete(uid); changed = true; }
      continue;
    }
    if (s.pid) {
      try { process.kill(s.pid, 0); } catch (e) {
        if (e.code !== 'EPERM') { endSession(s, 'terminal went away'); changed = true; }
      }
    }
  }
  if (changed) broadcast();
}, 5000).unref();

// ---------- http ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 12582912) { reject(httpError(413, 'Too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(httpError(400, 'Bad JSON.')); } });
    req.on('error', reject);
  });
}

const snapshot = () => ({
  sessions: [...sessions.values()].map(({ ...s }) => s),
  feed: feed.slice(-80),
  now: Date.now(),
});
let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(data);
  }, 40);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();

// Static files: the page, its scripts, and the Agent Office DS runtime (tokens, bundle, three.js).
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const STATIC_FILES = new Map([
  ['/office.js', 'public/office.js'], ['/office.css', 'public/office.css'], ['/chat-extras.js', 'public/chat-extras.js'], ['/adapter.js', 'public/adapter.js'], ['/tokens.css', 'tokens.css'],
  ['/components/bundle.css', 'components/bundle.css'], ['/components/bundle.js', 'components/bundle.js'],
  ['/components/lib/three.min.js', 'components/lib/three.min.js'],
  ['/components/lib/three-orbit-controls.js', 'components/lib/three-orbit-controls.js'],
  ['/components/lib/three-postprocessing.js', 'components/lib/three-postprocessing.js'],
]);

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const rel = STATIC_FILES.get(url.pathname);
      return send(res, 200, fs.readFileSync(path.join(ROOT, rel)), MIME[path.extname(rel)] || 'application/octet-stream');
    }

    const tok = req.headers['x-office-token'] || url.searchParams.get('t');
    if (tok !== TOKEN) return send(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return send(res, 200, {
        port: PORT, hooksFile: activeHooksFile(), recent: persisted.recent, home: os.homedir(),
        settingsSnippet: JSON.stringify(hooksMode === 'http' ? httpSettings : commandSettings, null, 2),
        launchCommand: `claude --settings "${activeHooksFile()}" --mcp-config "${MCP_FILE}"`,
        hooksMode, claudeVersion: CLAUDE_VERSION, templates: persisted.templates, schedules: persisted.schedules,
      });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });

    const body = await readBody(req);
    if (url.pathname === '/hook') {
      const out = onHook(body);
      if (body.hook_ppid && !body.office_id) {
        const s = findSession(body);
        if (s && !s.pid) { const pid = await walkToClaude(body.hook_ppid); if (pid) { s.pid = pid; broadcast(); } }
      }
      return send(res, 200, out || { ok: true });
    }
    if (url.pathname === '/hook/http') {
      const p = slim(body, String(req.headers['x-office-id'] || '').trim() || null);
      if (probeSeen && p.office_id === 'probe') probeSeen.add(p.hook_event_name);
      if (p.hook_event_name === 'PermissionRequest') return onPermission(p, res);
      const out = onHook(p);
      return send(res, 200, out ? JSON.stringify(out) : '');
    }
    if (url.pathname === '/api/probe-http') return send(res, 200, await probeHttp());
    if (url.pathname === '/hook/permission') return onPermission(body, res);
    if (url.pathname === '/mcp/inbox') return onMcpInbox(body, res);
    if (url.pathname === '/mcp/ask') return onMcpAsk(body, res);
    if (url.pathname === '/api/message') return send(res, 200, { ok: true, ...sendMessage(String(body.uid), body.text, Array.isArray(body.attachments) ? body.attachments : []) });
    if (url.pathname === '/api/answer') { answer(String(body.id), body.allow === true, body.always === true); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/open') return send(res, 200, { uid: await openSession(body) });
    if (url.pathname === '/api/reopen') return send(res, 200, { uid: await reopenSession(String(body.uid)) });
    if (url.pathname === '/api/interrupt') { doControl(String(body.uid), 'interrupt'); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/control') { doControl(String(body.uid), String(body.action), body.value); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/history') return send(res, 200, { sessions: history.map(pastSummary) });
    if (url.pathname === '/api/history/forget') { history = history.filter((h) => h.uid !== String(body.uid)); saveHistory(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/search') return send(res, 200, { results: search(body.q) });
    if (url.pathname === '/api/changes') { const r = folderOf(String(body.uid)); return send(res, 200, { ...(await git.changes(r.cwd)), worktree: r.worktree || null, name: r.name }); }
    if (url.pathname === '/api/worktree/remove') {
      const r = folderOf(String(body.uid));
      if (sessions.get(r.uid) && sessions.get(r.uid).status !== 'ended') throw httpError(409, 'Close the session first.');
      const out = await git.removeWorktree(r.worktree || {}, body.force === true);
      const h = history.find((x) => x.uid === r.uid); if (h) { const repo = h.worktree?.repo; h.worktree = null; if (repo) h.cwd = repo; saveHistory(); }
      return send(res, 200, out);
    }
    if (url.pathname === '/api/pr') {
      const r = folderOf(String(body.uid));
      if (!r.worktree) throw httpError(409, 'Pull requests need a worktree session, so the changes stay off your main branch.');
      return send(res, 200, await git.createPr(r.cwd, r.worktree.branch, r.name));
    }
    if (url.pathname === '/api/template/save') return send(res, 200, saveTemplate(body));
    if (url.pathname === '/api/template/delete') { persisted.templates = persisted.templates.filter((t) => t.id !== String(body.id)); savePersisted(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/schedule/save') return send(res, 200, saveSchedule(body));
    if (url.pathname === '/api/schedule/delete') { persisted.schedules = persisted.schedules.filter((t) => t.id !== String(body.id)); savePersisted(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/schedule/run') { const sch = persisted.schedules.find((t) => t.id === String(body.id)); if (!sch) throw httpError(404, 'No such schedule.'); return send(res, 200, { uid: await runSchedule(sch) }); }
    if (url.pathname === '/api/close') { await closeSession(String(body.uid)); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Agent Office is already running on port ${PORT}: http://localhost:${PORT}\nNothing was changed. Stop the other copy first, or set OFFICE_PORT.`);
  } else console.error(e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Written only once we own the port, so a second copy can never invalidate a running office's token.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: TOKEN, port: PORT }));
  console.log(`Agent Office is open: http://localhost:${PORT}`);
  console.log(`Hooks: ${hooksMode} (Claude Code ${CLAUDE_VERSION}). For outside sessions: claude --settings "${activeHooksFile()}" --mcp-config "${MCP_FILE}"`);
});
