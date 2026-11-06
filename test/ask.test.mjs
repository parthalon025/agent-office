// The ask-first protocol (#177): one builder (server), one reader (page), tested through OfficeAsk for every kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/ask.js';

const Ask = globalThis.OfficeAsk;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_KINDS = ['merge', 'fork', 'skill', 'goal', 'handoff', 'cost'];

// What api() in page-core.js rejects with for an answer: the Error carries the status and the parsed body.
function rejected(a) {
  const j = a.body;
  const e = new Error(j.error || j.question);
  e.status = a.status; e.body = j;
  return e;
}

for (const kind of SERVER_KINDS) {
  test(`${kind}: the server builds the question and the page reads it, until the user said yes`, () => {
    const a = Ask.answer(kind, 'Do it?');
    assert.equal(a.body.confirm, kind);
    if (kind === 'cost') {
      assert.deepEqual(a, { status: 200, body: { confirm: 'cost', question: 'Do it?' } }, 'a normal answer, not an error');
      assert.equal(Ask.isQuestion(a.body), true, 'api() turns a 200 question into a rejection');
    } else {
      assert.deepEqual(a, { status: 409, body: { error: 'Do it?', confirm: kind } });
      assert.equal(Ask.isQuestion(a.body), false, 'a 409 is already a rejection');
    }
    const x = rejected(a);
    assert.deepEqual(Ask.asked(x, kind, false), { text: 'Do it?', body: a.body });
    assert.equal(Ask.asked(x, kind, true), null, 'after the yes the caller shows the error');
    assert.equal(Ask.asked(x, SERVER_KINDS.find((k) => k !== kind), false), null, 'another kind is not this question');
  });
}

test('handoff: the question carries the tasks it would create', () => {
  const tasks = [{ step: 1, title: 'a', description: 'b' }];
  const a = Ask.answer('handoff', 'Create 1 task?', { tasks });
  assert.deepEqual(Ask.asked(rejected(a), 'handoff', false).body.tasks, tasks);
});

test('pr and rm: the page asks in its own dialog; the table names them and the server cannot build them', () => {
  assert.equal(Ask.local('pr'), 'pr');
  assert.equal(Ask.local('rm'), 'rm');
  assert.throws(() => Ask.local('merge'));
  assert.throws(() => Ask.answer('pr', 'x'));
  assert.equal(Ask.asked(new Error('x'), 'pr', false), null, 'a plain error is no question');
});

test('an unknown kind is refused on both sides, and a plain error is no question', () => {
  assert.throws(() => Ask.answer('nope', 'x'));
  assert.throws(() => Ask.asked(new Error('x'), 'nope', false));
  assert.throws(() => Ask.answer('constructor', 'x'), 'no prototype name is a kind');
  assert.equal(Ask.asked(new Error('x'), 'merge', false), null);
  assert.equal(Ask.isQuestion({ ok: true }), false);
});

test('no route builds a confirm answer by hand, and no page reads one by hand', () => {
  const code = (f) => readFileSync(join(root, f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const server = ['src/server.mjs', 'src/office.mjs', 'src/office-core.mjs', 'src/schedules.mjs', 'src/room-awareness.mjs'].map(code).join('\n');
  assert.doesNotMatch(server, /e\.confirm\s*=|confirm:\s*'(merge|fork|skill|goal|handoff|cost)'\s*[,}]|e\.question\s*=/, 'server asks through askFirst');
  for (const f of ['page-core.js', 'skills.js', 'dialogs.js', 'schedules.js', 'extensions.js', 'hq.js', 'characters.js', 'reception.js', 'needs.js', 'panels.js', 'changes.js', 'screens.js', 'merge.js', 'office.js']) {
    const src = readFileSync(join(root, 'public', f), 'utf8');
    assert.doesNotMatch(src, /\.confirm\s*===\s*'(merge|fork|skill|goal|handoff|cost|pr|rm)'/, f + ' reads through OfficeAsk');
  }
  assert.match(readFileSync(join(root, 'public', 'index.html'), 'utf8'), /<script src="\/ask\.js"><\/script>/);
});
