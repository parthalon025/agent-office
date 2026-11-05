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

test('cost says unknown for an agent that reports none, never $0.00; a known part keeps its figure', () => {
  assert.equal(F.cost(null, true), 'unknown');
  assert.equal(F.cost(0, true), 'unknown', 'a room of unknown and $0.00 is still unknown');
  assert.equal(F.cost(0.26, true), '$0.26 + unknown', 'a room with priced and unpriced sessions');
  assert.equal(F.cost(0.26, 2), '$0.26 + unknown', 'a count of unpriced sessions works too');
  assert.equal(F.cost(0.26, false), '$0.26');
  assert.equal(F.cost(0, 0), '$0.00');
  assert.equal(F.cost(null), '–');
});

test('costLabel: the cost in a line of other facts, one wording for every surface', () => {
  assert.equal(F.costLabel(null, true), 'cost unknown');
  assert.equal(F.costLabel(0.26, 1), '$0.26 + cost unknown');
  assert.equal(F.costLabel(0.26, false), '$0.26');
  assert.equal(F.costLabel(undefined), '–', 'no figure: a dash, as money()');
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
  assert.deepEqual(F.cleanupNote({ deleted: ['a', 'b'], skipped: ['x'] }), ['error', 'Some floors stayed', '2 floors deleted. Kept: x. It changed or a session works there.']);
  assert.deepEqual(F.cleanupNote({ deleted: [], skipped: ['x'] }), ['error', 'No floor deleted', 'Kept: x. It changed or a session works there.']);
  assert.deepEqual(F.cleanupNote({}), ['info', 'Nothing to clean up', 'No floor was deleted.']);
});

test('cleanupEmpty gives the true reason the clean-up list is empty', () => {
  assert.equal(F.cleanupEmpty(0), 'No floor is ready. A floor must be merged, have no changes and no session, and be over an hour old.');
  assert.equal(F.cleanupEmpty(undefined), F.cleanupEmpty(0));
  assert.equal(F.cleanupEmpty(1), 'You kept the floor. No floor is deleted.');
  assert.equal(F.cleanupEmpty(3), 'You kept all 3 floors. No floor is deleted.');
});

// ----- token counts, timeline and export (#72) -----
test('tokens: 999, 1.2k, 15k, 3.4M, 12M', () => {
  assert.deepEqual([0, 999, 1234, 15000, 3400000, 12000000, null, 'x'].map(F.tokens), ['0', '999', '1.2k', '15k', '3.4M', '12M', '0', '0']);
});

test('duration: under a second in ms, then seconds, then minutes; a dash when unknown', () => {
  assert.deepEqual([420, 1500, 59000, 61000, 125000, null, undefined].map(F.duration), ['420 ms', '1.5 s', '59 s', '1 min 1 s', '2 min 5 s', '–', '–']);
});

test('clock: hours, minutes and seconds, in the given zone', () => {
  assert.equal(F.clock(Date.UTC(2026, 10, 4, 14, 3, 9), 'utc'), '14:03:09');
  assert.equal(F.clock(null), '–');
});

const CALLS = [
  { id: 'b', name: 'Bash', detail: 'npm test', t: Date.UTC(2026, 10, 4, 14, 0, 10), ms: 4200, ok: false, err: 'exit 1' },
  { id: 'a', name: 'Read', detail: 'a.txt', t: Date.UTC(2026, 10, 4, 14, 0, 5), ms: 40, ok: true },
  { id: 'c', name: 'Edit', detail: 'a.txt', t: Date.UTC(2026, 10, 4, 14, 0, 20), ms: null, ok: null },
];

test('timeline: one row per call, oldest first, with the time, the duration and the result', () => {
  const rows = F.timeline(CALLS, { zone: 'utc', start: Date.UTC(2026, 10, 4, 14, 0, 0) });
  assert.deepEqual(rows.map((r) => [r.id, r.time, r.after, r.duration, r.state]), [
    ['a', '14:00:05', '+5 s', '40 ms', 'done'],
    ['b', '14:00:10', '+10 s', '4.2 s', 'failed'],
    ['c', '14:00:20', '+20 s', '–', 'open'],
  ]);
  assert.equal(rows[1].text, 'Bash npm test');
  assert.equal(rows[1].err, 'exit 1');
  assert.deepEqual(F.timeline([], {}), []);
  assert.deepEqual(F.timeline(null, {}), []);
});

test('exportText: the session as Markdown with its facts, its first instruction, the timeline and its replies; cost unknown stays unknown', () => {
  const s = {
    name: 'fixer', agent: 'Hermes Agent', model: 'm1', cwd: 'C:\\w\\repo', worktree: { branch: 'agent/fixer-1' }, startedAt: Date.UTC(2026, 10, 4, 14, 0, 0), turns: 2,
    cost: null, costUnknown: true, usage: { tokens: 15000 }, prompt: 'fix the test', calls: CALLS,
    replies: [{ id: 1, t: Date.UTC(2026, 10, 4, 14, 1, 0), text: 'Done.\nTwo files changed.' }],
  };
  const md = F.exportText(s, { zone: 'utc' });
  assert.match(md, /^# fixer\n/);
  for (const line of ['- Agent: Hermes Agent', '- Model: m1', '- Folder: C:\\w\\repo', '- Branch: agent/fixer-1', '- Started: 2026-11-04 14:00', '- Turns: 2', '- Tokens: 15k', '- Cost: unknown']) assert.ok(md.includes(line + '\n'), line);
  assert.match(md, /## First instruction\n\nfix the test\n/);
  assert.match(md, /## Timeline\n\n\| Time \| Call \| Result \| Duration \|\n\| --- \| --- \| --- \| --- \|\n\| 14:00:05 \| Read a\.txt \| done \| 40 ms \|\n\| 14:00:10 \| Bash npm test \| failed: exit 1 \| 4\.2 s \|\n\| 14:00:20 \| Edit a\.txt \| open \| – \|\n/);
  assert.match(md, /## Replies\n\n### 14:01:00\n\nDone\.\nTwo files changed\.\n/);
  assert.ok(!md.includes('$0.00'));
});

test('exportText: a pipe in a call, a past session with no calls, and a known cost', () => {
  const md = F.exportText({ name: 'p', cwd: 'C:\\w', startedAt: 0, turns: 1, cost: 0.256, usage: { tokens: 0 }, calls: [{ id: 'x', name: 'Bash', detail: 'a | b', t: 1000, ms: 5, ok: true }], replies: [] }, { zone: 'utc' });
  assert.match(md, /\| Bash a \\\| b \|/);
  assert.match(md, /- Cost: \$0\.26\n/);
  assert.ok(!/## Replies/.test(md));
  const bare = F.exportText({ name: 'q', cwd: '', startedAt: 0, turns: 0, cost: null, calls: [], replies: [] }, { zone: 'utc' });
  assert.match(bare, /## Timeline\n\nNo tool calls were recorded\.\n/);
});

test('exportFileName: a safe file name from the session name and the start time', () => {
  assert.equal(F.exportFileName({ name: 'My: bot/1?', startedAt: Date.UTC(2026, 10, 4, 14, 0, 0) }, 'utc'), 'my-bot-1-2026-11-04-1400.md');
  assert.equal(F.exportFileName({ name: '', startedAt: Date.UTC(2026, 10, 4, 9, 5, 0) }, 'utc'), 'session-2026-11-04-0905.md');
});

test('redactSecrets: keys, tokens and credential flags in a command become the mask; plain text stays', () => {
  const M = F.SECRET_MASK;
  assert.equal(F.redactSecrets('git status'), 'git status');
  assert.equal(F.redactSecrets(''), '');
  assert.equal(F.redactSecrets(null), '');
  assert.equal(F.redactSecrets('curl -H "Authorization: Bearer abc123def456ghi789" https://x'), `curl -H "Authorization: Bearer ${M}" https://x`);
  assert.equal(F.redactSecrets('curl -H x-office-token: 0123456789abcdef http://127.0.0.1'), `curl -H x-office-token: ${M} http://127.0.0.1`);
  assert.equal(F.redactSecrets('deploy --token s3cr3tvalue --force'), `deploy --token ${M} --force`);
  assert.equal(F.redactSecrets('PASSWORD=hunter2 run.sh'), `PASSWORD=${M} run.sh`);
  assert.equal(F.redactSecrets('echo sk-abcdefghijklmnopqrstuvwxyz0123'), `echo ${M}`);
  assert.equal(F.redactSecrets('echo AKIAABCDEFGHIJKLMNOP and ghp_' + 'a'.repeat(36)), `echo ${M} and ${M}`);
  assert.equal(F.redactSecrets('cat -----BEGIN RSA PRIVATE KEY-----'), `cat ${M}`);
});

test('exportText: a secret in a call is masked in the Markdown', () => {
  const md = F.exportText({ name: 'x', cwd: '', startedAt: 0, turns: 1, cost: 0, calls: [{ id: 'a', name: 'Bash', detail: 'deploy --token s3cr3tvalue', t: 1000, ms: 5, ok: false, err: 'bad token sk-abcdefghijklmnopqrstuvwxyz0123' }], replies: [] }, { zone: 'utc' });
  assert.ok(!md.includes('s3cr3tvalue') && !md.includes('sk-abcdef'), md);
  assert.ok(md.includes('deploy --token ' + F.SECRET_MASK), md);
});

test('redactSecrets and the notes scan agree on the key shapes', async () => {
  const { scanNote } = await import('../notes.mjs');
  for (const k of ['sk-abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(36), '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.ok(scanNote(`value ${k}`), `the notes scan misses ${k}`);
    assert.equal(F.redactSecrets(`value ${k}`), `value ${F.SECRET_MASK}`, `redactSecrets misses ${k}`);
  }
});
