// How risky a tool call is, for the Approve card and the "Approve all low-risk" action.
// An allowlist: only read-only tools and edits inside the session folder are low. Every agent
// provider uses this one rule, so a local model or a Copilot session is rated like Claude Code.
import path from 'node:path';

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'NotebookRead']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);
// Deletes, moves, process stops, policy changes, downloads, pushes and resets, in sh and PowerShell.
const DANGER = /(^|[\s;|&(])(rm|sudo|del|erase|rd|rmdir|format|chmod|chown|kill|pkill|taskkill|drop|truncate|dd|mkfs|shutdown|reboot|Remove-Item|ri|Move-Item|mv|Stop-Process|spps|Set-ExecutionPolicy|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Invoke-Expression|iex|curl|wget|Start-Process|Format-(Volume|Disk|Partition)|Clear-Content|Set-Content|Out-File|reg|schtasks|netsh)(?=$|[\s;|&)])|git\s+(push|reset|clean|checkout\s+--|branch\s+-D|rebase|filter-branch)|>\s*[^\s&|]/i;

/** True when target is the folder root or inside it (case-insensitive on Windows). */
export function inside(root, target) {
  if (!root || !target) return false;
  const norm = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 'low' | 'medium' | 'high' for a tool call. cwd is the session folder. */
export function riskOf(tool, input = {}, cwd = '') {
  const name = String(tool || '');
  if (SHELLS.has(name)) return DANGER.test(String(input.command || '')) ? 'high' : 'medium';
  if (READ_ONLY.has(name)) return 'low';
  if (EDITS.has(name)) return inside(cwd, input.file_path || input.notebook_path) ? 'low' : 'medium';
  return 'medium'; // unknown tools, connector (MCP) tools, WebFetch, Task and the rest need a look
}
