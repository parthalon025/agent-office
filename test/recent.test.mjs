import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { addRecent, cleanRecent, recentChoices } from '../src/recent.mjs';

test('recent folders: one form, no duplicates in any case or slash, newest first', () => {
  let list = [];
  list = addRecent(list, 'E:/pensiv/');
  list = addRecent(list, 'e:\\PENSIV');
  assert.equal(list.length, 1);
  assert.equal(list[0], path.win32.normalize('e:\\PENSIV'));
  list = addRecent(list, 'E:\\agent-office');
  assert.deepEqual(list.map((d) => d.toLowerCase()), [path.win32.normalize('E:\\agent-office').toLowerCase(), path.win32.normalize('e:\\pensiv').toLowerCase()]);
  assert.equal(addRecent(list, 'E:\\x', 2).length, 2);
});

test('clean recent folders drops duplicates that were stored in different forms', () => {
  const out = cleanRecent(['E:/pensiv', 'E:\\pensiv\\', 'E:\\other', '', null]);
  assert.equal(out.length, 2);
  assert.equal(out[1], path.win32.normalize('E:\\other'));
});

test('folder choices: the shown folder first, each folder once in any case or slash, at most the cap', () => {
  const out = recentChoices(['E:\\pensiv', 'e:/agent-office/', 'E:\\other'], 'E:/PENSIV/');
  assert.deepEqual(out.map((d) => d.toLowerCase()), ['e:\\pensiv', 'e:\\agent-office', 'e:\\other']);
  assert.equal(recentChoices(['E:\\a', 'E:\\b', 'E:\\c'], '', 2).length, 2);
  assert.deepEqual(recentChoices(undefined, ''), []);
});

test('recent folders leave out agent room folders (<repo>.worktrees/<name>) and the old .agent-office/worktrees ones', () => {
  // place.mjs keeps folders in Windows form on every host, so the test builds Windows paths too (Linux CI).
  const top = path.win32.resolve('C:\\pensiv'), holder = top + '.worktrees';
  const room = path.win32.join(holder, 'bot-1'), deep = path.win32.join(room, 'src');
  const old = path.win32.join(top, '.agent-office', 'worktrees', 'x');
  const upper = path.win32.join(holder.toUpperCase(), 'Other'), lookalike = top + '.worktrees.notes';
  assert.deepEqual(addRecent([top], room), [top], 'an agent room is not added');
  assert.deepEqual(addRecent([], deep), [], 'nor a folder inside one');
  assert.deepEqual(cleanRecent([top, room, old, upper, lookalike]), [top, lookalike]);
  assert.deepEqual(recentChoices([room, top], deep), [top], 'the shown building in a room is no choice either');
  assert.deepEqual(addRecent([], holder), [holder], 'the folder that holds the rooms is a plain folder');
});

