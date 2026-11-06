// Vendored files and the static file list (audit #27 M2). The page loads nothing from another site: React and the
// fonts are in public/vendor, byte for byte as published, and the server serves them from its exact-match list.
// The source checks run without a server. The serving checks run a copy of the office in a temp folder, on a free
// port, with its own LOCALAPPDATA (as test/auth.test.mjs does), so they never touch this folder or a running office.
// Offline: no claude on PATH for that server, no browser (OFFICE_OPEN=0), no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as auth from '../auth.mjs';
import { startOnFreePort } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('README screenshots: every image exists; the city, boards, desk and Needs you shots are shown (#32)', () => {
  const md = read('README.md');
  const imgs = [...md.matchAll(/!\[[^\]]*\]\((docs\/img\/[^)]+)\)/g)].map((m) => m[1]);
  for (const f of imgs) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
  for (const n of ['day-city-1360', 'day-boards-1360', 'day-desk-1360', 'day-needs-you-1360']) {
    assert.ok(imgs.some((f) => f.includes(n)), `README shows no ${n}`);
  }
});

// The pinned bytes. public/vendor/README.md has the same values and the steps to update them.
const REACT = {
  '/vendor/react.production.min.js': { file: 'public/vendor/react.production.min.js', sha: 'd949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd', license: 'react.production.min.js' },
  '/vendor/react-dom.production.min.js': { file: 'public/vendor/react-dom.production.min.js', sha: '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d', license: 'react-dom.production.min.js' },
};
const FONTS = path.join(ROOT, 'public', 'vendor', 'fonts');
const fontNames = () => [...read('public/vendor/fonts/fonts.css').matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));

// ---------- sources ----------

test('React and ReactDOM 18.3.1 are vendored with their pinned SHA-256, the MIT license and a README', () => {
  for (const [route, r] of Object.entries(REACT)) {
    const buf = fs.readFileSync(path.join(ROOT, r.file));
    assert.equal(sha256(buf), r.sha, `${r.file}: the bytes changed. Update the pin only after the steps in public/vendor/README.md.`);
    const head = buf.subarray(0, 400).toString('utf8');
    assert.match(head, /@license React/, route);
    assert.ok(head.includes(r.license), route);
    assert.ok(buf.toString('utf8').includes('"18.3.1"'), `${route} carries the version string`);
    assert.doesNotMatch(buf.toString('latin1'), /\r\n/, `${route} has no CRLF (a checkout with core.autocrlf would break the pin; see .gitattributes)`);
  }
  assert.match(read('public/vendor/react-LICENSE.txt'), /^MIT License\s+Copyright \(c\) Facebook, Inc\. and its affiliates\./);
  const readme = read('public/vendor/README.md');
  for (const r of Object.values(REACT)) assert.ok(readme.includes(r.sha), 'README lists ' + r.sha);
  assert.match(read('.gitattributes'), /^public\/vendor\/\*\* -text$/m);
});

test('index.html loads every script and style sheet from this server, and React from /vendor', () => {
  const html = read('public/index.html');
  const refs = [...html.matchAll(/<(script|link)\b[^>]*\b(src|href)="([^"]*)"/g)].map((m) => m[3]);
  assert.ok(refs.length >= 15, 'found the page files');
  for (const r of refs) assert.match(r, /^\/(?!\/)/, `${r} is not a path on this server`);
  assert.doesNotMatch(html, /https?:\/\//, 'no URL of another site in the page');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script (the CSP allows none)');
  assert.doesNotMatch(html, /\son[a-z]+=|style="/i, 'no inline handler or style attribute (the CSP allows none)');
  const i = (s) => refs.indexOf(s);
  for (const s of ['/vendor/react.production.min.js', '/vendor/react-dom.production.min.js', '/vendor/fonts/fonts.css']) assert.ok(i(s) > -1, s);
  assert.ok(i('/vendor/react.production.min.js') < i('/vendor/react-dom.production.min.js') && i('/vendor/react-dom.production.min.js') < i('/components/bundle.js'), 'React, then ReactDOM, then the DS bundle');
  assert.ok(i('/vendor/fonts/fonts.css') < i('/components/bundle.css'), 'the fonts load before the DS style sheet');
});

test('no style sheet imports a file or a font from another site', () => {
  for (const f of ['components/bundle.css', 'public/office.css', 'tokens.css', 'public/vendor/fonts/fonts.css']) {
    const css = read(f);
    assert.doesNotMatch(css, /@import/, f);
    assert.doesNotMatch(css, /url\(\s*['"]?(https?:)?\/\//i, f);
  }
});

test('fonts.css names only vendored woff2 files, each one exists, and each family has its license', () => {
  const css = read('public/vendor/fonts/fonts.css');
  const names = fontNames();
  assert.equal(names.length, 48, 'one src per face');
  for (const n of names) {
    assert.match(n, /^[a-z0-9-]+\.woff2$/, n);
    const buf = fs.readFileSync(path.join(FONTS, n));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', n);
  }
  const onDisk = fs.readdirSync(FONTS).filter((f) => f.endsWith('.woff2')).sort();
  assert.deepEqual([...new Set(names)].sort(), onDisk, 'every font file is used, and every used file is here');
  const families = [...new Set([...css.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(families, ['Archivo', 'Chivo Mono', 'IBM Plex Mono', 'IBM Plex Sans', 'VT323']);
  for (const fam of families) {
    const lic = path.join(FONTS, `OFL-${fam.toLowerCase().replace(/\s+/g, '')}.txt`);
    assert.match(fs.readFileSync(lic, 'utf8'), /SIL Open Font License, Version 1\.1/, lic);
  }
  // The faces the DS font tokens name (tokens.css) are all here.
  for (const fam of ['IBM Plex Sans', 'IBM Plex Mono', 'VT323', 'Archivo', 'Chivo Mono']) assert.ok(read('tokens.css').includes(`"${fam}"`), fam);
  const readme = read('public/vendor/README.md');
  for (const n of onDisk) assert.match(readme, new RegExp('`' + n.replace(/[.]/g, '\\.') + '` \\| `[^`]+` \\| `' + sha256(fs.readFileSync(path.join(FONTS, n))) + '`'), 'README row and hash of ' + n);
});

// ---------- the real server ----------

/** GET a path with full control of the Host header; resolves { status, headers, body (Buffer) }. */
function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('the server serves the vendored files with their type and pinned bytes, and nothing else under /vendor', { timeout: 900000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-static-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json' || f === 'tokens.css') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public', 'components']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(baseEnv, {
    PATH: [path.dirname(process.execPath), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  let office = null;
  try {
    const started = await startOnFreePort(dir, baseEnv);
    office = started.office;
    const { port } = started;

    for (const [route, r] of Object.entries(REACT)) {
      const res = await get(port, route);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8', route);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', route);
      assert.equal(sha256(res.body), r.sha, route + ' served bytes');
    }
    const sheet = await get(port, '/vendor/fonts/fonts.css');
    assert.equal(sheet.status, 200);
    assert.equal(sheet.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(sheet.headers['content-security-policy'], auth.CSP);
    for (const n of new Set(fontNames())) {
      const res = await get(port, '/vendor/fonts/' + n);
      assert.equal(res.status, 200, n);
      assert.equal(res.headers['content-type'], 'font/woff2', n);
      assert.equal(sha256(res.body), sha256(fs.readFileSync(path.join(FONTS, n))), n);
    }
    // Every script and style sheet the page names is served (a missing one would leave the page blank).
    const html = (await get(port, '/')).body.toString('utf8');
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]*)"/g)) assert.equal((await get(port, m[1])).status, 200, m[1]);
    // The list is exact: no folder listing, no license or README file, no way out of the folder.
    for (const p of ['/vendor/', '/vendor', '/vendor/README.md', '/vendor/react-LICENSE.txt', '/vendor/fonts/', '/vendor/fonts/OFL-vt323.txt',
      '/vendor/fonts/../../server.mjs', '/vendor/fonts/%2e%2e/%2e%2e/server.mjs', '/vendor/fonts/..%2f..%2fserver.mjs', '/vendor/fonts/fonts.css%00',
      '/vendor/fonts/VT323-LATIN.WOFF2', '/vendor//react.production.min.js', '/public/vendor/react.production.min.js', '/vendor/react.production.min.js/']) {
      const res = await get(port, p);
      assert.notEqual(res.status, 200, p);
      assert.ok(!res.body.includes('process.env'), p + ' leaked a source file');
    }
  } finally {
    if (office) await office.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
