// Display formats: one money format, plurals, short folder paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/format.js';

const F = globalThis.OfficeFormat;
const CUT = '\u2026';

test('money has one form: $0.00, <$0.01, two decimals', () => {
  assert.equal(F.money(0), '$0.00');
  assert.equal(F.money(0.004), '<$0.01');
  assert.equal(F.money(0.009), '<$0.01');
  assert.equal(F.money(0.01), '$0.01');
  assert.equal(F.money(0.256), '$0.26');
  assert.equal(F.money(12), '$12.00');
  assert.equal(F.money(1234.5), '$1234.50');
});

test('money shows a dash when there is no figure', () => {
  assert.equal(F.money(null), '\u2013');
  assert.equal(F.money(undefined), '\u2013');
  assert.equal(F.money(NaN), '\u2013');
  assert.equal(F.money('3'), '\u2013');
});

test('plural counts with the right word', () => {
  assert.equal(F.plural(0, 'turn'), '0 turns');
  assert.equal(F.plural(1, 'turn'), '1 turn');
  assert.equal(F.plural(2, 'turn'), '2 turns');
  assert.equal(F.plural(1, 'bot', 'bots'), '1 bot');
  assert.equal(F.plural(3, 'entry', 'entries'), '3 entries');
});

test('short path keeps the last two folders and marks the cut', () => {
  assert.equal(F.shortPath('E:\\pensiv'), 'E:\\pensiv');
  assert.equal(F.shortPath('E:\\agent-office-wt\\u-dock'), 'E:\\agent-office-wt\\u-dock');
  assert.equal(F.shortPath('C:\\Users\\justi\\AppData\\Local\\Temp\\claude\\abc\\scratch'), CUT + '\\abc\\scratch');
  assert.equal(F.shortPath('/home/justi/work/repo/sub'), CUT + '/repo/sub');
  assert.equal(F.shortPath('C:\\Users\\justi\\repo\\sub\\'), CUT + '\\repo\\sub');
  assert.equal(F.shortPath(''), '');
  assert.equal(F.shortPath(null), '');
});

test('folder name is the last segment', () => {
  assert.equal(F.folderName('E:\\repos\\agent-office\\'), 'agent-office');
  assert.equal(F.folderName('/a/b'), 'b');
  assert.equal(F.folderName(''), '');
});

test('hint pill grows with its label and keeps the key chip inside the round end', () => {
  const a = F.hintPill(300, 150), b = F.hintPill(500, 150);
  assert.equal(b.w - a.w, 200, 'the pill is as much wider as the label');
  assert.ok(a.keyX > a.textX + 300, 'the chip starts after the label');
  assert.ok(a.keyX + a.keyW < a.w - 6, 'the chip ends inside the pill edge');
  assert.ok(a.w - 6 - (a.keyX + a.keyW) >= 24, 'the chip does not touch the round end');
});

test('hint pill without a key has the label only', () => {
  const p = F.hintPill(300, 0);
  assert.equal(p.keyX, null);
  assert.equal(p.keyW, 0);
  assert.ok(p.w < F.hintPill(300, 150).w);
  assert.deepEqual(F.hintPill(NaN, undefined), F.hintPill(0, 0), 'a bad width counts as zero');
});

test('mask secret hides every copy of a secret and keeps the rest of the text', () => {
  const t = '{"x-office-token":"abc123","again":"abc123"}';
  const m = F.maskSecret(t, 'abc123');
  assert.ok(!m.includes('abc123'), 'no copy of the secret stays');
  assert.equal(m, '{"x-office-token":"' + F.SECRET_MASK + '","again":"' + F.SECRET_MASK + '"}');
  assert.equal(F.maskSecret('abc123', 'abc123'), F.SECRET_MASK, 'the mask has a fixed length, so it does not show the length');
});

test('mask secret leaves the text alone when there is no secret to hide', () => {
  assert.equal(F.maskSecret('plain text', ''), 'plain text');
  assert.equal(F.maskSecret('plain text', null), 'plain text');
  assert.equal(F.maskSecret(null, 'abc'), '');
  assert.equal(F.maskSecret('a.c', '.'), 'a' + F.SECRET_MASK + 'c', 'a secret is text, not a pattern');
});

test('cleanupNote says what the clean-up did, and is an error when a floor was skipped', () => {
  assert.deepEqual(F.cleanupNote({ deleted: ['a', 'b'], skipped: [] }), ['info', 'Floors cleaned up', '2 floors and their rooms are gone.']);
  assert.deepEqual(F.cleanupNote({ deleted: ['a'], skipped: [] }), ['info', 'Floors cleaned up', '1 floor and its rooms are gone.']);
  assert.deepEqual(F.cleanupNote({ deleted: ['a'], skipped: ['x', 'y'] }), ['error', 'Some floors stayed', '1 floor deleted. Kept: x, y. They changed or a session works there.']);
  assert.deepEqual(F.cleanupNote({ deleted: [], skipped: ['x'] }), ['error', 'No floor deleted', 'Kept: x. It changed or a session works there.']);
  assert.deepEqual(F.cleanupNote({}), ['info', 'Nothing to clean up', 'No floor was deleted.']);
});
