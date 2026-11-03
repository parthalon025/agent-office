#!/usr/bin/env node
// Checks that HTTP hooks work on this Claude Code version and, if so, switches the office to them.
// Needs the office to be running. Makes one tiny Haiku call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, '.office-token'), 'utf8'));
console.log('Probing HTTP hooks (about 15 seconds)...');
const res = await fetch(`http://127.0.0.1:${cfg.port}/api/probe-http`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': cfg.token }, body: '{}',
  signal: AbortSignal.timeout(150000),
});
const r = await res.json();
console.log(r.ok
  ? `HTTP hooks work on Claude Code ${r.version}. The office now uses them.`
  : `HTTP hooks did not pass (${r.missing && r.missing.length ? 'missing ' + r.missing.join(', ') : r.error}). The office keeps command hooks.`);
process.exit(r.ok ? 0 : 1);
