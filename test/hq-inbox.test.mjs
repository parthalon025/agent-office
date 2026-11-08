// The Paperclip inbox in the one queue (#210, spec #191): what Paperclip holds for the user (pending approvals, tasks assigned to a person)
// from the model, the connected view and the page store (Needs you). No paid call: the fake Paperclip. Run: node --test test/hq-inbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';
import { inboxOf, INBOX_CAP, paperclipLinker } from '../src/hq-model.mjs';
import { createHq } from '../src/paperclip.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

test('inbox: pending approvals, then tasks assigned to a person, oldest first; names only', () => {
  const agents = [{ id: 'g', name: 'Grace' }];
  const approvals = [{ id: 'p1', type: 'hire_agent', requestedByAgentId: 'g', at: 2000, payload: { secret: 'x' } }, { id: 'p2', type: 'budget_change', requestedByAgentId: null, at: 500 }];
  const issues = [
    { id: 'i1', identifier: 'ACM-1', title: 'Review the plan', status: 'in_review', assigneeUserId: 'u1', updatedAt: '1970-01-01T00:00:01.000Z' },
    { id: 'i2', title: 'Agent task', status: 'todo', assigneeAgentId: 'g' },
    { id: 'i3', title: 'Done', status: 'done', assigneeUserId: 'u1' },
    { id: 'i4', title: 'Stuck', status: 'blocked', assigneeUserId: 'u1', createdAt: '1970-01-01T00:00:03.000Z' },
  ];
  const r = inboxOf({ agents, approvals, issues });
  assert.deepEqual(r.map((x) => [x.id, x.kind, x.text]), [
    ['approval:p2', 'approval', 'Approval: budget change'], ['issue:i1', 'issue', 'Task for you: ACM-1 Review the plan'],
    ['approval:p1', 'approval', 'Approval from Grace: hire agent'], ['issue:i4', 'issue', 'Task for you (blocked): Stuck']]);
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(r.find((x) => x.id === 'approval:p1').approval, 'p1');
  assert.equal(r.find((x) => x.id === 'approval:p2').approval, 'p2');
  assert.equal(Object.hasOwn(r.find((x) => x.kind === 'issue'), 'approval'), false, 'a task is not an approval');
  assert.equal(inboxOf({ agents, approvals: [{ id: 'a/b', type: 't', at: 1 }], issues: [] })[0].approval, null, 'a bad id is not sent');
  assert.equal(inboxOf({ agents, approvals: null, issues: null }), null, 'unread is unknown, not empty');
  assert.deepEqual(inboxOf({ agents, approvals: [], issues: null }), []);
  const many = inboxOf({ agents, approvals: Array.from({ length: 50 }, (_, n) => ({ id: 'a' + n, type: 't', at: n })), issues: [] });
  assert.equal(many.length, INBOX_CAP);
});

test('the view of a connected company carries the inbox: the pending approval and a task for the user', async () => {
  const seed = DEMO();
  seed.issues.push({ id: 'i1000000-0000-4000-8000-000000000099', companyId: seed.companies[0].id, identifier: 'ACM-99', title: 'Decide the logo', status: 'in_review', assigneeUserId: 'board-1', assigneeAgentId: null, assigneeAdapterOverrides: null });
  const pc = await startFakePaperclip(seed);
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => ({}) });
  try {
    await hq.connect({ url: pc.url });
    for (let n = 0; n < 200 && hq.state() !== 'on'; n++) await new Promise((r) => setTimeout(r, 25));
    const inbox = hq.view().inbox;
    assert.deepEqual(inbox.map((x) => x.kind).sort(), ['approval', 'issue']);
    assert.ok(inbox.find((x) => x.kind === 'approval').text.includes('hire agent'));
    assert.ok(inbox.find((x) => x.kind === 'issue').text.includes('Decide the logo'));
    assert.ok(!JSON.stringify(hq.view()).includes('do-not-show'), 'no payload in the view');
  } finally { await hq.disconnect(); await pc.close(); }
});

test('link out (#225): the server builds the Paperclip page of an approval and a task; no key, loopback only, prefix first', () => {
  const link = paperclipLinker('http://127.0.0.1:3100', 'ACM');
  assert.equal(link('approval', 'p1'), 'http://127.0.0.1:3100/ACM/approvals/p1');
  assert.equal(link('issue', 'ACM-12'), 'http://127.0.0.1:3100/ACM/issues/ACM-12');
  assert.equal(link('approval', 'a/b'), null);
  assert.equal(link('other', 'p1'), null);
  assert.equal(paperclipLinker('http://127.0.0.1:3100', '')('approval', 'p1'), null, 'no company prefix: no link');
  assert.equal(paperclipLinker('http://evil.example:3100', 'ACM')('approval', 'p1'), null, 'not loopback');
  assert.equal(paperclipLinker('http://user:pw@127.0.0.1:3100', 'ACM')('approval', 'p1'), null, 'no credentials in an address');
  const agents = [{ id: 'g', name: 'Grace' }];
  const r = inboxOf({ agents, link, approvals: [{ id: 'p1', type: 't', at: 1 }], issues: [{ id: 'i1', identifier: 'ACM-1', title: 'T', status: 'todo', assigneeUserId: 'u', updatedAt: '2026-01-01' }] });
  assert.equal(r.find((x) => x.kind === 'approval').link, 'http://127.0.0.1:3100/ACM/approvals/p1');
  assert.equal(r.find((x) => x.kind === 'issue').link, 'http://127.0.0.1:3100/ACM/issues/ACM-1');
  assert.equal(inboxOf({ agents, approvals: [{ id: 'p1', type: 't', at: 1 }], issues: [] })[0].link, null, 'no linker: no link');
});

test('the connected view carries the links of the inbox and the lobby approvals', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => ({}) });
  try {
    await hq.connect({ url: pc.url });
    for (let n = 0; n < 200 && hq.state() !== 'on'; n++) await new Promise((r) => setTimeout(r, 25));
    const v = hq.view(), a = v.inbox.find((x) => x.kind === 'approval');
    assert.equal(a.link, `${pc.url}/ACM/approvals/${a.approval}`);
    const l = v.lobby.approvals.items[0];
    assert.equal(l.link, `${pc.url}/ACM/approvals/${l.id}`);
    assert.equal(l.approval, l.id);
    assert.ok(!/pcp_|token|key/i.test(a.link));
  } finally { await hq.disconnect(); await pc.close(); }
});
