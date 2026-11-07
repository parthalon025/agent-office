// How risky a tool call is, for the Approve card and the "Approve all low-risk" action, and which row of the Security
// room grid it falls under (its action kind, #70).
// An allowlist: only reads and edits inside the session's root folder are low, and never for a secret-looking
// file or a settings file that runs code (.git, .claude, .mcp.json, .vscode, .idea, Copilot CLI's .copilot, .agents and the
// RUNS_IN_GITHUB parts below .github), and never an edit of the office's own code, hook and settings files (ownCode, #120,
// whatever the root). Every agent provider uses
// this one rule, so a local model or a Copilot session is rated like Claude Code.
// One classifier (rate) gives both answers, so the grid and riskOf never disagree: the rows read-inside and
// edit-inside are exactly the reads and edits that are low.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFICE_ROOT } from './files.mjs';

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
// worktree link file; Claude Code settings, hooks, commands and skills; Hermes skills, memory and config (.hermes, #72); MCP
// server lists; editor tasks and run settings; ssh config; the office's own hook and MCP files, with or without a port in the
// name (files.mjs); Copilot CLI's home folder (.copilot: settings, hooks, MCP list, skills) and the .agents skills folder (#22).
// An edit to one of them is high. The Start Menu folder holds the Startup folder (Programs\Startup): Windows runs what is in
// it at sign-in.
const RUNS = new Set(['.git', '.claude', '.hermes', '.vscode', '.idea', '.ssh', '.mcp.json', '.claude.json', '.gitconfig', 'start menu', '.copilot', '.agents', '.gemini', '.kimi', '.opencode']);
// Parts that run code only directly below .github: Copilot CLI's repo hooks (shell commands that run without asking), repo
// settings (.github/copilot/settings*.json: hooks and allowedUrls), custom agents (they can start MCP servers), skills and the
// workspace MCP list (copilot help config, copilot mcp --help, copilot skill --help; 1.0.105). .github/workflows and
// .github/copilot-instructions.md are not on the list: they do not run on this PC.
const RUNS_IN_GITHUB = new Set(['hooks', 'copilot', 'agents', 'skills', 'mcp.json']);
// File names that run code: the office's hook and MCP files (any port), PowerShell profiles (profile.ps1,
// Microsoft.PowerShell_profile.ps1, Microsoft.VSCode_profile.ps1) and sh, bash, zsh, csh and ksh profiles.
const RUNS_FILE = /^(office-(hooks|hooks-http|mcp)(-\d+)?\.json|(microsoft\.[\w.]+_)?profile\.ps1|\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc))$/;
// The office's saved state (schedules: a prompt, a folder and a permission mode that run after a restart) and past
// sessions, with or without a port in the name (files.mjs). An edit is high (#109). Unlike RUNS, a read and a search
// treat them as ordinary files, because state.json and history.json are common names in other projects. (The office's
// own copies in its own folder are also RUNS: see ownState.)
const LATER_FILE = /^(state|history)(-\d+)?\.json$/;
// Credential folders and secret-looking file names. A read outside the root is high, inside it is medium.
// .office-token[-<port>] and office-hooks-http[-<port>].json hold an office's agent token (files.mjs);
// office-page-<port>.json holds the office's page token for the user's own tools (auth.mjs pageFile);
// paperclip-board-key[-<port>].json holds the board key of the Paperclip the office runs (paperclip-runtime.mjs, #193).
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);
const SECRET_FILE = /^(\.env.*|.*\.(pem|key|pfx|p12)|id_(rsa|dsa|ecdsa|ed25519).*|\.credentials\.json|\.office-token(-\d+)?|office-hooks-http(-\d+)?\.json|office-page-\d+\.json|paperclip-board-key(-\d+)?\.json|\.npmrc|\.netrc|_netrc|\.git-credentials|\.pypirc)$/;

const WIN = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(String(p)); return WIN ? r.toLowerCase() : r; };
const parts = (p) => String(p).split(/[\\/]+/).filter(Boolean);
// A path part as Windows opens it: no :stream suffix (.git::$INDEX_ALLOCATION), no trailing dots or spaces. One rule for the
// rating (forms) and for the file key (fileKey).
const winPart = (part) => part.replace(/:.*$/, '').replace(/[. ]+$/, '');
// A part as Windows reads it: any case, and its winPart form.
const forms = (part) => {
  const n = part.toLowerCase();
  const w = winPart(n);
  return w && w !== n ? [n, w] : [n];
};
// What a list of path parts names: a secret, settings that run code, or saved state that runs schedules later (edits only).
function kinds(list) {
  let secret = false, runs = false, later = false, github = false;
  for (const part of list) {
    const f = forms(part);
    for (const n of f) {
      if (SECRET_DIRS.has(n) || SECRET_FILE.test(n)) secret = true;
      if (RUNS.has(n) || RUNS_FILE.test(n) || (github && RUNS_IN_GITHUB.has(n))) runs = true;
      if (LATER_FILE.test(n)) later = true;
    }
    github = f.includes('.github'); // the part before the next one
  }
  return { secret, runs, later };
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
 * realInside() where a link must not lead out, or where one side can be an 8.3 short name. Paths in another
 * form (\\?\, UNC, 8.3, trailing dots) are outside, the safe direction.
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

/**
 * The path with each 8.3 short name spelled out (C:\Users\RUNNER~1 is C:\Users\runneradmin), and every link kept as it
 * is. git, os.homedir() and realpathSync.native give the long name, but a shell, TEMP or a script can give the short
 * one: on GitHub's Windows runner TEMP is C:\Users\RUNNER~1\AppData\Local\Temp. Windows only, and only for parts with
 * a '~' (each short name Windows makes has one), so other paths cost no file access. A part takes its long name only
 * when that name opens the same entry (same volume and file id). A link, a part that does not exist and a part that
 * cannot be read keep their spelling.
 */
function longPath(p) {
  const abs = path.resolve(String(p));
  if (!WIN || !abs.includes('~')) return abs;
  const { root } = path.parse(abs);
  let out = root;
  for (const part of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) out = path.join(out, part.includes('~') ? longName(out, part) : part);
  return out;
}
function longName(dir, part) {
  try {
    const here = path.join(dir, part), st = fs.lstatSync(here, { bigint: true });
    if (st.isSymbolicLink()) return part;
    const name = path.basename(fs.realpathSync.native(here));
    const same = fs.lstatSync(path.join(dir, name), { bigint: true });
    return same.ino === st.ino && same.dev === st.dev ? name : part;
  } catch { return part; }
}

// Where an absolute path points: inside the root as text (8.3 short names spelled out on both sides) and after links,
// and its real path. longRoot, longAbs: the two texts that were compared.
function resolveIn(root, abs) {
  const real = realPath(abs);
  const realRoot = root ? realPath(root) : null;
  const longRoot = root ? longPath(root) : null, longAbs = longPath(abs);
  return { real, realRoot, longRoot, longAbs, in: !!root && inside(longRoot, longAbs) && !!real && !!realRoot && inside(realRoot, real) };
}

// The office's own saved state (#70): state.json holds the Security room rules and the schedules (prompts the office runs),
// history.json the past sessions; an office on another port has state-<port>.json and history-<port>.json (files.mjs).
// A change to them changes what the office does at its next start, so they are settings that run code. Matched in the
// office folder (files.mjs OFFICE_ROOT, the repository root) only, not by name alone: another project's state.json is a plain file.
const OFFICE_DIR = norm(OFFICE_ROOT);
const OWN_STATE = /^(state|history)(-\d+)?\.json$/i;
const ownState = (p) => !!p && path.dirname(norm(p)) === OFFICE_DIR && OWN_STATE.test(path.basename(String(p)));
// The office's own code, hook and settings files (#120): every file in the office folder or below it. src/hook.mjs is the command
// hook each attached Claude Code session runs; src/ (server.mjs and the rest), launch.ps1, package.json and public/ (vocab.js holds the
// Security defaults, the page answers requests) run at the next start or page load. So an edit there is settings that run
// code, whatever the session root: also from a root inside the office, above it, in another repo, or through a link or a short
// name. Two exceptions, which the office never runs: Markdown documents (by the name Windows opens: a.md., not a.mjs:x.md), and
// the other checkouts in .claude/worktrees (a session there works on a copy, not on the running office; the office's own
// .claude files stay settings by the RUNS rule). A read stays as for any file: the code holds no secret, and secret files
// count by name. opts.office for tests; the office folder by default. As text (8.3 short names spelled out) and after links.
function ownCode(abs, real, opts) {
  const dir = (opts && opts.office) || OFFICE_ROOT;
  for (const [d, t] of [[longPath(dir), longPath(abs)], [realPath(dir), real]]) {
    if (!d || !t || !inside(d, t)) continue;
    const rel = parts(path.relative(norm(d), norm(t))).map((x) => winPart(x.toLowerCase()));
    if (rel.length > 2 && rel[0] === '.claude' && rel[1] === 'worktrees') continue;
    if (rel.length && rel[rel.length - 1].endsWith('.md')) continue;
    return true;
  }
  return false;
}
// The agents' own config homes (review M3): Claude Code's (~/.claude, or CLAUDE_CONFIG_DIR), Hermes's (~/.hermes, or
// HERMES_HOME) and Copilot CLI's (~/.copilot, or COPILOT_HOME, #22) hold settings, hooks, commands, skills and memory that the agent runs. A path in one of them is settings that
// run code whatever the root: a session rooted in ~/.claude would else rate its settings.json, hooks and CLAUDE.md as plain
// files inside its root (only the parts below a root count there). opts: { home, env } for tests; the real home and
// process.env by default. Both as text and after links.
export function configHomes(opts = {}) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  const env = opts.env || process.env;
  const out = [];
  for (const d of [home && path.join(home, '.claude'), env.CLAUDE_CONFIG_DIR, home && path.join(home, '.hermes'), env.HERMES_HOME,
    home && path.join(home, '.copilot'), env.COPILOT_HOME,
    // The office's own data folder (auth.mjs pageFile, paperclip-runtime.mjs runtimePaths): the page token, the board key and the config,
    // secrets and database of the Paperclip it runs (#193). An edit of its config or .env could turn off login mode.
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'AgentOffice') : home && path.join(home, '.agent-office')]) {
    if (d && path.isAbsolute(String(d))) out.push(path.resolve(String(d)));
  }
  return out;
}
// Looked up on each call: a config home made or linked after the office started still counts.
function inConfigHome(abs, real, opts) {
  for (const h of configHomes(opts || {})) {
    if (inside(h, abs)) return true;
    const rh = realPath(h);
    if (rh && real && inside(rh, real)) return true;
  }
  return false;
}
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
 * One key per file, whatever the spelling: the file Windows would open. a.txt, A.TXT, a.txt., a.txt::$DATA, sub\..\a.txt,
 * an 8.3 short name and a path through a junction all give one key (the real path of the file, or of its folder for a new
 * file; lower case on Windows). A relative path is read against root. The ACP provider keeps a turn's declined files by it,
 * so a declined edit cannot come back under another name.
 */
export function fileKey(root, p) {
  let abs = path.resolve(String(root || ''), String(p ?? ''));
  if (WIN) {
    const [head, ...rest] = abs.split(/[\\/]+/);
    abs = [head, ...rest.map(winPart)].join('\\');
  }
  try { abs = fs.realpathSync.native(abs); } catch {
    try { abs = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { /* a new folder: the text form */ }
  }
  return WIN ? abs.toLowerCase() : abs;
}

/**
 * True when target is inside root both as text (inside(), with 8.3 short names spelled out on both sides, so
 * C:\Users\RUNNER~1\x and C:\Users\runneradmin\x are one folder) and after every junction, symbolic link and
 * short name is resolved (fs.realpathSync.native on the target, or its nearest existing parent, and on the root).
 * A link that leads out, a broken link and a path that cannot be read are not inside. A link outside the root
 * that leads in is not inside either: the text must be inside too.
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
function place(root, p, opts) {
  let s = String(p ?? '');
  if (!s || s.includes('\0')) return { inside: false, secret: false, runs: false, later: false };
  if (/^~(?=[\\/]|$)/.test(s)) s = path.join(os.homedir(), s.slice(1));
  if (!path.isAbsolute(s) && !root) return { inside: false, ...kinds(parts(s)) };
  const abs = path.resolve(root || '', s);
  const r = resolveIn(root, abs), real = r.real, realRoot = r.realRoot;
  const isIn = r.in && !wideRoot(root); // a wide root (home, a drive) has no inside
  const whole = [...parts(abs), ...(real ? parts(real) : [])];
  // Inside, the parts below the root: of the texts resolveIn compared (one spelling on both sides), and of the real paths.
  const k = kinds(isIn ? [...parts(path.relative(norm(r.longRoot), norm(r.longAbs))), ...parts(path.relative(norm(realRoot), norm(real)))] : whole);
  // A .git folder anywhere on the path holds git's config and hooks, and the Start Menu holds the Startup folder, also when
  // the root is below them.
  if (!k.runs && whole.some((x) => forms(x).some((n) => n === '.git' || n === 'start menu'))) k.runs = true;
  if (ownState(abs) || ownState(real)) k.runs = true;
  if (!k.runs && inConfigHome(abs, real, opts)) k.runs = true;
  return { inside: isIn, ...k, own: ownCode(abs, real, opts) };
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
function readRisk(name, a, root, opts) {
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
  const w = place(root, base, opts), secret = w.secret || g.secret, runs = w.runs || g.runs;
  const action = fileAction(secret, runs, w.inside, 'read-inside');
  if (!w.inside) return R(secret ? 'high' : 'medium', action);
  return R(secret || runs ? 'medium' : 'low', action);
}

// Edit, Write, MultiEdit, NotebookEdit: settings that run code, saved state and the office's own code are high anywhere; low
// only inside the root.
function editRisk(file, root, opts) {
  if (!file) return R('medium', 'files-outside');
  const w = place(root, file, opts), runs = w.runs || w.later || w.own, action = fileAction(w.secret, runs, w.inside, 'edit-inside');
  if (runs) return R('high', action);
  return R(w.inside && !w.secret ? 'low' : 'medium', action);
}

/**
 * 'low' | 'medium' | 'high' for a tool call. root is the session's root folder: the worktree or the folder it
 * started in. Relative paths are read against it.
 */
export function riskOf(tool, input = {}, root = '', opts) { return rate(tool, input, root, opts).risk; }

/**
 * The action kind of a tool call: the row of the Security room grid it falls under (public/vocab.js has the names).
 * 'read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings' (settings files that run code),
 * 'secrets' (secret files), or 'other' (no row: the office's own tools, TodoWrite, Task and unknown tools).
 * The same root rule as riskOf: read-inside and edit-inside are exactly the low reads and edits.
 */
export function actionOf(tool, input = {}, root = '', opts) { return rate(tool, input, root, opts).action; }

// The office's own tools (office_inbox, office_ask, office_room, office_room_update) only talk to the office: no row.
const OFFICE_TOOL = /^mcp__office__/;
const WEB = new Set(['WebFetch', 'WebSearch']);
/** Both at once, for a caller that needs the two (the Security room verdict): { risk, action }. */
export function ratingOf(tool, input = {}, root = '', opts) { return rate(tool, input, root, opts); }

/** The rating of one tool call: { risk, action }. riskOf and actionOf read it. */
function rate(tool, input, root, opts) {
  const name = String(tool || '');
  const a = input && typeof input === 'object' ? input : {};
  // elevated: a command that asks for host elevation (OpenClaw exec, providers/openclaw.mjs toolCall) is high whatever it says.
  if (SHELLS.has(name)) { const cmd = String(a.command || ''); return R(a.elevated === true || DANGER.some((re) => re.test(cmd)) ? 'high' : 'medium', 'shell'); }
  if (NO_FILES.has(name)) return R('low', WEB.has(name) ? 'web' : 'other');
  if (READS.has(name)) return readRisk(name, a, root, opts);
  if (EDITS.has(name)) return editRisk(a.file_path || a.notebook_path, root, opts);
  // unknown tools, connector (MCP) tools, WebFetch, Task and the rest need a look
  if (WEB.has(name)) return R('medium', 'web');
  if (name.startsWith('mcp__') && !OFFICE_TOOL.test(name)) return R('medium', 'mcp');
  return R('medium', 'other');
}
