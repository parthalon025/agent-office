// The skills an agent writes (#72): list, read, edit and delete in the agent's skills folder, and nothing outside it.
// Real files in a temp folder, with a real junction for the escape case. No agent, no server. Run: node --test test/skills.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkills, SkillsError, SKILL_MAX } from '../skills.mjs';

function rig() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skills-')));
  const dir = path.join(base, 'skills'), outside = path.join(base, 'outside');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  const put = (name, text) => { fs.mkdirSync(path.join(dir, ...name.split('/')), { recursive: true }); fs.writeFileSync(path.join(dir, ...name.split('/'), 'SKILL.md'), text); };
  return { base, dir, outside, put, skills: createSkills({ dir }), done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const status = (n) => (e) => e instanceof SkillsError && e.status === n;

test('list: skills one or two folders deep, with the title and description from the front matter or the first heading', () => {
  const r = rig();
  try {
    r.put('deploy', '---\nname: Deploy the site\ndescription: Steps to ship to production.\n---\n# Deploy\nrun it');
    r.put('devops/rollback', '# Roll back a release\nUse git revert.');
    r.put('devops/deep/too-deep', 'x');
    fs.mkdirSync(path.join(r.dir, 'empty'));
    fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'not a skill');
    const list = r.skills.list();
    assert.deepEqual(list.map((s) => s.name), ['deploy', 'devops/rollback']);
    assert.deepEqual([list[0].title, list[0].description], ['Deploy the site', 'Steps to ship to production.']);
    assert.deepEqual([list[1].title, list[1].description], ['Roll back a release', '']);
    assert.ok(list[0].bytes > 0 && list[0].at > 0);
  } finally { r.done(); }
});

test('list: a folder that does not exist is no skills, not an error', () => {
  const r = rig();
  try { assert.deepEqual(createSkills({ dir: path.join(r.base, 'nope') }).list(), []); } finally { r.done(); }
});

test('read and save: save replaces the text of a skill that exists; it never makes a new one', () => {
  const r = rig();
  try {
    r.put('deploy', 'old');
    assert.equal(r.skills.read('deploy').text, 'old');
    assert.equal(r.skills.save('deploy', 'new text\r\nline 2').bytes, 'new text\nline 2'.length);
    assert.equal(r.skills.read('deploy').text, 'new text\nline 2');
    assert.throws(() => r.skills.save('fresh', 'x'), status(404));
    assert.equal(fs.existsSync(path.join(r.dir, 'fresh')), false);
    assert.throws(() => r.skills.read('missing'), status(404));
  } finally { r.done(); }
});

test('save: a skill over the size cap is refused and the file stays', () => {
  const r = rig();
  try {
    r.put('deploy', 'old');
    assert.throws(() => r.skills.save('deploy', 'x'.repeat(SKILL_MAX + 1)), status(413));
    assert.equal(r.skills.read('deploy').text, 'old');
  } finally { r.done(); }
});

test('remove: the whole skill folder goes, an empty category folder goes with its last skill, the others stay', () => {
  const r = rig();
  try {
    r.put('devops/rollback', 'a');
    fs.mkdirSync(path.join(r.dir, 'devops', 'rollback', 'refs'));
    fs.writeFileSync(path.join(r.dir, 'devops', 'rollback', 'refs', 'x.md'), 'b');
    r.put('devops/deploy', 'c');
    r.put('lint', 'd');
    r.skills.remove('devops/rollback');
    assert.deepEqual(r.skills.list().map((s) => s.name), ['devops/deploy', 'lint']);
    r.skills.remove('devops/deploy');
    assert.equal(fs.existsSync(path.join(r.dir, 'devops')), false);
    assert.throws(() => r.skills.remove('devops/deploy'), status(404));
    assert.deepEqual(r.skills.list().map((s) => s.name), ['lint']);
  } finally { r.done(); }
});

test('names: only plain folder names one or two deep; no dots, no drive letters, no absolute paths, no folders that are not skills', () => {
  const r = rig();
  try {
    r.put('deploy', 'x');
    fs.writeFileSync(path.join(r.base, 'SKILL.md'), 'outside the folder');
    for (const bad of ['', '..', '../skills', 'a/../..', '/deploy', 'C:\\x', 'C:/x', 'a/b/c', '.hidden', 'a\\b', 'deploy/', 'dep loy', 'a:b']) {
      assert.throws(() => r.skills.read(bad), (e) => e instanceof SkillsError && (e.status === 400 || e.status === 404), `read ${JSON.stringify(bad)}`);
      assert.throws(() => r.skills.remove(bad), (e) => e instanceof SkillsError, `remove ${JSON.stringify(bad)}`);
    }
    assert.equal(fs.existsSync(path.join(r.base, 'SKILL.md')), true);
    assert.equal(fs.existsSync(r.dir), true);
  } finally { r.done(); }
});

test('a link out of the folder is not followed: not listed, not read, not written, and delete removes only the link', () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.outside, 'SKILL.md'), 'secret');
    fs.writeFileSync(path.join(r.outside, 'keep.txt'), 'keep');
    fs.symlinkSync(r.outside, path.join(r.dir, 'sneaky'), 'junction');
    assert.deepEqual(r.skills.list(), []);
    assert.throws(() => r.skills.read('sneaky'), status(404));
    assert.throws(() => r.skills.save('sneaky', 'pwn'), status(404));
    assert.equal(fs.readFileSync(path.join(r.outside, 'SKILL.md'), 'utf8'), 'secret');
    assert.throws(() => r.skills.remove('sneaky'), status(404));
    assert.equal(fs.existsSync(path.join(r.outside, 'keep.txt')), true, 'nothing outside was deleted');
    // a SKILL.md that is a link out of the folder
    fs.mkdirSync(path.join(r.dir, 'linked'));
    try { fs.symlinkSync(path.join(r.outside, 'SKILL.md'), path.join(r.dir, 'linked', 'SKILL.md'), 'file'); } catch { return; } // no right to make file links
    assert.throws(() => r.skills.read('linked'), status(404));
    assert.throws(() => r.skills.save('linked', 'pwn'), status(404));
    assert.equal(fs.readFileSync(path.join(r.outside, 'SKILL.md'), 'utf8'), 'secret');
  } finally { r.done(); }
});
