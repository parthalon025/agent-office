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
