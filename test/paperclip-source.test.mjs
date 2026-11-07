// The offline part of `npm run paperclip:source`: the tar reader, the path rule, the hash check and the idempotent skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTar, safeJoin, sha512, fetchSource, current, MARKER } from './paperclip-source.mjs';

function tarOf(files) {
  const blocks = [];
  for (const [name, content, type = '0'] of files) {
    const data = Buffer.from(content);
    const head = Buffer.alloc(512);
    head.write(name, 0, 100, 'utf8');
    head.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
    head.write(type, 156, 1, 'ascii');
    blocks.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('readTar gives regular files without the package folder and skips links', () => {
  const tar = tarOf([['package/a.txt', 'one'], ['package/dir/b.txt', 'two'], ['package/link', '', '2']]);
  assert.deepEqual([...readTar(tar)].map((f) => [f.name, f.data.toString()]), [['a.txt', 'one'], ['dir/b.txt', 'two']]);
});

test('safeJoin refuses a name that leaves the folder', () => {
  const dir = path.join(os.tmpdir(), 'x-safe');
  assert.ok(safeJoin(dir, 'a/b.js'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '', 'a\0b']) assert.equal(safeJoin(dir, bad), null, bad);
});

test('fetchSource checks the SHA-512 before it writes, extracts what it keeps and then skips', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-psrc-'));
  try {
    const target = path.join(dest, 'src');
    const tgz = zlib.gzipSync(tarOf([['package/package.json', '{}'], ['package/dist/x.js', 'x'], ['package/dist/x.js.map', 'm']]));
    const pin = { version: '1.0.0', integrity: sha512(tgz) };
    const deps = { '1.0.0': { server: sha512(tgz), shared: sha512(tgz) } };
    const serve = (buf) => async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });
    const quiet = () => {};
    await assert.rejects(fetchSource({ dest: target, pin, deps, fetchFn: serve(Buffer.from('tampered')), log: quiet }), /does not match its pinned SHA-512/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(await fetchSource({ dest: target, pin, deps, fetchFn: serve(tgz), log: quiet }), true);
    assert.equal(fs.readFileSync(path.join(target, 'paperclipai', 'dist', 'x.js'), 'utf8'), 'x');
    assert.equal(fs.existsSync(path.join(target, 'paperclipai', 'dist', 'x.js.map')), false);
    assert.ok(fs.existsSync(path.join(target, MARKER)));
    assert.equal(current(target, pin), true);
    assert.equal(await fetchSource({ dest: target, pin, deps, fetchFn: async () => { throw new Error('no network expected'); }, log: quiet }), false);
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
});
