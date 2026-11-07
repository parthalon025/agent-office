#!/usr/bin/env node
// Agent Office server: the HTTP adapter of the office (office.mjs). It picks the port and the files, gates every request
// (auth.mjs), parses its body, hands it to the office core (office-core.mjs handle), writes the answer, and owns the start-up:
// listening, the files written once the port is ours (in this order), the launch link. Zero dependencies. Windows-first.
// First statement: Windows must never look for a program in a child's folder (Node reads this from the office's
// own environment at each spawn; children inherit it). The imports load first, but none starts a process.
// Every spawn also uses an absolute path from launch.resolveExe.
process.env.NoDefaultCurrentDirectoryInExePath = '1';
// Second: the cloud kinds read their settings, and cloudConfig takes the token settings out of process.env, so no process the
// office starts (a Claude Code session, a local agent's command) inherits them and no agent can print the token into the chat.
const CLOUD = { foundry: cloudConfig(process.env, 'OFFICE_FOUNDRY'), studio: cloudConfig(process.env, 'OFFICE_COPILOTSTUDIO'),
  cursor: cloudConfig(process.env, 'OFFICE_CURSORCLOUD'), gateway: cloudConfig(process.env, 'OFFICE_HERMESGATEWAY') };
import './node-check.mjs'; // first import: an old Node stops here with a clear message (#192)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process'; // execFileSync: icacls for writeSecret
import * as git from './git.mjs';
import * as launch from './launch.mjs';
import * as branchPort from './branch-port.mjs';
import { normPath } from './place.mjs';
import { cloudConfig } from './providers/cloud.mjs';
import { probeGateway } from './providers/openclaw.mjs';
import * as auth from './auth.mjs';
import { officeFiles, DEFAULT_PORT, OFFICE_ROOT } from './files.mjs';
import { createOffice } from './office.mjs';
import { httpError } from './office-core.mjs';

const ROOT = OFFICE_ROOT; // the repository root: runtime files, public/, components/, tokens.css, launch.ps1 (the code is in src/)
// OFFICE_PORT=branch: a port of this checkout's branch (branchPort.branchPorts), so each worktree has its own. The first free
// port of the name's fixed sequence is taken, and the start message says which one (#106). An office of this checkout on
// any port of the sequence stops the start, and so does a sequence with no free port (see server.on('error')).
// An office never takes another port than those of its sequence.
const stopAtStart = async (text) => { process.stderr.write(text + '\n', () => process.exit(1)); return await new Promise(() => {}); }; // wait for the exit
// Free: a short listen on the port that is closed again. The real listen below still decides (a port lost in between stops the office).
const portIsFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
// Own: the office on that port answers /api/info (with the page token of that port) with a hooks file directly in this
// folder. Not "inside": an office of a worktree below this folder (.claude/worktrees/...) is another checkout (#106).
async function portIsOwn(port) {
  try {
    const { token } = JSON.parse(fs.readFileSync(auth.pageFile(process.env, port), 'utf8'));
    const r = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { 'x-office-token': token }, signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return r.ok && typeof j.hooksFile === 'string' && normPath(path.dirname(j.hooksFile)) === normPath(ROOT);
  } catch { return false; }
}
const BRANCH_PORT = process.env.OFFICE_PORT === 'branch'
  ? await (async () => {
    let name;
    try {
      // A passing git failure (a time limit while the computer is busy) is not "outside git": locateOrKeep tries 3 times,
      // then answers KEEP, and the message says so. A lasting failure throws its own cause (startPlace, #132).
      const loc = await git.startPlace(ROOT);
      if (loc === git.KEEP) throw new Error('git did not give the branch of this folder (it timed out, or the repository has no commit yet). Start the office again.');
      name = branchPort.checkoutName(loc);
    } catch (e) { return stopAtStart(`Agent Office cannot pick a port for this folder: ${e.message}`); }
    const r = await branchPort.pickBranchPort(name, { isFree: portIsFree, isOwn: portIsOwn });
    if (r.own) return stopAtStart(`Agent Office is already open on port ${r.own} for branch "${name}", from this folder. Nothing was changed.\nOpen that office, or stop it by the process id that owns its port (netstat -ano | findstr :${r.own}), never by image name.`);
    if (!r.port) return stopAtStart(`Agent Office stopped: no port is free for branch "${name}".\nThese ports are busy: ${r.busy.join(', ')}. Nothing was changed, and no other port was tried.\nFind a process id with: netstat -ano | findstr :<port>. Stop that process by its id, never by image name.`);
    return { name, port: r.port, busy: r.busy };
  })()
  : null;
const PORT = BRANCH_PORT ? BRANCH_PORT.port : Number(process.env.OFFICE_PORT) || DEFAULT_PORT;
const HOST = '127.0.0.1';
// The files of this office in its folder (files.mjs): the plain names on the default port, names with the port in
// them on any other port, so a second office in this folder never rewrites the first one's files (#100). All of them
// are written only once this office owns its port (the listen callback).
const FILES = officeFiles(ROOT, PORT);
// Two tokens (auth.mjs has the rules). The agent token opens /hook* and /mcp/* only. It is kept in the token file,
// which hook.mjs and mcp.mjs read, and reused across restarts, so hooks of sessions that are already running keep
// working. The page token opens /events and /api/* only. It is new at each start and never written in this folder:
// the browser gets it as an HttpOnly cookie for a one-time launch code, the user's own tools read PAGE_FILE.
const TOKEN_FILE = FILES.token;
const readToken = (file, port) => {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (auth.AGENT_TOKEN_RE.test(c.token) && (port === undefined || c.port === port)) return c.token; } catch { /* none */ }
  return null;
};
// Before #100 an office on another port kept its token in .office-token too. When that file still names this port, its
// token is this office's, and the settings files that office made carry it: keep it, so those settings keep working.
// Only the token: state.json and history.json may belong to the office on the default port (its schedules, its notes).
const OLD_PLAIN_TOKEN = !readToken(TOKEN_FILE) && PORT !== DEFAULT_PORT ? readToken(officeFiles(ROOT).token, PORT) : null;
const AGENT_TOKEN = readToken(TOKEN_FILE) || OLD_PLAIN_TOKEN || auth.newAgentToken();
const PAGE_TOKEN = auth.newPageToken();
const PAGE_FILE = auth.pageFile(process.env, PORT);
const launchCodes = auth.createLaunchCodes();
// Remote access (#133, ADR 0008): off unless the four OFFICE_REMOTE_* settings are set, and only on the port they name.
// Access signs each request it lets through; the gate checks that token itself (auth.gateRequest). The server still
// listens on 127.0.0.1 only: cloudflared on this PC forwards to it.
const REMOTE = auth.remoteConfig(process.env, { port: PORT, branch: !!BRANCH_PORT });
// The remote page token is separate from PAGE_TOKEN and new at each start: a remote cookie opens nothing on the local host.
const REMOTE_PAGE_TOKEN = auth.newPageToken();
const REMOTE_SITE = REMOTE.on ? { config: REMOTE, keys: auth.createAccessKeys({ url: REMOTE.certsUrl }), pageToken: REMOTE_PAGE_TOKEN } : null;
// Files with a token, and settings files whose commands sessions run: only the user, SYSTEM and Administrators can
// read them (auth.writeOwnerOnly). icacls sets the ACL; Windows PowerShell reads it back by SID (auth.ACL_SCRIPT,
// about 0.2 s per file, only when a file is written).
function writeSecret(file, text) {
  const warning = auth.writeOwnerOnly(file, text, {
    fs,
    icacls: (args) => execFileSync(launch.resolveExe('icacls'), args, { cwd: launch.helperCwd(), windowsHide: true, stdio: 'pipe', timeout: 15000 }),
    readAcl: (f) => auth.parseAcl(execFileSync(launch.resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', auth.ACL_SCRIPT],
      { cwd: launch.helperCwd(), windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000, env: { ...process.env, AO_ACL_FILE: f } })),
  });
  if (warning) console.warn(`WARNING: ${warning}`);
}
const HOOKS_CMD_FILE = FILES.hooksCmd;
const HOOKS_HTTP_FILE = FILES.hooksHttp;
const MCP_FILE = FILES.mcp;

// The office: its state and handlers, behind its core (office.mjs). Nothing below it knows more than core.handle, core.groupOf and subscribe.
const office = createOffice({
  root: ROOT, port: PORT, files: FILES, agentToken: AGENT_TOKEN, pageToken: PAGE_TOKEN, launchCodes,
  remote: REMOTE, remotePageToken: REMOTE_PAGE_TOKEN, writeSecret, cloud: CLOUD,
});

// ---------- http ----------
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
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

const server = http.createServer(async (req, res) => {
  try {
    // On every response, held hook answers included (setHeader merges into a later writeHead).
    for (const [k, v] of Object.entries(auth.SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    // Host, Origin, Sec-Fetch-Site, JSON body and the token of the route group (auth.mjs checkRequest). The group of a path is the
    // route table's (core.groupOf); a path the table does not list keeps the prefix rule of auth.routeOf.
    const gate = await auth.gateRequest({ method: req.method, path: url.pathname, headers: req.headers },
      { port: PORT, agentToken: AGENT_TOKEN, pageToken: PAGE_TOKEN, groupOf: office.core.groupOf, remote: REMOTE_SITE });
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    // The JSON body of a POST on a token route (a remote sign-in carries none). The page holds no token: it gets the page cookie
    // from POST /launch with the code of its launch link.
    const body = req.method === 'POST' && gate.group !== 'public' && !(gate.group === 'launch' && gate.remote) ? await readBody(req) : undefined;
    // A client that goes away before its answer is sent (a hook cancelled, a plugin that stopped waiting) aborts the request.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const out = await office.core.handle({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body, remote: gate.remote, signal: gone.signal });
    if (res.destroyed) return;
    if (out.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const stop = out.stream((chunk) => res.write(chunk));
      req.on('close', stop);
      return;
    }
    if (out.bare) { res.writeHead(out.status); return res.end(); }
    return send(res, out.status, out.body, out.type, out.headers);
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

// Opens a launch link in the default browser (Windows only; OFFICE_OPEN=0 turns it off). The link is printed too.
// `start ""` needs the quoted empty title, or it would read the link as the title.
function openBrowser(link) {
  if (process.platform !== 'win32' || process.env.OFFICE_OPEN === '0') return;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#n=[0-9a-f]+$/.test(link)) return; // nothing that cmd could read as a command
  try {
    const c = spawn(launch.resolveExe('cmd.exe'), ['/d', '/s', '/c', `start "" "${link}"`], { cwd: launch.helperCwd(), windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* the printed link still works */ }
}
// A second copy asks the running office for a new launch link with the page token from PAGE_FILE.
async function linkFromRunningOffice() {
  try {
    const { token } = JSON.parse(fs.readFileSync(PAGE_FILE, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${PORT}/api/launch-link`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token }, body: '{}', signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return r.ok && typeof j.url === 'string' ? j.url : null;
  } catch { return null; }
}

// Exit only after the text is out: a console or pipe on Windows may write it later.
const sayAndExit = (stream, text, code) => stream.write(text + '\n', () => process.exit(code));
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') return sayAndExit(process.stderr, e.message, 1);
  // Branch mode picked a free port of the branch's sequence a moment ago: a busy port now means another copy (or program) took it. Say so and stop.
  if (BRANCH_PORT) return sayAndExit(process.stderr, `Agent Office stopped: port ${PORT} for branch "${BRANCH_PORT.name}" was free a moment ago and is busy now.\nAnother copy or program took it. Nothing was changed, and no other port was tried.\nFind its process id with: netstat -ano | findstr :${PORT}. Stop that process by its id, never by image name.`, 1);
  const link = await linkFromRunningOffice();
  if (!link) return sayAndExit(process.stderr, `Agent Office is already running on port ${PORT}, and it gave no launch link to this copy.\nNothing was changed. Stop the other copy first, or set OFFICE_PORT.`, 1);
  openBrowser(link);
  sayAndExit(process.stdout, `Agent Office is already running on port ${PORT}. Nothing was changed.\nOpen it with this link. The link works once, for 5 minutes:\n${link}`, 0);
});


server.listen(PORT, HOST, () => {
  // Written only once we own the port, so a second copy can never invalidate a running office's tokens or settings:
  // a copy on a busy port writes nothing, and an office on another port has its own files (files.mjs).
  office.own();   // the saved state and the past sessions write from now on; what they kept in memory is written whole below
  writeSecret(TOKEN_FILE, JSON.stringify({ token: AGENT_TOKEN, port: PORT }));
  writeSecret(HOOKS_CMD_FILE, JSON.stringify(office.settings.commandSettings, null, 2));
  writeSecret(HOOKS_HTTP_FILE, JSON.stringify(office.settings.httpSettings, null, 2));
  writeSecret(MCP_FILE, JSON.stringify(office.settings.mcpConfig, null, 2));
  // Saved state (schedule prompts, notes) and past sessions (replies) are limited too (#27 L10): once here, with
  // what this office loaded. savePersisted and saveHistory then write plainly, and a plain write keeps the ACL.
  // After listen, so a second copy that exits on EADDRINUSE never rewrites them.
  office.claim();
  office.resume(); // the sign-in entry, what an ungated agent's config carries, the Paperclip connection made before
  try {
    fs.mkdirSync(path.dirname(PAGE_FILE), { recursive: true });
    writeSecret(PAGE_FILE, JSON.stringify({ token: PAGE_TOKEN, port: PORT }));
    // Only after the own file is written, so a second copy that failed above never removes one. A clean exit removes it
    // (taskkill /F runs nothing, so the next start also sweeps the files of ports that nobody listens on, #126).
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(0));
    process.once('exit', () => auth.removeOwnPageFile(PAGE_FILE, PAGE_TOKEN));
    void auth.stalePageFiles({ file: PAGE_FILE, port: PORT, readdir: fs.promises.readdir, unlink: fs.promises.unlink,
      isListening: (port) => probeGateway({ port }) })
      .catch((e) => console.warn(`Could not sweep old page token files: ${e.message}`));
  } catch (e) { console.warn(`Could not save the page token for npm run probe and a second npm start: ${e.message}`); }
  const link = auth.launchUrl(PORT, launchCodes.mint());
  if (OLD_PLAIN_TOKEN) console.log(`Port ${PORT} reuses the agent token of the old .office-token, so settings made before this version keep working. This office keeps its own files from now on.`);
  if (BRANCH_PORT) console.log(`Branch "${BRANCH_PORT.name}" uses port ${PORT}.${BRANCH_PORT.busy.length ? ` Port ${BRANCH_PORT.busy.join(', ')} ${BRANCH_PORT.busy.length > 1 ? 'were' : 'was'} busy, so it took the next free port of its sequence.` : ''}`);
  if (REMOTE.on) console.log(`Remote access is on at https://${REMOTE.host} for ${REMOTE.emails.join(', ')}. The office still listens on 127.0.0.1 only. Agent routes refuse remote requests.`);
  else if (REMOTE.state === 'incomplete') console.log(`Remote access is off: ${REMOTE.reason}`);
  // Before the line below: tests and tools wait for that line, so everything the start says comes first.
  console.log(`Agent Office is open: ${link}\nThe link works once, for 5 minutes. A reload keeps working. For a new link, run npm start again.`);
  console.log(`Hooks: ${office.hooks.mode()} (Claude Code ${office.hooks.version}). For outside sessions: claude --settings "${office.hooks.file()}" --mcp-config "${MCP_FILE}"`);
  openBrowser(link);
});