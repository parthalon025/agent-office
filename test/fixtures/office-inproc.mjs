// The in-process driver of the office core: the second adapter beside the HTTP server (src/server.mjs). It builds the real office
// (src/office.mjs) in this process and calls core.handle(request), so a route test needs no spawned server, no port and no tokens.
//
// What it does not cover, and what stays on real HTTP (test/auth.test.mjs, static.test.mjs, branch-port.test.mjs,
// startup.test.mjs): the request gate (Host, Origin, tokens, JSON content type), body parsing, the static files on a socket, port
// choice and the files written at listen. The office owns its port only when own() is called, so a driver office writes no file.
//
// One office per process (a test file is one process): the driver sets the environment the office reads, then imports it.
// startInProcess({ dir, env, state }) gives call(route, body?), hook(body, signal) and snapshot() over core.handle. It sets the
// environment the office reads (home, rate file, explainer off) before it imports the office, takes an optional saved state that
// the office finds at start, and keeps the office from owning its port, so it writes no file. The response is a copy, as the wire
// gives. Use it for any test that needs no gate, no body parsing, no file written at listen and no spawned program. The tests of
// the gate, the static files, the branch ports, the start-up files and the paid smoke run stay on real HTTP.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './office-server.mjs';

/**
 * startInProcess({ dir, port, env }) -> { office, call, snapshot, hook, stop }.
 * dir: a folder the test made and removes; the office keeps its runtime files' names there (nothing is written) and its home is dir/home.
 * runtime: a stand-in for the Paperclip runtime (a route test of its glue). state: the saved state the office finds at start (state.json of its port), as an object. port: the office's port number as the settings files name it; nothing listens on it. env: more environment for the office.
 * call(route, body?, { signal, headers }): GET when body is undefined, else POST. Resolves { status, json, response }.
 * snapshot(): the whole /events snapshot the page would get first. hook(body, signal): the HTTP hook route as Claude Code posts it.
 */
export async function startInProcess({ dir, port = 4391, env = {}, state = null, runtime = null }) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(process.env, {
    OFFICE_HOOKS: 'command', OFFICE_EXPLAIN: 'off', OFFICE_OPEN: '0', OFFICE_RATE_FILE: path.join(dir, 'no-rate.json'),
    LOCALAPPDATA: path.join(dir, 'local'), USERPROFILE: home, HOME: home, ...env,
  });
  const auth = await import('../../src/auth.mjs');
  const { officeFiles } = await import('../../src/files.mjs');
  const { cloudConfig } = await import('../../src/providers/cloud.mjs');
  const { createOffice } = await import('../../src/office.mjs');
  const files = officeFiles(dir, port);
  if (state) fs.writeFileSync(files.state, JSON.stringify(state));
  const office = createOffice({
    root: REPO_ROOT, port, files, agentToken: auth.newAgentToken(), pageToken: auth.newPageToken(),
    launchCodes: auth.createLaunchCodes(), remote: auth.remoteConfig(process.env, { port, branch: false }), remotePageToken: auth.newPageToken(),
    writeSecret: () => {}, cloud: { foundry: cloudConfig(process.env, 'OFFICE_FOUNDRY'), studio: cloudConfig(process.env, 'OFFICE_COPILOTSTUDIO'), cursor: cloudConfig(process.env, 'OFFICE_CURSORCLOUD'), gateway: cloudConfig(process.env, 'OFFICE_HERMESGATEWAY') },
    warmWalker: false, runtime, // runtime: a stand-in for the Paperclip runtime (paperclip-runtime.mjs); none makes the real one, which starts nothing until asked
  });
  const call = async (route, body, { signal, headers } = {}) => {
    const url = new URL(route, 'http://127.0.0.1');
    const response = await office.core.handle({ method: body === undefined ? 'GET' : 'POST', path: url.pathname, query: url.searchParams, headers: headers || {}, body, signal });
    const b = response.body;
    let json = null;
    // A copy, as the wire gives: a handler may answer with a live object of the office's state.
    if (b !== null && typeof b === 'object' && !Buffer.isBuffer(b)) json = JSON.parse(JSON.stringify(b));
    else if (typeof b === 'string') { try { json = JSON.parse(b); } catch { /* not json */ } }
    return { status: response.status, json, response };
  };
  const snapshot = () => {
    let first = null;
    const stop = office.subscribe((chunk) => { first ||= chunk; });
    stop();
    return JSON.parse(/^data: (.*)\n\n$/s.exec(first)[1]);
  };
  return { office, call, snapshot, hook: (body, signal) => call('/hook/http', body, { signal }), stop: () => office.stop() };
}

/**
 * Removes the folder of a driver office. A program the office asked a moment ago (the campus looks at a repository after each change)
 * can still hold the folder as its current folder on Windows, so this tries again for up to `ms` and then throws.
 */
export async function removeTree(dir, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (Date.now() - t0 > ms) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
