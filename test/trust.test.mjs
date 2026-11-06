// Earned trust (#153): the rule proposer, the trust card, and withdraw. Pure: history fixtures in, proposals out.
// Run: node --test test/trust.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRules, setRule } from '../security.mjs';
import { patternOf, record, cleanTrust, propose, cards, grant, withdraw, MIN_APPROVALS, LEDGER_MAX } from '../trust.mjs';

const B = 'e:/work/app';
const d = (over = {}) => ({ at: 1, col: 'claude-code', building: B, row: 'shell', pattern: 'npm test', allow: true, risk: 'medium', ...over });
const many = (n, over) => Array.from({ length: n }, (_, i) => d({ at: i + 1, ...over }));
const none = cleanRules(null);

test('patternOf: the first two words of a plain command, nothing for a compound one', () => {
  assert.equal(patternOf('Bash', { command: 'npm test --silent' }), 'npm test');
  assert.equal(patternOf('Bash', { command: 'git' }), 'git');
  assert.equal(patternOf('Bash', { command: 'npm test && rm -rf x' }), null);
  assert.equal(patternOf('Bash', { command: 'echo $(whoami)' }), null);
  assert.equal(patternOf('Bash', { command: 'a | b' }), null);
  assert.equal(patternOf('Edit', { file_path: 'x' }), 'Edit');
  assert.equal(patternOf('Bash', {}), null);
});

test('propose: five clean approvals in one cell give one building-scope Allow proposal that names its evidence', () => {
  const p = propose(many(MIN_APPROVALS), none, {});
  assert.equal(p.length, 1);
  assert.deepEqual({ col: p[0].col, building: p[0].building, row: p[0].row, value: p[0].value, pattern: p[0].pattern, count: p[0].count }, { col: 'claude-code', building: B, row: 'shell', value: 'allow', pattern: 'npm test', count: MIN_APPROVALS });
  assert.match(p[0].text, /npm test/);
});

test('propose: fewer than the minimum, high risk or an unpatterned approval give nothing; a decline ends the streak', () => {
  assert.equal(propose(many(MIN_APPROVALS - 1), none, {}).length, 0);
  assert.equal(propose(many(MIN_APPROVALS, { risk: 'high' }), none, {}).length, 0);
  assert.equal(propose(many(MIN_APPROVALS, { pattern: null }), none, {}).length, 0);
  const declined = [...many(MIN_APPROVALS), d({ at: 99, allow: false })];
  assert.equal(propose(declined, none, {}).length, 0, 'a decline ends the streak');
  assert.equal(propose([...declined, ...many(MIN_APPROVALS).map((x) => ({ ...x, at: 100 + x.at }))], none, {}).length, 1, 'a new clean streak counts');
});

test('propose: a high-risk approval inside the streak resets it', () => {
  const l = [...many(3), d({ at: 50, risk: 'high' }), ...many(3).map((x) => ({ ...x, at: 60 + x.at }))];
  assert.equal(propose(l, none, {}).length, 0);
});

test('propose: never for the Secrets rows, the Agents rows or an unknown row', () => {
  for (const row of ['settings', 'secrets', 'ungated', 'no-cost', 'nonsense']) assert.equal(propose(many(9, { row }), none, {}).length, 0, row);
});

test('propose: nothing where the cell is already Allow or Deny', () => {
  const allowed = setRule(none, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(propose(many(9), allowed, {}).length, 0);
  const denied = setRule(none, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(propose(many(9), denied, {}).length, 0);
  assert.equal(propose(many(9, { row: 'read-inside', col: 'agent-framework' }), none, {}).length, 1, 'a real cell still proposes');
});

test('propose: a dismissed proposal stays away', () => {
  const id = propose(many(6), none, {})[0].id;
  assert.equal(propose(many(6), none, { dismissed: { [id]: 1 } }).length, 0);
});

test('record: caps the ledger and drops a dismissal on a decline', () => {
  let t = cleanTrust(null);
  for (let i = 0; i < LEDGER_MAX + 5; i++) t = record(t, d({ at: i }));
  assert.equal(t.ledger.length, LEDGER_MAX);
  const id = propose(many(6), none, {})[0].id;
  t = { ...cleanTrust(null), dismissed: { [id]: 5 } };
  t = record(t, d({ allow: false }));
  assert.deepEqual(t.dismissed, {});
});

test('cleanTrust: keeps only well-formed entries and no prototype keys', () => {
  const t = cleanTrust({ ledger: [d(), { junk: 1 }, null], grants: [{ id: 'a', col: 'claude-code', building: B, row: 'shell', from: 'ask', at: 1 }, { id: 'b' }], dismissed: JSON.parse('{"__proto__":1,"ok":2}') });
  assert.equal(t.ledger.length, 1);
  assert.equal(t.grants.length, 1);
  assert.deepEqual(Object.keys(t.dismissed), ['ok']);
});

test('grant and withdraw: withdraw restores the cell the user had, an unset cell goes back to default', () => {
  const t0 = cleanTrust(null);
  const p = propose(many(6), none, {})[0];
  const g = grant(none, t0, p, 100, true);
  assert.equal(g.rules.buildings[B]['shell|claude-code'], 'allow');
  assert.equal(g.trust.grants.length, 1);
  const w = withdraw(g.rules, g.trust, p.id);
  assert.equal(w.rules.buildings[B], undefined, 'the override is gone: the default applies again');
  assert.equal(w.trust.grants.length, 0);
  const asked = setRule(none, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'ask' }).rules;
  const g2 = grant(asked, t0, p, 100, true);
  assert.equal(g2.trust.grants[0].from, 'ask');
  assert.equal(withdraw(g2.rules, g2.trust, p.id).rules.buildings[B]['shell|claude-code'], 'ask');
});

test('grant: needs the painted Confirm (a looser change), like every rule', () => {
  const p = propose(many(6), none, {})[0];
  assert.throws(() => grant(none, cleanTrust(null), p, 1, false), (e) => e.status === 409);
});

test('withdraw: an unknown id is a 404; a cell the user changed since is left alone', () => {
  assert.throws(() => withdraw(none, cleanTrust(null), 'nope'), (e) => e.status === 404);
  const p = propose(many(6), none, {})[0];
  const g = grant(none, cleanTrust(null), p, 1, true);
  const denied = setRule(g.rules, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  const w = withdraw(denied, g.trust, p.id);
  assert.equal(w.rules.buildings[B]['shell|claude-code'], 'deny');
  assert.equal(w.trust.grants.length, 0);
});

test('cards: clean runs, declined calls and rules granted per agent kind', () => {
  const trust = { ...cleanTrust(null), ledger: [d(), d({ allow: false }), d({ allow: false, col: 'nope' })], grants: [{ id: 'g', col: 'claude-code', building: B, row: 'shell', from: null, at: 1 }] };
  const runs = [{ col: 'claude-code', failed: false }, { col: 'claude-code', failed: true }, { col: 'claude-code', failed: false }];
  const all = cards(trust, runs);
  const c = all.find((x) => x.col === 'claude-code');
  assert.deepEqual({ clean: c.clean, runs: c.runs, declined: c.declined, granted: c.granted }, { clean: 2, runs: 3, declined: 1, granted: 1 });
  assert.ok(!all.some((x) => x.col === 'nope'), 'only known kinds');
});
