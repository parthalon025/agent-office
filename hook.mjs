#!/usr/bin/env node
// Claude Code hook -> Agent Office. Reads the hook payload on stdin, trims it,
// and posts it to the local office server. Never blocks or fails a session:
// every error path exits 0 with no output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(here, '.office-token'), 'utf8')); } catch { process.exit(0); }

const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);

// Keep only small, display-worthy fields. Never forward file contents or tool output.
const KEEP = ['command', 'file_path', 'pattern', 'url', 'description', 'path', 'query', 'subagent_type'];
const tool_input = {};
if (payload.tool_input && typeof payload.tool_input === 'object') {
  for (const k of KEEP) if (payload.tool_input[k] != null) tool_input[k] = clip(String(payload.tool_input[k]), 300);
}

const body = {
  hook_event_name: payload.hook_event_name,
  session_id: payload.session_id,
  cwd: payload.cwd,
  source: payload.source,
  model: payload.model,
  tool_name: payload.tool_name,
  tool_input,
  prompt: clip(payload.prompt, 400),
  message: clip(payload.message, 300),
  reason: payload.reason,
  office_id: process.env.OFFICE_ID || null,
  // A permission prompt needs the full input (to show the change) and Claude's "always allow" suggestions.
  ...(payload.hook_event_name === 'PermissionRequest' ? { full_input: payload.tool_input, permission_suggestions: payload.permission_suggestions } : {}),
  // The server's PowerShell helper walks up from this pid to find the claude process.
  hook_ppid: payload.hook_event_name === 'SessionStart' && !process.env.OFFICE_ID ? process.ppid : null,
};

// A permission prompt waits for the office to answer; every other event is fire-and-forget.
const ask = payload.hook_event_name === 'PermissionRequest';
// These three can carry a queued office message back to the session.
const reads = ['PostToolUse', 'UserPromptSubmit', 'Stop'].includes(payload.hook_event_name);
try {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/hook${ask ? '/permission' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-token': cfg.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ask ? 1000000 : 1500),
  });
  if (ask || reads) {
    const out = await res.text();
    // Only forward real hook output; {} or {"ok":true} means nothing to say.
    // For a permission prompt, empty means no decision: the terminal dialog decides.
    if (/"(hookSpecificOutput|decision)"/.test(out)) process.stdout.write(out);
  }
} catch { /* office not running or no answer: the terminal dialog decides */ }
process.exit(0);
