import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startupDir, entryPath, entryContent, state, enable, disable, ENTRY_NAME } from '../startup.mjs';

test('startup folder is under APPDATA; unknown without it', () => {
  assert.equal(startupDir('C:\\Users\\a\\AppData\\Roaming'), 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.equal(startupDir(''), '');
  assert.equal(entryPath('C:\\S'), path.join('C:\\S', ENTRY_NAME)); // this platform's rules: the folder is a real local one
});

test('entry content: quoted title, quoted paths, CRLF, no kill', () => {
  const c = entryContent('E:\\agent office\\100%', 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(c, /cd \/d "E:\\agent office\\100%%"/);
  assert.match(c, /start "Office" \/min "C:\\Program Files\\nodejs\\node\.exe" server\.mjs/);
  assert.ok(c.includes('\r\n') && !/[^\r]\n/.test(c));
  assert.doesNotMatch(c, /taskkill|\/IM/i);
});

test('enable and disable touch only the injected folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-startup-'));
  try {
    assert.equal(state(dir).enabled, false);
    assert.equal(enable(dir, 'E:\\x', 'C:\\node.exe').enabled, true);
    assert.equal(fs.readFileSync(path.join(dir, ENTRY_NAME), 'utf8'), entryContent('E:\\x', 'C:\\node.exe'));
    assert.equal(disable(dir).enabled, false);
    assert.equal(disable(dir).enabled, false); // already off: no error
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(state(''), { available: false, enabled: false, path: '' });
  assert.throws(() => enable('', 'r', 'n'));
});
