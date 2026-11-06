// The desk terminal's timeline and the reason line of a request (#72): terminal.js is a page script, so it runs here with a bare
// `window`. No DOM and no scene: only the pure line makers (OfficeTerminal.timeline, OfficeTerminal.lines).
// Run: node --test test/terminal-timeline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../public/screen-kit.js');
await import('../public/format.js');
await import('../public/vocab.js'); // terminal.js reads the supervision words (#73) and kind words from it, as on the page
await import('../public/terminal.js');
const T = globalThis.OfficeTerminal;

const T0 = Date.UTC(2026, 10, 4, 14, 0, 0);
const base = { name: 'bot', status: 'idle', turns: 1, startedAt: T0, prompt: 'go', pending: [], questions: [], todos: [], replies: [], usage: { tokens: 0 } };

test('timeline: one line per call with the time, the time since the start, how long it ran and how it ended', () => {
  const s = { ...base, calls: [
    { id: 'b', name: 'Bash', detail: 'npm test', t: T0 + 10_000, ms: 4200, ok: false, err: 'exit 1' },
    { id: 'a', name: 'Read', detail: 'a.txt', t: T0 + 5_000, ms: 40, ok: true },
    { id: 'c', name: 'Edit', detail: 'a.txt', t: T0 + 20_000, ms: null, ok: null },
    { id: 'h', name: 'Read', detail: 'helper.txt', t: T0 + 6_000, ms: 10, ok: true, agent: 'sub1' },
  ] };
  const lines = T.timeline(s, 60);
  assert.equal(lines[0].tone, 'muted', 'a header');
  const body = lines.slice(1);
  assert.deepEqual(body.map((l) => l.tone), ['ok', 'err', 'err', 'tool'], 'oldest first; the failure is followed by its error line');
  assert.match(body[0].text.trimEnd(), /^\d\d:\d\d:\d\d  \+5 s +40 ms +Read a\.txt$/);
  assert.match(body[1].text, /\+10 s +4\.2 s +Bash npm test +failed$/);
  assert.match(body[3].text, /\+20 s +– +Edit a\.txt +\.\.\.$/);
  assert.ok(!lines.some((l) => /helper\.txt/.test(l.text)), 'a helper\'s calls are on the helper\'s own desk');
  assert.ok(lines.every((l) => l.text.length <= 60), 'no line is wider than the terminal');
});

test('timeline: no session and no calls say so', () => {
  assert.equal(T.timeline(null, 40)[0].text, 'No session at this desk.');
  assert.deepEqual(T.timeline({ ...base, calls: [] }, 40), [{ text: 'No tool calls yet.', tone: 'muted' }]);
});

test('a request shows the reason the agent gave under it', () => {
  const s = { ...base, status: 'waiting', calls: [], pending: [{ id: 'p', tool: 'Bash', detail: 'npm test', reason: 'The last run failed; I need the log.' }, { id: 'q', tool: 'Read', detail: 'a' }] };
  const ask = T.lines(s, 60).filter((l) => l.ask).map((l) => l.text);
  assert.deepEqual(ask, ['? Allow Bash: npm test?', '  Reason: The last run failed; I need the log.', '? Allow Read: a?']);
});
