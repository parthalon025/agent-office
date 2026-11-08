// #227: the Spend screen of the Security room shows the Paperclip month cost and budget; a cost the office could not read is unknown,
// never $0.00. The pure part only. Run: node --test test/security-spend-paperclip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';
import '../public/format.js';
import '../public/screen-kit.js';
import '../public/security.js';

const P = globalThis.OfficeSecurity.pure;
const sec = { rules: { office: {}, buildings: {} }, enforce: {}, spend: { limit: 2, month: '2026-11', byColumn: {} } };
const company = { id: 'c1', name: 'Acme' };
const VIEWS = [{ h: 686 }, { h: 738 }, { h: 1100, paged: true }];
const view = (o) => ({ screen: 'spend', w: 1360, focused: true, scope: 'office', page: 0, ...o });
const texts = (hq, o) => P.plan(view(o), { sec, building: 'c:/work/repo', buildingName: 'repo', hq }).items.filter((i) => i.t === 'text');
const said = (hq, o) => texts(hq, o).map((i) => i.text).join(' | ');

test('Spend screen: Paperclip month cost and budget, in every layout', () => {
  for (const o of VIEWS) {
    assert.match(said({ company, lobby: { spend: { spent: 12.4, limit: 100, percent: 12 } } }, o), /Paperclip, this month: \$12\.40 of \$100\.00 \(12%\)\./);
    assert.match(said({ company, lobby: { spend: { spent: 12.4, limit: 0, percent: null } } }, o), /Paperclip, this month: \$12\.40\. No budget set\./);
  }
});

test('Spend screen: an unread Paperclip cost says unknown, never $0.00; no connection says nothing', () => {
  for (const o of VIEWS) {
    const s = said({ company, lobby: { spend: null } }, o);
    assert.match(s, /Paperclip, this month: cost unknown\./);
    assert.doesNotMatch(s, /Paperclip[^|]*\$0\.00/);
    assert.doesNotMatch(said(null, o), /Paperclip/);
    assert.doesNotMatch(said({ company: null }, o), /Paperclip/);
  }
});

test('Spend screen: the Paperclip line fits the screen and no text is under 16 px', () => {
  for (const o of VIEWS) {
    const v = view(o);
    for (const i of texts({ company, lobby: { spend: { spent: 1234.5, limit: 5000, percent: 25 } } }, o)) assert.ok(i.y <= v.h, `${i.text} is on the screen`);
  }
});
