// The expectations of test/smoke.mjs that need no paid run, as pure functions. The smoke script and test/smoke-checks.test.mjs
// both call them, so a wrong expectation fails an unpaid test first (#188).

/** True when `cwd` is the worktree folder `<name of repoDir>.worktrees/<slug>` that the office makes next to the repository. */
export function inWorktreeOf(cwd, repoDir, slug) {
  const norm = (t) => String(t || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const repoName = norm(repoDir).split('/').pop();
  return norm(cwd).includes(`/${repoName}.worktrees/${slug.toLowerCase()}`);
}

/** The figures of the room a session sits in: the snapshot's `figures`, by that session's notes key. */
export function roomFiguresOf(snapshot, uid) {
  const s = (snapshot.sessions || []).find((x) => x.uid === uid);
  return s?.place ? (snapshot.figures || {})[s.place.noteKey] : undefined;
}

/** True when the room has no session working and none waiting. */
export const roomAtRest = (fig) => !!fig && fig.working === 0 && fig.waiting === 0;
