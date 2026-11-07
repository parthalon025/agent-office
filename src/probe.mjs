#!/usr/bin/env node
// Checks that HTTP hooks work on this Claude Code version and, if so, switches the office to them.
// Needs the office to be running. Makes one tiny Haiku call. It calls a page route, so it reads the page token from pageFile.
// Usage: npm run probe (the office of npm start), or npm run probe -- <port> (an office on another port).
// First statement: Windows never looks for a program in the current folder (launch.mjs resolveExe has the reason).
process.env.NoDefaultCurrentDirectoryInExePath = '1';
import fs from 'node:fs';
import { pageFile } from './auth.mjs';
import { officeFiles, portArg, OFFICE_ROOT } from './files.mjs';

// The token file of the port (files.mjs) names the port of the running office. /api/probe-http is a page route, so the
// call carries the page token, which the office keeps outside this folder for the user's own tools (auth.mjs pageFile).
const asked = portArg(process.argv[2]);
if (!asked) {
  console.error(`"${process.argv[2]}" is not a port. Run npm run probe, or npm run probe -- <port> for an office on another port.`);
  process.exit(1);
}
let page;
try {
  const { port } = JSON.parse(fs.readFileSync(officeFiles(OFFICE_ROOT, asked).token, 'utf8'));
  page = JSON.parse(fs.readFileSync(pageFile(process.env, port), 'utf8'));
} catch {
  console.error(process.argv[2]
    ? `The office on port ${asked} is not running. Start it, then run npm run probe -- ${asked} again.`
    : 'The office is not running. Start it with npm start, then run npm run probe again.');
  process.exit(1);
}
console.log('Probing HTTP hooks (about 15 seconds)...');
const res = await fetch(`http://127.0.0.1:${page.port}/api/probe-http`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': page.token }, body: '{}',
  signal: AbortSignal.timeout(150000),
});
const r = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`The office refused the probe (${res.status}: ${r.error || 'no reason'}). Restart the office with npm start, then try again.`);
  process.exit(1);
}
console.log(r.ok
  ? `HTTP hooks work on Claude Code ${r.version}. The office now uses them.`
  : `HTTP hooks did not pass (${r.missing && r.missing.length ? 'missing ' + r.missing.join(', ') : r.error}). The office keeps command hooks.`);
process.exit(r.ok ? 0 : 1);
