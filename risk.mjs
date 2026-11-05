// How risky a tool call is, for the Approve card and the "Approve all low-risk" action, and which row of the Security
// room grid it falls under (its action kind, #70).
// An allowlist: only reads and edits inside the session's root folder are low, and never for a secret-looking
// file or a settings file that runs code (.git, .claude, .mcp.json, .vscode, .idea). Every agent provider uses
// this one rule, so a local model or a Copilot session is rated like Claude Code.
// One classifier (rate) gives both answers, so the grid and riskOf never disagree: the rows read-inside and
// edit-inside are exactly the reads and edits that are low.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']); // read-only tools that take a path
const NO_FILES = new Set(['TodoWrite', 'WebSearch']);                  // read-only tools that touch no file
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);

// Commands that are high risk, in sh and PowerShell. A command that matches none is medium.
const DANGER = [
  // Deletes, moves, process stops, policy changes, downloads, file writes, and links.
  /(^|[\s;|&(])(rm|sudo|del|erase|rd|rmdir|format|chmod|chown|kill|pkill|taskkill|drop|truncate|dd|mkfs|shutdown|reboot|Remove-Item|ri|Move-Item|mv|Stop-Process|spps|Set-ExecutionPolicy|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Invoke-Expression|iex|curl|wget|Start-Process|Format-(Volume|Disk|Partition)|Clear-Content|Set-Content|Out-File|reg|schtasks|netsh|mklink|ln|fsutil)(?=$|[\s;|&)])/i,
  // A junction or a symbolic link makes a folder outside the session folder look like it is inside
  // (New-Item -ItemType Junction or SymbolicLink, [IO.File]::CreateSymbolicLink, fsutil hardlink).
  /symboliclink|hardlink|junction/i,
  // git: pushes and history rewrites, and config (git config, git -c), which can make any later git
  // command run a program (core.fsmonitor, diff.external, core.hooksPath). Global options may come first.
  /\bgit(\.exe)?(\s+(-C|--git-dir|--work-tree)(\s+|=)\S+|\s+--?[a-z][\w-]*(=\S*)?)*?\s+(--config-env\b|config\b|push\b|reset\b|clean\b|checkout\s+--|branch\s+-D\b|rebase\b|filter-branch\b)/i,
  // git -c is case-sensitive (git -C is the folder option), so it has no i flag.
  /\b[Gg][Ii][Tt](\.[Ee][Xx][Ee])?(\s+(-C|--git-dir|--work-tree)(\s+|=)\S+|\s+--?[a-zA-Z][\w-]*(=\S*)?)*?\s+-c\b/,
  // A second shell that hides the words above: cmd /c or /k (^ escapes), encoded PowerShell (-e, -ec, -enc...).
  /\bcmd(\.exe)?(\s*\/{1,2}[a-z](:\w+)?)*?\s*\/{1,2}[ck]\b/i,
  /\b(powershell|pwsh)(\.exe)?\b[^\n;|&]*?\s[-\/]{1,2}(e|ec|en\w*)(?=[\s:'"]|$)/i,
  // A redirect that overwrites a file.
  />\s*[^\s&|]/,
];

// Path parts (folders or files) whose content a program runs without asking: git config, hooks and the
// worktree link file; Claude Code settings, hooks, commands and skills; MCP server lists; editor tasks and
// run settings; ssh config; the office's own hook and MCP files, with or without a port in the name (files.mjs). An
// edit to one of them is high. The Start Menu folder holds the Startup folder (Programs\Startup): Windows runs what is
// in it at sign-in.
const RUNS = new Set(['.git', '.claude', '.vscode', '.idea', '.ssh', '.mcp.json', '.claude.json', '.gitconfig', 'start menu']);
// File names that run code: the office's hook and MCP files (any port), PowerShell profiles (profile.ps1,
// Microsoft.PowerShell_profile.ps1, Microsoft.VSCode_profile.ps1) and sh, bash, zsh, csh and ksh profiles.
const RUNS_FILE = /^(office-(hooks|hooks-http|mcp)(-\d+)?\.json|(microsoft\.[\w.]+_)?profile\.ps1|\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc))$/;
// Credential folders and secret-looking file names. A read outside the root is high, inside it is medium.
// .office-token[-<port>] and office-hooks-http[-<port>].json hold an office's agent token (files.mjs);
// office-page-<port>.json holds the office's page token for the user's own tools (auth.mjs pageFile).
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);
const SECRET_FILE = /^(\.env.*|.*\.(pem|key|pfx|p12)|id_(rsa|dsa|ecdsa|ed25519).*|\.credentials\.json|\.office-token(-\d+)?|office-hooks-http(-\d+)?\.json|office-page-\d+\.json|\.npmrc|\.netrc|_netrc|\.git-credentials|\.pypirc)$/;

const WIN = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(String(p)); return WIN ? r.toLowerCase() : r; };
const parts = (p) => String(p).split(/[\\/]+/).filter(Boolean);
// A part as Windows reads it: any case, no :stream suffix (.git::$INDEX_ALLOCATION), no trailing dots or spaces.
const forms = (part) => {
  const n = part.toLowerCase();
  const w = n.replace(/:.*$/, '').replace(/[. ]+$/, '');
  return w && w !== n ? [n, w] : [n];
};
// What a list of path parts names: a secret, or settings that run code.
function kinds(list) {
  let secret = false, runs = false;
  for (const part of list) for (const n of forms(part)) {
    if (SECRET_DIRS.has(n) || SECRET_FILE.test(n)) secret = true;
    if (RUNS.has(n) || RUNS_FILE.test(n)) runs = true;
  }
  return { secret, runs };
}

/**
 * True when one path part (a folder or file name) is a secret or settings that run code: .env, .ssh, *.pem, .git,
 * .claude and the rest of the lists above. The local-model Grep skips these, so a search never reads them.
 */
export function isProtectedPart(name) {
  const k = kinds([String(name ?? '')]);
  return k.secret || k.runs;
}

/**
 * True when target is the folder root or inside it (case-insensitive on Windows). It compares the path text
 * only and follows no link: a junction inside the folder that leads out still counts as inside. Use
 * realInside() where a link must not lead out. Paths in another form (\\?\, UNC, 8.3, trailing dots) are
 * outside, the safe direction.
 */
export function inside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The path with every link and short name resolved: the real path of the nearest part that exists, plus the
 * rest. null when a link leads nowhere (it could be made to lead out later) or a part cannot be read.
 */
function realPath(p) {
  let probe = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try { fs.lstatSync(probe); break; } // lstat: a broken link exists too, and must not be skipped
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null; }
    const up = path.dirname(probe);
    if (up === probe || rest.length > 200) return null;
    rest.unshift(path.basename(probe));
    probe = up;
  }
  try { return path.join(fs.realpathSync.native(probe), ...rest); } catch { return null; }
}

// Where an absolute path points: inside the root as text and after links, and its real path.
function resolveIn(root, abs) {
  const real = realPath(abs);
  const realRoot = root ? realPath(root) : null;
  return { real, realRoot, in: !!root && inside(root, abs) && !!real && !!realRoot && inside(realRoot, real) };
}

// The office's own saved state (#70): state.json holds the Security room rules and the schedules (prompts the office runs),
// history.json the past sessions; an office on another port has state-<port>.json and history-<port>.json (files.mjs).
// A change to them changes what the office does at its next start, so they are settings that run code. Matched in the
// office folder (this file's folder) only, not by name alone: another project's state.json is a plain file.
const OFFICE_DIR = norm(path.dirname(fileURLToPath(import.meta.url)));
const OWN_STATE = /^(state|history)(-\d+)?\.json$/i;
const ownState = (p) => !!p && path.dirname(norm(p)) === OFFICE_DIR && OWN_STATE.test(path.basename(String(p)));
let realHome;   // the real path of the home folder, looked up once
/**
 * True when a root holds the user's own settings, so nothing in it counts as inside: a drive root, the home folder or a
 * folder above it, as text or after links (a terminal session started in the home folder, #70). Writes there reach the
 * Startup folder, profiles and app settings, which no list of names covers.
 */
export function wideRoot(root) {
  if (!root) return false;
  const r = path.resolve(String(root));
  if (path.parse(r).root === r) return true;
  const home = os.homedir();
  if (!home) return false;
  if (inside(r, home)) return true;
  if (realHome === undefined) realHome = realPath(home);
  const real = realPath(r);
  return !!(real && realHome && (inside(real, realHome) || path.parse(real).root === real));
}

/**
 * True when target is inside root both as text (inside()) and after every junction, symbolic link and short
 * name is resolved (fs.realpathSync.native on the target, or its nearest existing parent, and on the root).
 * A link that leads out, a broken link and a path that cannot be read are not inside.
 */
export function realInside(root, target) {
  if (!root || !target || !path.isAbsolute(String(target))) return false;
  return resolveIn(root, path.resolve(String(target))).in;
}

/**
 * Where a tool's path points, for the rating: inside the root, and whether it names a secret or settings
 * that run code. Inside the root only the parts below the root count (a root may be in .claude/worktrees);
 * outside it the whole path counts. The text path and the real path are both checked, so a link or a short
 * name cannot hide a .git folder. A relative path is read against the root, never the server's folder.
 */
function place(root, p) {
  let s = String(p ?? '');
  if (!s || s.includes('\0')) return { inside: false, secret: false, runs: false };
  if (/^~(?=[\\/]|$)/.test(s)) s = path.join(os.homedir(), s.slice(1));
  if (!path.isAbsolute(s) && !root) return { inside: false, ...kinds(parts(s)) };
  const abs = path.resolve(root || '', s);
  const r = resolveIn(root, abs), real = r.real, realRoot = r.realRoot;
  const isIn = r.in && !wideRoot(root); // a wide root (home, a drive) has no inside
  const whole = [...parts(abs), ...(real ? parts(real) : [])];
  const k = kinds(isIn ? [...parts(path.relative(norm(root), norm(abs))), ...parts(path.relative(norm(realRoot), norm(real)))] : whole);
  // A .git folder anywhere on the path holds git's config and hooks, and the Start Menu holds the Startup folder, also when
  // the root is below them.
  if (!k.runs && whole.some((x) => forms(x).some((n) => n === '.git' || n === 'start menu'))) k.runs = true;
  if (ownState(abs) || ownState(real)) k.runs = true;
  return { inside: isIn, ...k };
}

// {a,b} alternatives of one glob part (a few levels, at most 64).
function braces(s, depth = 0) {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m || depth > 4) return [s];
  return m[1].split(',').flatMap((a) => braces(s.slice(0, m.index) + a + s.slice(m.index + m[0].length), depth + 1)).slice(0, 64);
}
// What the parts of a glob name. '.env*' names .env, '*.{pem,key}' names .pem and .key, and a wildcard
// on a dot name ('.*', '.e?v') can match .env or .git, so it counts as settings.
function globKinds(list) {
  const names = [];
  let dot = false;
  for (const part of list) for (const alt of braces(part)) {
    const cls = alt.replace(/\[[!^]?([^\]]*)\]/g, (m, c) => c.charAt(0) || '?');
    if (/[*?[]/.test(alt) && cls.startsWith('.')) dot = true;
    names.push(cls.replace(/[*?]/g, ''));
  }
  const k = kinds(names);
  return { secret: k.secret, runs: k.runs || dot };
}

// A rating: the risk and the action kind (a row of the Security room grid; 'other' has no row).
const R = (risk, action) => ({ risk, action });
// Where a read or an edit points, as a row: a secret wins over settings, settings over inside or outside.
const fileAction = (secret, runs, isIn, inRow) => (secret ? 'secrets' : runs ? 'settings' : isIn ? inRow : 'files-outside');

// Read, Grep, Glob, LS, NotebookRead: low only inside the root, and never for a secret or settings.
function readRisk(name, a, root) {
  const file = name === 'Read' ? a.file_path : name === 'NotebookRead' ? a.notebook_path || a.file_path : a.path;
  if (!file && (name === 'Read' || name === 'NotebookRead')) return R('medium', 'files-outside');
  let base = file || root;
  let g = { secret: false, runs: false };
  const glob = name === 'Glob' ? a.pattern : name === 'Grep' ? a.glob : null;
  if (glob) {
    const s = String(glob);
    if (parts(s).some((x) => forms(x).includes('..'))) return R('medium', 'files-outside'); // a glob that climbs out of its folder
    if (path.isAbsolute(s)) {
      // An absolute glob searches below its folder part (up to the last slash before a wildcard), not below path.
      const w = s.search(/[*?[\]{}]/);
      const cut = w < 0 ? s.length : Math.max(s.lastIndexOf('/', w), s.lastIndexOf('\\', w)) + 1;
      base = s.slice(0, cut);
      g = globKinds(parts(s.slice(cut)));
    } else g = globKinds(parts(s));
  }
  if (!base) return R('medium', 'files-outside');
  const w = place(root, base), secret = w.secret || g.secret, runs = w.runs || g.runs;
  const action = fileAction(secret, runs, w.inside, 'read-inside');
  if (!w.inside) return R(secret ? 'high' : 'medium', action);
  return R(secret || runs ? 'medium' : 'low', action);
}

// Edit, Write, MultiEdit, NotebookEdit: settings that run code are high anywhere; low only inside the root.
function editRisk(file, root) {
  if (!file) return R('medium', 'files-outside');
  const w = place(root, file), action = fileAction(w.secret, w.runs, w.inside, 'edit-inside');
  if (w.runs) return R('high', action);
  return R(w.inside && !w.secret ? 'low' : 'medium', action);
}

/**
 * 'low' | 'medium' | 'high' for a tool call. root is the session's root folder: the worktree or the folder it
 * started in. Relative paths are read against it.
 */
export function riskOf(tool, input = {}, root = '') { return rate(tool, input, root).risk; }

/**
 * The action kind of a tool call: the row of the Security room grid it falls under (public/vocab.js has the names).
 * 'read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings' (settings files that run code),
 * 'secrets' (secret files), or 'other' (no row: the office's own tools, TodoWrite, Task and unknown tools).
 * The same root rule as riskOf: read-inside and edit-inside are exactly the low reads and edits.
 */
export function actionOf(tool, input = {}, root = '') { return rate(tool, input, root).action; }

// The office's own tools (office_inbox, office_ask, office_room, office_room_update) only talk to the office: no row.
const OFFICE_TOOL = /^mcp__office__/;
const WEB = new Set(['WebFetch', 'WebSearch']);
/** Both at once, for a caller that needs the two (the Security room verdict): { risk, action }. */
export function ratingOf(tool, input = {}, root = '') { return rate(tool, input, root); }

/** The rating of one tool call: { risk, action }. riskOf and actionOf read it. */
function rate(tool, input, root) {
  const name = String(tool || '');
  const a = input && typeof input === 'object' ? input : {};
  if (SHELLS.has(name)) { const cmd = String(a.command || ''); return R(DANGER.some((re) => re.test(cmd)) ? 'high' : 'medium', 'shell'); }
  if (NO_FILES.has(name)) return R('low', WEB.has(name) ? 'web' : 'other');
  if (READS.has(name)) return readRisk(name, a, root);
  if (EDITS.has(name)) return editRisk(a.file_path || a.notebook_path, root);
  // unknown tools, connector (MCP) tools, WebFetch, Task and the rest need a look
  if (WEB.has(name)) return R('medium', 'web');
  if (name.startsWith('mcp__') && !OFFICE_TOOL.test(name)) return R('medium', 'mcp');
  return R('medium', 'other');
}
