#!/usr/bin/env node
// Claude Code hook -> Agent Office. Reads the hook payload on stdin, trims it,
// and posts it to the local office server. Never blocks or fails a session:
// every error path exits 0 with no output.
// First statement: Windows never looks for a program in the current folder (git.mjs resolveExe has the reason).
process.env.NoDefaultCurrentDirectoryInExePath = '1';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slimPayload } from './payload.mjs';
import { officeFiles, portArg } from './files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

// The office's port is the first argument when it is not the default (files.mjs). Its token file names the port.
const port = portArg(process.argv[2]);
if (!port) process.exit(0);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(officeFiles(here, port).token, 'utf8')); } catch { process.exit(0); }
// With a port argument, the token file must name that port. A file that names another port is not this office's: say nothing.
if (process.argv[2] !== undefined && process.argv[2] !== '' && cfg.port !== port) process.exit(0);

// Same trimmed fields as HTTP hooks (payload.mjs). The server's PowerShell helper walks up from
// hook_ppid to find the claude process.
const body = {
  ...slimPayload(payload, process.env.OFFICE_ID || null),
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
