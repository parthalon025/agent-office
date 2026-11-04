import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotes, merge3, NOTES_MAX, PIN_MAX, NotesError } from '../notes.mjs';

const K = 'repo|w-room-1234abcd';
function make() {
  let t = 1000;
  const notes = {}, pins = {};
  const n = createNotes({ notes, pins, now: () => ++t });
  return { n, notes, pins };
}

test('read: a room with no notes has version 0 and empty text', () => {
  const { n } = make();
  assert.deepEqual(n.read(K), { text: '', version: 0, at: 0 });
});

test('save: each change gives the next version number', () => {
  const { n } = make();
  assert.equal(n.save(K, 'a', 0).version, 1);
  assert.equal(n.save(K, 'a\nb', 1).version, 2);
  assert.equal(n.read(K).text, 'a\nb');
  assert.equal(n.read(K).version, 2);
});

test('save: the same text again keeps the version', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  assert.equal(n.save(K, 'a', 1).version, 1);
});

test('save without a base overwrites', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  const r = n.save(K, 'z');
  assert.equal(r.text, 'z');
  assert.equal(r.merged, false);
});

test('old base: the user text is merged with what changed since', () => {
  const { n } = make();
  n.save(K, 'one\ntwo\nthree', 0);               // v1
  n.append(K, 'Ada', 'check CI');                // v2, agent line
  const r = n.save(K, 'one\ntwo changed\nthree', 1); // user edited from v1
  assert.equal(r.merged, true);
  assert.equal(r.text, 'one\ntwo changed\nthree\nAda: check CI');
  assert.equal(n.read(K).version, r.version);
});

test('agent append during an edit: the append stays and the user deletion stays', () => {
  const { n } = make();
  n.save(K, 'keep\ndrop\nlast', 0);              // v1
  n.append(K, 'Bo', 'new line');                 // v2
  const r = n.save(K, 'keep\nlast', 1);          // user deleted "drop"
  assert.equal(r.text, 'keep\nlast\nBo: new line');
});

test('two agent appends in a row, user edit based on the first version', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  n.append(K, 'Ada', 'x');
  n.append(K, 'Bo', 'y');
  const r = n.save(K, 'a\nmine', 1);
  assert.equal(r.text, 'a\nmine\nAda: x\nBo: y');
});

test('clear then save: a cleared board keeps its counter', () => {
  const { n } = make();
  n.save(K, 'a\nb', 0);
  const c = n.save(K, '', 1);
  assert.equal(c.version, 2);
  assert.equal(n.read(K).text, '');
  assert.equal(n.read(K).at, 0);
  const s = n.save(K, 'fresh', c.version);
  assert.equal(s.version, 3);
  assert.equal(n.read(K).text, 'fresh');
});

test('clear while an agent appends: the user deletion stays, the agent line stays', () => {
  const { n } = make();
  n.save(K, 'a\nb', 0);                          // v1
  n.append(K, 'Ada', 'late');                    // v2
  const r = n.save(K, '', 1);                    // user cleared from v1
  assert.equal(r.text, 'Ada: late');
});

test('a version does not come back after a clear', () => {
  const { n } = make();
  n.save(K, 'a', 0);                             // v1
  n.save(K, '', 1);                              // v2, cleared
  n.append(K, 'Ada', 'x');                       // v3
  assert.equal(n.read(K).version, 3);
  // an editor still on v1 merges against v1, not against a new board that has the same number
  const r = n.save(K, 'a\nmine', 1);
  assert.match(r.text, /mine/);
  assert.match(r.text, /Ada: x/);
});

test('the cap: a save over the limit is refused and nothing changes', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  assert.throws(() => n.save(K, 'x'.repeat(NOTES_MAX + 1), 1), (e) => e instanceof NotesError && e.status === 413);
  assert.equal(n.read(K).text, 'a');
  assert.equal(n.save(K, 'x'.repeat(NOTES_MAX), 1).version, 2);
});

test('the cap: an append that would pass the limit is refused', () => {
  const { n } = make();
  n.save(K, 'x'.repeat(NOTES_MAX - 5), 0);
  assert.throws(() => n.append(K, 'Ada', 'too long for the rest'), (e) => e.status === 413);
  assert.equal(n.read(K).text.length, NOTES_MAX - 5);
});

test('the cap: a merge that would pass the limit is refused', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  n.append(K, 'Ada', 'y'.repeat(100));
  assert.throws(() => n.save(K, 'a\n' + 'x'.repeat(NOTES_MAX - 20), 1), (e) => e.status === 413);
});

test('name prefix: every appended line starts with the session name', () => {
  const { n } = make();
  const r = n.append(K, 'Ada', 'one\n\n  two  \r\nthree');
  assert.equal(r.line, 'Ada: one\nAda: two\nAda: three');
  assert.equal(n.read(K).text, 'Ada: one\nAda: two\nAda: three');
  assert.equal(n.read(K).by, 'Ada');
  n.append(K, 'Bo', 'x');
  assert.equal(n.read(K).text.split('\n').pop(), 'Bo: x');
});

test('append: empty text is refused', () => {
  const { n } = make();
  assert.throws(() => n.append(K, 'Ada', ' \n '), (e) => e.status === 400);
});

test('replace: returns the old text; empty text clears', () => {
  const { n } = make();
  n.save(K, 'old', 0);
  const r = n.replace(K, 'Ada', 'new');
  assert.equal(r.old, 'old');
  assert.equal(n.read(K).text, 'new');
  const c = n.replace(K, 'Ada', '');
  assert.equal(c.cleared, true);
  assert.equal(n.read(K).text, '');
});

test('delete merge: both sides delete the same line', () => {
  assert.equal(merge3('a\nb\nc', 'a\nc', 'a\nc\nd'), 'a\nc\nd');
  assert.equal(merge3('a\nb\nc', 'a\nc', 'a\nc'), 'a\nc');
});

test('delete merge: user deletes one line, agent changes another', () => {
  assert.equal(merge3('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nc\nD'), 'a\nc\nD');
  // next to each other the two edits meet: the user result stays and the agent line follows
  assert.equal(merge3('a\nb\nc', 'a\nc', 'a\nb\nC'), 'a\nc\nC');
});

test('change merge: user changes one line, agent changes another', () => {
  assert.equal(merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC'), 'A\nb\nC');
});

test('change merge: both change the same line, the user line wins and the agent line follows', () => {
  assert.equal(merge3('a\nb\nc', 'a\nUSER\nc', 'a\nAGENT\nc'), 'a\nUSER\nAGENT\nc');
});

test('change merge: the agent deletes a line the user did not touch', () => {
  assert.equal(merge3('a\nb\nc', 'a\nb\nc\nd', 'a\nc'), 'a\nc\nd');
});

test('base that is gone: the server text plus the user lines it does not have', () => {
  const { n, notes } = make();
  notes[K] = { text: 'server', at: 5, v: 9 };    // as loaded from state.json: no history in memory
  const r = n.save(K, 'server\nmine', 3);
  assert.equal(r.merged, true);
  assert.equal(r.text, 'server\nmine');
});

test('old state files: a note with no version counts as version 1', () => {
  const { n, notes } = make();
  notes[K] = { text: 'old', at: 5 };
  assert.equal(n.read(K).version, 1);
  assert.equal(n.save(K, 'old\nnew', 1).version, 2);
});

test('pin: set, replace, clear, and one line only', () => {
  const { n, pins } = make();
  assert.equal(n.pin(K, 'Ada', '  hello\n\tworld\u0007 '), 'set');
  assert.equal(pins[K].text, 'hello world');
  assert.equal(pins[K].by, 'Ada');
  assert.equal(n.pinOf(K).text, 'hello world');
  assert.equal(n.pin(K, 'Bo', ''), 'cleared');
  assert.equal(n.pinOf(K), null);
  assert.equal(n.pin(K, 'Bo', ' '), 'none');
});

test('pin: the cap', () => {
  const { n } = make();
  assert.throws(() => n.pin(K, 'Ada', 'x'.repeat(PIN_MAX + 1)), (e) => e.status === 413);
  assert.equal(n.pin(K, 'Ada', 'x'.repeat(PIN_MAX)), 'set');
});

test('boards are separate per key', () => {
  const { n } = make();
  n.save(K, 'a', 0);
  assert.equal(n.read('other|x').text, '');
});
