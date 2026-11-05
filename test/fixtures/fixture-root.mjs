// A made-up session root for the rating tests (#127). risk.mjs rates an edit in the office's own folder as settings that run
// code (ownCode, #120), so a fixed root like /work/repo fails when the checkout sits in /work. The root is a folder at the
// top of the drive, away from any .claude part, so it is not in the office folder (the tests assert it). Plain Node, no I/O.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_ROOT = path.join(path.parse(OFFICE).root, 'ao-fixture-root', 'repo');

export const holds = (dir, target) => {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
