// The files an office keeps in its own folder, by port (#100). The office on the default port (4317) keeps the plain
// names, so `npm start` and the settings files that users already point Claude Code at work as before. An office on any
// other port (OFFICE_PORT=<n>, npm run start:branch) has its own names with the port in them, so a second office in the
// same folder never rewrites the first one's agent token, hook settings, MCP settings, saved state or past sessions,
// and never runs the first one's schedules.
// hook.mjs and mcp.mjs find their office from the port argument that an office on another port bakes into the command
// lines of its settings files; no argument means the default port. The page token file is outside the folder and is
// per port already (auth.mjs pageFile).
// Pure: names only, no I/O. Only node:path, so the command hook (one Node start per event) stays light.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4317;

// The office folder: the repository root, one level above src/ (where this file is). The office keeps its runtime files
// here (officeFiles), the page, DS and tokens are served from here, and risk.mjs rates edits of its code against it.
// This is the one place that knows the layout: every other module imports it and never walks up from its own file.
export const OFFICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;

/**
 * The office's files in folder root for a port: { token, hooksCmd, hooksHttp, mcp, state, history }.
 * The default port gives .office-token, office-hooks.json, office-hooks-http.json, office-mcp.json, state.json and
 * history.json; port 4392 gives .office-token-4392, office-hooks-4392.json, office-hooks-http-4392.json,
 * office-mcp-4392.json, state-4392.json and history-4392.json.
 */
export function officeFiles(root, port = DEFAULT_PORT) {
  const p = Number(port);
  if (!isPort(p)) throw new RangeError(`Not a port: ${port}`);
  const tag = p === DEFAULT_PORT ? '' : `-${p}`;
  const at = (name) => path.join(root, name);
  return {
    token: at(`.office-token${tag}`),
    hooksCmd: at(`office-hooks${tag}.json`),
    hooksHttp: at(`office-hooks-http${tag}.json`),
    mcp: at(`office-mcp${tag}.json`),
    state: at(`state${tag}.json`),
    history: at(`history${tag}.json`),
  };
}

/** The arguments an office bakes into hook.mjs and mcp.mjs command lines: none on the default port, else the port. */
export const portArgs = (port) => (Number(port) === DEFAULT_PORT ? [] : [String(Number(port))]);

/**
 * The port of a hook.mjs or mcp.mjs command line (its first argument): the default port when there is none (settings
 * from the default office, and settings made before #100), the port when it is one, else null (nothing to talk to).
 */
export function portArg(arg) {
  if (arg === undefined || arg === '') return DEFAULT_PORT;
  const n = /^\d{1,5}$/.test(String(arg)) ? Number(arg) : NaN;
  return isPort(n) ? n : null;
}
