// A fake Paperclip server for the HQ tests (#76): the REST routes the office reads, the writes it may send (the agent PATCH, tasks, comments, approval decisions), and the live
// events WebSocket (/api/companies/{id}/events/ws), and GET /api/agents/:id (Supervise reads the agent again before its PATCH).
// Not a recording: the routes, the agent, issue and routine fields and the
// event shapes follow the Paperclip source (0.3.1: server/src/routes/{agents,issues,routines,companies,health}.ts,
// server/src/realtime/live-events-ws.ts, server/src/services/heartbeat.ts publishLiveEvent calls, packages/shared/src/types).
// PATCH /api/agents/:id merges adapterConfig key by key, as Paperclip does without replaceAdapterConfig, and logs activity.
// GET /api/companies/:id/agents answers 400 to any query parameter, as Paperclip does.
//
// In a test: const pc = await startFakePaperclip({ companies, agents, ... }); pc.url, pc.requests (every request: method,
// path, body), pc.emit(type, payload), pc.drop() (close the event sockets: the office should come back), pc.close(), and
// pc.afterPatch = (agent) => { ... } (runs right after a PATCH is answered: a change saved in Paperclip at the same time).
// By hand (the browser check): node test/fixtures/fake-paperclip.mjs [port] [--hooks <office hooks file>] starts the demo
// company on 127.0.0.1 and prints its address; Ctrl+C stops it. With --hooks, Ada is already supervised with that file.
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// AGENT_ROLES of packages/shared/src/constants.ts (0.3.1): the role of an agent is this enum. There is no 'manager'.
const AGENT_ROLES = ['ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general'];

// One text frame from the server (not masked), RFC 6455 5.2.
function frame(text, opcode = 0x1) {
  const data = Buffer.from(text);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, data]);
}
// Client frames (masked): answer a ping, close on a close. Text from the client is not expected (Paperclip ignores it too).
function onClientData(sock, buf) {
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f, masked = buf[i + 1] & 0x80;
    let n = buf[i + 1] & 0x7f, at = i + 2;
    if (n === 126) { n = buf.readUInt16BE(at); at += 2; } else if (n === 127) { n = Number(buf.readBigUInt64BE(at)); at += 8; }
    const mask = masked ? buf.subarray(at, at + 4) : null;
    at += masked ? 4 : 0;
    const body = Buffer.from(buf.subarray(at, at + n));
    if (mask) for (let k = 0; k < body.length; k++) body[k] ^= mask[k % 4];
    if (op === 0x8) { try { sock.end(frame('', 0x8)); } catch { /* gone */ } return; }
    if (op === 0x9) sock.write(frame(body.toString(), 0xa));
    i = at + n;
  }
}

// The HQ read model's data (#197): who reports to whom, goals, pending approvals, activity, cost summary and secret names. Shapes as
// recorded in test/fixtures/paperclip-shapes.json (from the Paperclip source: routes/{goals,approvals,activity,costs,secrets}.ts).
const withHq = (d) => {
  const [grace, ada, linus] = d.agents, companyId = d.companies[0].id;
  ada.reportsTo = grace.id; linus.reportsTo = ada.id;
  return { ...d,
    goals: [{ id: 'g1000000-0000-4000-8000-000000000001', companyId, title: 'Ship the Q1 roadmap', description: null, level: 'company', status: 'active', parentId: null, ownerAgentId: grace.id },
      { id: 'g1000000-0000-4000-8000-000000000002', companyId, title: 'Health route', description: null, level: 'task', status: 'planned', parentId: 'g1000000-0000-4000-8000-000000000001', ownerAgentId: ada.id }],
    approvals: [{ id: 'p1000000-0000-4000-8000-000000000001', companyId, type: 'hire_agent', status: 'pending', requestedByAgentId: grace.id, requestedByUserId: null, payload: { name: 'Margaret', secretHint: 'do-not-show' }, createdAt: '2026-11-05T10:00:00.000Z' }],
    activity: [{ id: 'l1', companyId, actorType: 'agent', actorId: ada.id, action: 'issue.updated', entityType: 'issue', entityId: d.issues[0].id, agentId: ada.id, runId: null, details: { note: 'do-not-show' }, createdAt: '2026-11-06T08:00:00.000Z' },
      { id: 'l2', companyId, actorType: 'user', actorId: 'board', action: 'agent.updated', entityType: 'agent', entityId: ada.id, agentId: null, runId: null, details: {}, createdAt: '2026-11-06T07:00:00.000Z' }],
    costs: { companyId, spendCents: 1240, budgetCents: 10000, utilizationPercent: 12.4 },
    costMonths: {
      '2026-11': { agents: [{ agentId: ada.id, agentName: 'Ada', agentStatus: 'idle', costCents: 830, inputTokens: 1000, outputTokens: 200 }, { agentId: grace.id, agentName: 'Grace', agentStatus: 'idle', costCents: 410, inputTokens: 500, outputTokens: 90 }],
        projects: [{ projectId: 'pr1', projectName: 'Web', costCents: 1240, inputTokens: 1500, outputTokens: 290 }] },
      '2026-10': { agents: [{ agentId: ada.id, agentName: 'Ada', agentStatus: 'idle', costCents: 2000, inputTokens: 0, outputTokens: 0 }], projects: [] },
    },
    budgets: { companyId, policies: [{ policyId: 'bp1', companyId, scopeType: 'company', scopeId: companyId, scopeName: 'Acme Robotics', metric: 'billed_cents', windowKind: 'calendar_month_utc', amount: 10000, observedAmount: 1240, utilizationPercent: 12.4, status: 'ok', isActive: true },
      { policyId: 'bp2', companyId, scopeType: 'agent', scopeId: ada.id, scopeName: 'Ada', metric: 'billed_cents', windowKind: 'calendar_month_utc', amount: 5000, observedAmount: 4500, utilizationPercent: 90, status: 'warning', isActive: true }],
      activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 },
    skills: [{ id: 'k1', companyId, key: 'acme/review', slug: 'review', name: 'Code review', description: 'How we review a change', sourceType: 'local_path', sourceLocator: 'C:/secret-path', sourceRef: null, trustLevel: 'markdown_only', fileInventory: [{ path: 'SKILL.md', kind: 'skill', content: 'do-not-show' }], categories: [] }],
    plugins: [{ id: 'pl1', pluginKey: 'acme.linear', packageName: '@acme/plugin-linear', version: '1.2.0', apiVersion: 1, categories: [], manifestJson: { secretHint: 'do-not-show' }, status: 'ready', installOrder: 1, packagePath: null, lastError: null }],
    adapters: [{ type: 'claude_local', label: 'Claude Code', source: 'builtin', modelsCount: 3, loaded: true, disabled: false, capabilities: {} }, { type: 'agent_office', label: 'Agent Office', source: 'external', modelsCount: 0, loaded: true, disabled: false, version: '0.1.0', packageName: 'agent-office-adapter', capabilities: {} }],
    // company admin (#213): shapes of routes/access.ts (an invite has a tokenHash in the table; the list never carries the token)
    invites: [{ id: 'v1000000-0000-4000-8000-000000000001', companyId, inviteType: 'company_join', allowedJoinTypes: 'human', humanRole: 'operator', inviteMessage: null, state: 'active', expiresAt: '2026-11-13T10:00:00.000Z', createdAt: '2026-11-06T10:00:00.000Z', tokenHash: 'do-not-show' }],
    joinRequests: [{ id: 'j1000000-0000-4000-8000-000000000001', companyId, inviteId: 'v1000000-0000-4000-8000-000000000001', requestType: 'human', status: 'pending_approval', requestIp: '203.0.113.9', requestingUserId: 'u9', requestEmailSnapshot: 'sam@example.com', agentName: null, createdAt: '2026-11-06T11:00:00.000Z' }],
    members: [{ id: 'm1000000-0000-4000-8000-000000000001', companyId, principalType: 'user', principalId: 'u1', status: 'active', membershipRole: 'owner', user: { id: 'u1', name: 'Justin', email: 'j@example.com' }, grants: [] },
      { id: 'm1000000-0000-4000-8000-000000000002', companyId, principalType: 'user', principalId: 'u2', status: 'active', membershipRole: 'viewer', user: { id: 'u2', name: 'Pat', email: 'pat@example.com' }, grants: [] }],
    secrets: [{ id: 's1', companyId, name: 'GITHUB_TOKEN', provider: 'local_encrypted', description: null, latestVersion: 1, value: 'do-not-show' }],
  };
};
export const DEMO = (hooksFile = null) => withHq(DEMO0(hooksFile));
const DEMO0 = (hooksFile = null) => {
  const companyId = 'c0ffee00-0000-4000-8000-000000000001';
  const agent = (o) => ({ companyId, urlKey: o.name.toLowerCase(), title: null, icon: null, status: 'idle', reportsTo: null, capabilities: null, adapterType: 'claude_local', runtimeConfig: { heartbeat: { enabled: false } }, budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null, pausedAt: null, permissions: { canCreateAgents: false }, lastHeartbeatAt: null, metadata: null, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z', ...o });
  return {
    companies: [{ id: companyId, name: 'Acme Robotics', status: 'active', budgetMonthlyCents: 10000, spentMonthlyCents: 1240 }],
    agents: [
      // the Paperclip default since 2026.10: claude_local on the ACP engine, which approves every call
      agent({ id: 'a1000000-0000-4000-8000-000000000001', name: 'Grace', role: 'ceo', adapterConfig: { cwd: 'C:/work/acme', model: 'sonnet' }, budgetMonthlyCents: 3000, spentMonthlyCents: 410, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } }, lastHeartbeatAt: '2026-11-05T08:30:00.000Z' }),
      agent({ id: 'a1000000-0000-4000-8000-000000000002', name: 'Ada', role: 'engineer', title: 'Backend engineer',
        adapterConfig: hooksFile ? { cwd: 'C:/work/acme', model: 'haiku', engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--permission-mode', 'default', '--settings', hooksFile] } : { cwd: 'C:/work/acme', model: 'haiku', engine: 'cli', extraArgs: ['--max-turns', '8'] },
        budgetMonthlyCents: 5000, spentMonthlyCents: 830 }),
      agent({ id: 'a1000000-0000-4000-8000-000000000003', name: 'Linus', role: 'devops', adapterType: 'codex_local', adapterConfig: { cwd: 'C:/work/acme' }, status: 'running', budgetMonthlyCents: 2000, spentMonthlyCents: 0 }),
    ],
    issues: [
      { id: 'i1000000-0000-4000-8000-000000000012', companyId, identifier: 'ACM-12', title: 'Add a health route to the API', status: 'in_progress', assigneeAgentId: 'a1000000-0000-4000-8000-000000000002', assigneeAdapterOverrides: null },
      { id: 'i1000000-0000-4000-8000-000000000013', companyId, identifier: 'ACM-13', title: 'Plan the Q1 roadmap', status: 'todo', assigneeAgentId: 'a1000000-0000-4000-8000-000000000001', assigneeAdapterOverrides: null },
    ],
    routines: [
      { id: 'r1000000-0000-4000-8000-000000000001', companyId, title: 'Weekly status report', status: 'active', env: null, assigneeAgentId: 'a1000000-0000-4000-8000-000000000001', lastTriggeredAt: '2026-11-03T09:00:00.000Z',
        triggers: [{ id: 't1', kind: 'schedule', label: null, enabled: true, cronExpression: '0 9 * * 1', timezone: 'UTC', nextRunAt: '2026-11-10T09:00:00.000Z', lastFiredAt: '2026-11-03T09:00:00.000Z', lastResult: 'ok' }] },
    ],
    liveRuns: [{ id: 'run-linus-1', agentId: 'a1000000-0000-4000-8000-000000000003', status: 'running', agentName: 'Linus', adapterType: 'codex_local' }],
  };
};

/**
 * Starts the fake on 127.0.0.1. seed: { companies, agents, issues, routines, projects, noProjects, liveRuns, goals, approvals, activity, costs, secrets, noGoals, health, auth, key }. key: a board key; every route but /api/health answers 401 without `authorization: Bearer <key>`. auth: true answers
 * 403 to every route (a Paperclip in authenticated mode). port: 0 for a free one.
 */
export function startFakePaperclip(seed = DEMO(), { port = 0 } = {}) {
  const st = { companies: structuredClone(seed.companies || []), agents: structuredClone(seed.agents || []), issues: structuredClone(seed.issues || []), routines: structuredClone(seed.routines || []), projects: structuredClone(seed.projects || []), liveRuns: structuredClone(seed.liveRuns || []),
    goals: structuredClone(seed.goals || []), approvals: structuredClone(seed.approvals || []), activity: structuredClone(seed.activity || []), costs: structuredClone(seed.costs || null), secrets: structuredClone(seed.secrets || []), skills: structuredClone(seed.skills || []), plugins: structuredClone(seed.plugins || []), adapters: structuredClone(seed.adapters || []), costMonths: structuredClone(seed.costMonths || {}), budgets: structuredClone(seed.budgets || null),
    invites: structuredClone(seed.invites || []), joinRequests: structuredClone(seed.joinRequests || []), members: structuredClone(seed.members || []) };
  const requests = [], sockets = new Set();
  const api = { afterPatch: null, failIssueAfter: null, created: 0, comments: 0, hires: [], goalsMade: 0 };   // set by a test: runs right after a PATCH is answered (a change made in Paperclip at the same time)
  let seq = 0;
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  function emit(type, payload, companyId = st.companies[0]?.id) {
    const ev = JSON.stringify({ id: ++seq, companyId, type, createdAt: new Date().toISOString(), payload });
    for (const s of sockets) if (s.companyId === companyId) s.write(frame(ev));
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { return send(res, 400, { error: 'Bad JSON' }); }
      requests.push({ method: req.method, path: u.pathname, query: u.search, body: parsed });
      if (seed.auth) return send(res, 403, { error: 'Board access required' });
      // boardKey: a Paperclip in login mode that knows one key (#194): no Authorization is 403, another key is 401, GET /api/cli-auth/me names the key's user
      if (seed.boardKey) {
        const a = req.headers.authorization;
        if (u.pathname !== '/api/health') {
          if (!a) return send(res, 403, { error: 'Board access required' });
          if (a !== `Bearer ${seed.boardKey}`) return send(res, 401, { error: 'Board authentication required' });
        }
        if (u.pathname === '/api/cli-auth/me') return send(res, 200, { userId: 'u1', keyId: 'k1', source: 'board_key', isInstanceAdmin: true });
      }
      if (seed.key && u.pathname !== '/api/health' && req.headers.authorization !== `Bearer ${seed.key}`) return send(res, 401, { error: 'Board access required' });
      const m = (re) => re.exec(u.pathname);
      let x;
      if (req.method === 'GET' && u.pathname === '/api/health') return send(res, 200, seed.health || { status: 'ok', version: '2026.1023.0' });
      // create a company (routes/companies.ts: name, description).
      if (req.method === 'POST' && u.pathname === '/api/companies') {
        if (!parsed || typeof parsed.name !== 'string' || !parsed.name) return send(res, 422, { error: 'Validation error' });
        const co = { id: `c3000000-0000-4000-8000-${String(st.companies.length + 1).padStart(12, '0')}`, status: 'active', budgetMonthlyCents: 0, spentMonthlyCents: 0, ...parsed };
        st.companies.push(co);
        return send(res, 201, co);
      }
      if (req.method === 'GET' && u.pathname === '/api/companies') return send(res, 200, st.companies);
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)$/))) { const c = st.companies.find((y) => y.id === x[1]); return c ? send(res, 200, c) : send(res, 404, { error: 'Company not found' }); }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/agents$/))) {
        if (u.search) return send(res, 400, { error: 'Unsupported query parameter' });
        return send(res, 200, st.agents.filter((a) => a.companyId === x[1]));
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/issues$/))) {
        const want = (u.searchParams.get('status') || '').split(',').map((s) => s.trim()).filter(Boolean);
        return send(res, 200, st.issues.filter((i) => i.companyId === x[1] && (seed.allIssues || !want.length || want.includes(i.status))));
      }
      // create a task (routes/issues.ts, createIssueSchema 0.3.1: title, description, status; no metadata, no idempotency key).
      // api.failIssueAfter = n answers 500 to every create once n tasks were made (a failure in the middle of a handoff).
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/issues$/))) {
        if (!parsed || typeof parsed.title !== 'string' || !parsed.title) return send(res, 422, { error: 'Validation error' });
        if (api.failIssueAfter != null && api.created >= api.failIssueAfter) return send(res, 500, { error: 'Internal error' });
        api.created += 1;
        const n = st.issues.length + 1;
        const i = { id: `i2000000-0000-4000-8000-${String(n).padStart(12, '0')}`, companyId: x[1], identifier: `ACM-${100 + n}`, assigneeAgentId: null, assigneeAdapterOverrides: null, ...parsed };
        st.issues.push(i);
        return send(res, 201, i);
      }
      // the writes of the HQ writer (#198): one task, its assignee and comments, and the approval decisions (routes/issues.ts, routes/approvals.ts).
      // Paperclip answers the company of the thing too: GET /api/issues/:id and GET /api/approvals/:id are read before a write.
      if (req.method === 'GET' && (x = m(/^\/api\/issues\/([^/]+)$/))) { const i = st.issues.find((y) => y.id === x[1]); return i ? send(res, 200, i) : send(res, 404, { error: 'Issue not found' }); }
      if (req.method === 'PATCH' && (x = m(/^\/api\/issues\/([^/]+)$/))) {
        const i = st.issues.find((y) => y.id === x[1]);
        if (!i) return send(res, 404, { error: 'Issue not found' });
        Object.assign(i, parsed || {});
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'issue.updated', entityType: 'issue', entityId: i.id, agentId: null, runId: null, details: {} }, i.companyId);
        return send(res, 200, i);
      }
      if (req.method === 'POST' && (x = m(/^\/api\/issues\/([^/]+)\/comments$/))) {
        const i = st.issues.find((y) => y.id === x[1]);
        if (!i) return send(res, 404, { error: 'Issue not found' });
        if (!parsed || typeof parsed.body !== 'string' || !parsed.body) return send(res, 422, { error: 'Validation error' });
        const k = { id: `m2000000-0000-4000-8000-${String(++api.comments).padStart(12, '0')}`, companyId: i.companyId, issueId: i.id, body: parsed.body };
        return send(res, 201, k);
      }
      // goals (#207, routes/goals.ts): one goal, create in a company, update
      if (req.method === 'GET' && (x = m(/^\/api\/goals\/([^/]+)$/))) { const g = st.goals.find((y) => y.id === x[1]); return g ? send(res, 200, g) : send(res, 404, { error: 'Goal not found' }); }
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/goals$/))) {
        if (!parsed || typeof parsed.title !== 'string' || !parsed.title) return send(res, 422, { error: 'Validation error' });
        const g = { id: `g2000000-0000-4000-8000-${String(++api.goalsMade).padStart(12, '0')}`, companyId: x[1], description: null, level: 'task', status: 'planned', parentId: null, ownerAgentId: null, ...parsed };
        st.goals.push(g);
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'goal.created', entityType: 'goal', entityId: g.id, agentId: null, runId: null, details: {} }, x[1]);
        return send(res, 201, g);
      }
      if (req.method === 'PATCH' && (x = m(/^\/api\/goals\/([^/]+)$/))) {
        const g = st.goals.find((y) => y.id === x[1]);
        if (!g) return send(res, 404, { error: 'Goal not found' });
        Object.assign(g, parsed || {});
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'goal.updated', entityType: 'goal', entityId: g.id, agentId: null, runId: null, details: {} }, g.companyId);
        return send(res, 200, g);
      }
      if (req.method === 'GET' && (x = m(/^\/api\/approvals\/([^/]+)$/))) { const a = st.approvals.find((y) => y.id === x[1]); return a ? send(res, 200, a) : send(res, 404, { error: 'Approval not found' }); }
      if (req.method === 'POST' && (x = m(/^\/api\/approvals\/([^/]+)\/(approve|reject|request-revision)$/))) {
        const a = st.approvals.find((y) => y.id === x[1]);
        if (!a) return send(res, 404, { error: 'Approval not found' });
        if (a.status !== 'pending' && a.status !== 'revision_requested') return send(res, 422, { error: 'Approval already resolved' });
        a.status = { approve: 'approved', reject: 'rejected', 'request-revision': 'revision_requested' }[x[2]];
        a.decisionNote = parsed && parsed.decisionNote ? parsed.decisionNote : null;
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: `approval.${a.status}`, entityType: 'approval', entityId: a.id, agentId: null, runId: null, details: {} }, a.companyId);
        return send(res, 200, a);
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/routines$/))) return send(res, 200, st.routines.filter((r) => r.companyId === x[1]));
      // the routine writes (#209; routes/routines.ts): create, edit, one trigger's schedule, run now
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/routines$/))) {
        if (!parsed || typeof parsed.title !== 'string' || !parsed.title) return send(res, 422, { error: 'Validation error' });
        const r = { id: `r2000000-0000-4000-8000-${String(st.routines.length + 1).padStart(12, '0')}`, companyId: x[1], status: 'active', env: null, assigneeAgentId: null, lastTriggeredAt: null, triggers: [], ...parsed };
        st.routines.push(r);
        return send(res, 201, r);
      }
      if (req.method === 'PATCH' && (x = m(/^\/api\/routines\/([^/]+)$/))) {
        const r = st.routines.find((y) => y.id === x[1]);
        if (!r) return send(res, 404, { error: 'Routine not found' });
        Object.assign(r, parsed || {});
        return send(res, 200, r);
      }
      if (req.method === 'PATCH' && (x = m(/^\/api\/routine-triggers\/([^/]+)$/))) {
        const t = st.routines.flatMap((y) => y.triggers).find((y) => y.id === x[1]);
        if (!t) return send(res, 404, { error: 'Trigger not found' });
        Object.assign(t, parsed || {});
        return send(res, 200, t);
      }
      if (req.method === 'POST' && (x = m(/^\/api\/routines\/([^/]+)\/run$/))) {
        const r = st.routines.find((y) => y.id === x[1]);
        if (!r) return send(res, 404, { error: 'Routine not found' });
        r.lastTriggeredAt = new Date().toISOString();
        return send(res, 202, { id: `rr-${++api.comments}`, routineId: r.id, status: 'queued' });
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/projects$/))) return seed.noProjects ? send(res, 404, { error: 'Not found' }) : send(res, 200, st.projects.filter((r) => r.companyId === x[1]));
      // the HQ read model (#197): goals, pending approvals (the payload is in the answer, as in Paperclip), activity, the cost summary, secret names
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/goals$/))) return seed.noGoals ? send(res, 404, { error: 'Not found' }) : send(res, 200, st.goals.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/approvals$/))) { const want = u.searchParams.get('status'); return send(res, 200, st.approvals.filter((r) => r.companyId === x[1] && (!want || r.status === want))); }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/activity$/))) return send(res, 200, st.activity.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/costs\/summary$/))) return st.costs ? send(res, 200, st.costs) : send(res, 404, { error: 'Not found' });
      // the Costs view (#208): one month per `from` (seed.costMonths by YYYY-MM; a month not in it answers 404), and the budgets overview
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/costs\/by-(agent|project)$/))) {
        const month = (u.searchParams.get('from') || '').slice(0, 7), mo = st.costMonths[month];
        return mo ? send(res, 200, mo[x[2] === 'agent' ? 'agents' : 'projects'] || []) : send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/budgets\/overview$/))) return st.budgets ? send(res, 200, st.budgets) : send(res, 404, { error: 'Not found' });
      // skills, plugins and adapters (#212; Paperclip's answers carry skill files, a plugin manifest and adapter capabilities too)
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/skills$/))) return seed.noSkills ? send(res, 404, { error: 'Not found' }) : send(res, 200, st.skills.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && m(/^\/api\/plugins$/)) return send(res, 200, st.plugins);
      if (req.method === 'GET' && m(/^\/api\/adapters$/)) return send(res, 200, st.adapters);
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/secrets$/))) return send(res, 200, st.secrets.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/live-runs$/))) return send(res, 200, st.liveRuns);
      // company admin (#213): settings, invites, join requests and members (routes/companies.ts, routes/access.ts)
      if (req.method === 'PATCH' && (x = m(/^\/api\/companies\/([^/]+)$/))) {
        const co = st.companies.find((y) => y.id === x[1]);
        if (!co) return send(res, 404, { error: 'Company not found' });
        Object.assign(co, parsed || {});
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'company.updated', entityType: 'company', entityId: co.id, agentId: null, runId: null, details: {} }, co.id);
        return send(res, 200, co);
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/invites$/))) return send(res, 200, { invites: st.invites.filter((r) => r.companyId === x[1]), nextOffset: null });
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/invites$/))) {
        if (!parsed || !['human', 'agent', 'both'].includes(parsed.allowedJoinTypes)) return send(res, 422, { error: 'Validation error' });
        const v = { id: `v2000000-0000-4000-8000-${String(st.invites.length + 1).padStart(12, '0')}`, companyId: x[1], inviteType: 'company_join', allowedJoinTypes: parsed.allowedJoinTypes, humanRole: parsed.humanRole || null, inviteMessage: parsed.agentMessage || null, state: 'active', expiresAt: '2026-11-13T10:00:00.000Z', createdAt: new Date().toISOString() };
        st.invites.push(v);
        return send(res, 201, { ...v, token: 'pcp_invite_do-not-show', inviteUrl: 'http://127.0.0.1/invite/pcp_invite_do-not-show' });
      }
      if (req.method === 'POST' && (x = m(/^\/api\/invites\/([^/]+)\/revoke$/))) {
        const v = st.invites.find((y) => y.id === x[1]);
        if (!v) return send(res, 404, { error: 'Invite not found' });
        v.state = 'revoked';
        return send(res, 200, v);
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/join-requests$/))) return send(res, 200, st.joinRequests.filter((r) => r.companyId === x[1]));
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/join-requests\/([^/]+)\/(approve|reject)$/))) {
        const j = st.joinRequests.find((y) => y.id === x[2] && y.companyId === x[1]);
        if (!j) return send(res, 404, { error: 'Join request not found' });
        if (j.status !== 'pending_approval') return send(res, 409, { error: 'Join request is not pending' });
        j.status = x[3] === 'approve' ? 'approved' : 'rejected';
        return send(res, 200, j);
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/members$/))) return send(res, 200, { members: st.members.filter((r) => r.companyId === x[1]), access: { currentUserRole: 'owner' } });
      if (req.method === 'PATCH' && (x = m(/^\/api\/companies\/([^/]+)\/members\/([^/]+)$/))) {
        const mm = st.members.find((y) => y.id === x[2] && y.companyId === x[1]);
        if (!mm) return send(res, 404, { error: 'Member not found' });
        if (parsed && parsed.membershipRole) mm.membershipRole = parsed.membershipRole;
        if (parsed && parsed.status) mm.status = parsed.status;
        return send(res, 200, mm);
      }
      // the agent as saved, with what buildAgentDetail adds (routes/agents.ts; the board reads the whole config)
      if (req.method === 'GET' && (x = m(/^\/api\/agents\/([^/]+)$/))) { const a = st.agents.find((y) => y.id === x[1]); return a ? send(res, 200, { ...a, chainOfCommand: [], access: {} }) : send(res, 404, { error: 'Agent not found' }); }
      // hire an employee (#201, #204; routes/agents.ts handleAgentHire, createAgentHireSchema 0.3.1: name, role from AGENT_ROLES (a Zod enum:
      // another word is 400), title, adapterType, adapterConfig, reportsTo, budgetMonthlyCents (int, nonnegative), desiredSkills). Answers 201
      // { agent, approval }: approval is a pending hire_agent approval, and the agent pending_approval, when the company sets
      // requireBoardApprovalForNewAgents, else null. api.hires lists what was sent.
      if (req.method === 'POST' && (x = m(/^\/api\/companies\/([^/]+)\/agent-hires$/))) {
        if (!parsed || typeof parsed.name !== 'string' || !parsed.name || typeof parsed.adapterType !== 'string') return send(res, 400, { error: 'Validation error' });
        if (parsed.role !== undefined && !AGENT_ROLES.includes(parsed.role)) return send(res, 400, { error: 'Validation error', details: [{ path: ['role'], message: 'Invalid enum value' }] });
        if (parsed.budgetMonthlyCents !== undefined && !(Number.isInteger(parsed.budgetMonthlyCents) && parsed.budgetMonthlyCents >= 0)) return send(res, 400, { error: 'Validation error' });
        if (parsed.reportsTo && !st.agents.some((y) => y.id === parsed.reportsTo)) return send(res, 422, { error: 'Manager not found' });
        const co = st.companies.find((y) => y.id === x[1]);
        if (!co) return send(res, 404, { error: 'Company not found' });
        const pending = co.requireBoardApprovalForNewAgents === true;
        const n = st.agents.length + 1;
        const a = { id: `a4000000-0000-4000-8000-${String(n).padStart(12, '0')}`, companyId: x[1], title: null, reportsTo: null, budgetMonthlyCents: 0, spentMonthlyCents: 0, adapterConfig: {}, runtimeConfig: {}, role: 'general', ...parsed, status: pending ? 'pending_approval' : 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        st.agents.push(a); api.hires.push(parsed);
        let approval = null;
        if (pending) {
          approval = { id: `p4000000-0000-4000-8000-${String(n).padStart(12, '0')}`, companyId: x[1], type: 'hire_agent', status: 'pending', requestedByAgentId: null, requestedByUserId: 'board', payload: { name: a.name, role: a.role, agentId: a.id }, decisionNote: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          st.approvals.push(approval);
        }
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'agent.hire_created', entityType: 'agent', entityId: a.id, agentId: null, runId: null, details: {} }, a.companyId);
        return send(res, 201, { agent: a, approval });
      }
      if (req.method === 'PATCH' && (x = m(/^\/api\/agents\/([^/]+)$/))) {
        const a = st.agents.find((y) => y.id === x[1]);
        if (!a) return send(res, 404, { error: 'Agent not found' });
        if (parsed && parsed.permissions) return send(res, 422, { error: 'Use /api/agents/:id/permissions for permission changes' });
        if (parsed && parsed.adapterConfig) a.adapterConfig = parsed.replaceAdapterConfig ? parsed.adapterConfig : { ...a.adapterConfig, ...parsed.adapterConfig };
        if (parsed && 'reportsTo' in parsed) {   // the reporting line (#202): a manager of this company or null
          if (parsed.reportsTo !== null && !st.agents.some((y) => y.id === parsed.reportsTo)) return send(res, 422, { error: 'Manager not found' });
          a.reportsTo = parsed.reportsTo;
        }
        a.updatedAt = new Date().toISOString();
        emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'agent.updated', entityType: 'agent', entityId: a.id, agentId: null, runId: null, details: {} }, a.companyId);
        send(res, 200, a);
        if (typeof api.afterPatch === 'function') api.afterPatch(a);   // a change made in Paperclip just after the office's
        return;
      }
      return send(res, 404, { error: 'Not found' });
    });
  });
  server.on('upgrade', (req, sock) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/api\/companies\/([^/]+)\/events\/ws$/.exec(u.pathname);
    requests.push({ method: 'UPGRADE', path: u.pathname, query: u.search, body: null });
    requests[requests.length - 1].authorization = req.headers.authorization || null;
    if (!m || seed.auth || (seed.boardKey && req.headers.authorization !== `Bearer ${seed.boardKey}`) || (seed.key && req.headers.authorization !== `Bearer ${seed.key}`)) { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.companyId = decodeURIComponent(m[1]);
    sockets.add(sock);
    sock.on('data', (b) => onClientData(sock, b));
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    resolve(Object.assign(api, {
      url: `http://127.0.0.1:${p}`, port: p, requests, state: st, emit,
      sockets: () => sockets.size,
      /** Close every event socket (the stream drops; the office should connect again). */
      drop() { for (const s of sockets) s.destroy(); sockets.clear(); },
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }),
    }));
  }));
}

// By hand: the demo company, and a few live events so the HQ shows work.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), hi = args.indexOf('--hooks');
  const hooks = hi >= 0 ? args[hi + 1] : null;
  const portArg = args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--hooks');
  const pc = await startFakePaperclip(DEMO(hooks), { port: Number(portArg) || 0 });
  console.log(`Fake Paperclip on ${pc.url} (demo company Acme Robotics${hooks ? `, Ada supervised with ${hooks}` : ''}). Ctrl+C stops it.`);
  setInterval(() => {
    pc.emit('heartbeat.run.status', { runId: 'run-linus-1', agentId: 'a1000000-0000-4000-8000-000000000003', status: 'running', invocationSource: 'timer', triggerDetail: null, error: null, errorCode: null, startedAt: new Date().toISOString(), finishedAt: null });
  }, 20000).unref?.();
  process.on('SIGINT', async () => { await pc.close(); process.exit(0); });
}
