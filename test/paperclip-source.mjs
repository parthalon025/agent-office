// Fetch the pinned Paperclip release into .paperclip-source/ so agents and tests read the real routes, not a guess.
// `npm run paperclip:source`. Node built-ins only: fetch, node:zlib, a small tar reader. No npm, no install scripts, no program started.
// The CLI package (`paperclipai`) is checked against PINNED (src/paperclip-runtime.mjs). The server routes and the validators
// live in two exact-version dependencies of it, `@paperclipai/server` and `@paperclipai/shared`; their SHA-512 are pinned
// below (read from the npm registry for that version) and move with the pin. Only the files the contract needs are written:
// the server's dist/routes and dist/realtime, app.js, index.js and package.json, and the shared package without maps and tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PINNED } from '../src/paperclip-runtime.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = path.join(ROOT, '.paperclip-source');
export const MARKER = 'office-source.json';

// Integrity of the dependencies of PINNED.version (npm registry, dist.integrity). Move with PINNED.
export const DEPENDENCIES = Object.freeze({
  '2026.1106.0': {
    server: 'sha512-OqG0qydn5Pky3iHmTgL3fvAh47m77CYgkuM3CgV6ciw6tY/AmBgkO3greyr0LinLFk7x1FdLkF1sfVVukZo/YA==',
    shared: 'sha512-fleBeHYbmnwdvEuzyQ4ABUFbHzqft47ni/ZktF1jWQsFkyfHmHBz5xFm3nfD3WZQ9UGnVZmXfEhfk+nizpeGEQ==',
  },
});

const REGISTRY = 'https://registry.npmjs.org';

/** The packages to fetch: folder, registry address, integrity and which files of the tarball to keep. */
export function packages(pin = PINNED, deps = DEPENDENCIES) {
  const d = deps[pin.version];
  if (!d) throw new Error(`The pin ${pin.version} has no integrity for @paperclipai/server and @paperclipai/shared in test/paperclip-source.mjs. Add them (npm view @paperclipai/server@${pin.version} dist.integrity).`);
  const keepServer = (p) => p === 'package.json' || (/^dist\/(routes\/|realtime\/|app\.js$|index\.js$)/.test(p) && !/\.(map|d\.ts)$/.test(p) && !/\.test\.js$/.test(p));
  const keepShared = (p) => !/\.map$/.test(p) && !/\.test\.(js|d\.ts)$/.test(p);
  return [
    { dir: 'paperclipai', url: `${REGISTRY}/paperclipai/-/paperclipai-${pin.version}.tgz`, integrity: pin.integrity, keep: (p) => p === 'package.json' || p === 'README.md' || (p.startsWith('dist/') && !p.endsWith('.map')) },
    { dir: 'server', url: `${REGISTRY}/@paperclipai/server/-/server-${pin.version}.tgz`, integrity: d.server, keep: keepServer },
    { dir: 'shared', url: `${REGISTRY}/@paperclipai/shared/-/shared-${pin.version}.tgz`, integrity: d.shared, keep: keepShared },
  ];
}

export const sha512 = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;

/** The regular files of a tar (already unzipped) as { name, data }. The leading `package/` folder is removed. */
export function* readTar(tar) {
  let off = 0, longName = null;
  const str = (a, b) => { const s = tar.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) return;
    let name = str(off, off + 100);
    const prefix = str(off + 345, off + 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    const start = off + 512;
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(start, start + size); continue; }
    if (type === 'x' || type === 'g') continue;   // pax headers: npm packs short names
    if (longName) { name = longName; longName = null; }
    if (type !== '0') continue;                    // regular files only: no link, no device
    yield { name: name.replace(/^package\//, ''), data };
  }
}

/** Where a tar name lands, or null when it would leave the folder. */
export function safeJoin(dir, name) {
  if (!name || name.includes('\0') || path.isAbsolute(name) || /^[a-z]:/i.test(name)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  return full === root || !full.startsWith(root + path.sep) ? null : full;
}

export function current(dest = SOURCE_DIR, pin = PINNED) {
  try { const m = JSON.parse(fs.readFileSync(path.join(dest, MARKER), 'utf8')); return m.version === pin.version && m.integrity === pin.integrity; } catch { return false; }
}

export async function fetchSource({ dest = SOURCE_DIR, pin = PINNED, deps = DEPENDENCIES, fetchFn = fetch, log = console.log } = {}) {
  if (current(dest, pin)) { log(`.paperclip-source is at ${pin.version} already.`); return false; }
  const list = packages(pin, deps);
  const next = `${dest}.tmp`;
  fs.rmSync(next, { recursive: true, force: true });
  for (const p of list) {
    log(`Downloading ${p.url}`);
    const res = await fetchFn(p.url);
    if (!res.ok) throw new Error(`${p.url} answered ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha512(buf);
    if (got !== p.integrity) throw new Error(`${p.url} does not match its pinned SHA-512 (got ${got}). Nothing was written.`);
    const out = path.join(next, p.dir);
    let n = 0;
    for (const f of readTar(zlib.gunzipSync(buf))) {
      if (!p.keep(f.name)) continue;
      const to = safeJoin(out, f.name);
      if (!to) throw new Error(`${p.url} holds an unsafe path: ${f.name}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
      n += 1;
    }
    log(`  ${p.dir}: ${n} files`);
  }
  fs.writeFileSync(path.join(next, MARKER), JSON.stringify({ version: pin.version, integrity: pin.integrity }) + '\n');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(next, dest);
  log(`.paperclip-source is at ${pin.version}.`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchSource().catch((e) => { console.error(e.message); process.exit(1); });
}
