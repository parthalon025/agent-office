// A fake Paperclip server for the HQ tests (#76): the REST routes the office reads, the one PATCH it may send, and the live
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

export const DEMO = (hooksFile = null) => {
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
 * Starts the fake on 127.0.0.1. seed: { companies, agents, issues, routines, projects, noProjects, liveRuns, health, auth }. auth: true answers
 * 403 to every route (a Paperclip in authenticated mode). port: 0 for a free one.
 */
export function startFakePaperclip(seed = DEMO(), { port = 0 } = {}) {
  const st = { companies: structuredClone(seed.companies || []), agents: structuredClone(seed.agents || []), issues: structuredClone(seed.issues || []), routines: structuredClone(seed.routines || []), projects: structuredClone(seed.projects || []), liveRuns: structuredClone(seed.liveRuns || []) };
  const requests = [], sockets = new Set();
  const api = { afterPatch: null };   // set by a test: runs right after a PATCH is answered (a change made in Paperclip at the same time)
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
      const m = (re) => re.exec(u.pathname);
      let x;
      if (req.method === 'GET' && u.pathname === '/api/health') return send(res, 200, seed.health || { status: 'ok', version: '2026.1023.0' });
      if (req.method === 'GET' && u.pathname === '/api/companies') return send(res, 200, st.companies);
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)$/))) { const c = st.companies.find((y) => y.id === x[1]); return c ? send(res, 200, c) : send(res, 404, { error: 'Company not found' }); }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/agents$/))) {
        if (u.search) return send(res, 400, { error: 'Unsupported query parameter' });
        return send(res, 200, st.agents.filter((a) => a.companyId === x[1]));
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/issues$/))) {
        const want = (u.searchParams.get('status') || '').split(',').map((s) => s.trim()).filter(Boolean);
        return send(res, 200, st.issues.filter((i) => i.companyId === x[1] && (!want.length || want.includes(i.status))));
      }
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/routines$/))) return send(res, 200, st.routines.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/projects$/))) return seed.noProjects ? send(res, 404, { error: 'Not found' }) : send(res, 200, st.projects.filter((r) => r.companyId === x[1]));
      if (req.method === 'GET' && (x = m(/^\/api\/companies\/([^/]+)\/live-runs$/))) return send(res, 200, st.liveRuns);
      // the agent as saved, with what buildAgentDetail adds (routes/agents.ts; the board reads the whole config)
      if (req.method === 'GET' && (x = m(/^\/api\/agents\/([^/]+)$/))) { const a = st.agents.find((y) => y.id === x[1]); return a ? send(res, 200, { ...a, chainOfCommand: [], access: {} }) : send(res, 404, { error: 'Agent not found' }); }
      if (req.method === 'PATCH' && (x = m(/^\/api\/agents\/([^/]+)$/))) {
        const a = st.agents.find((y) => y.id === x[1]);
        if (!a) return send(res, 404, { error: 'Agent not found' });
        if (parsed && parsed.permissions) return send(res, 422, { error: 'Use /api/agents/:id/permissions for permission changes' });
        if (parsed && parsed.adapterConfig) a.adapterConfig = parsed.replaceAdapterConfig ? parsed.adapterConfig : { ...a.adapterConfig, ...parsed.adapterConfig };
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
    if (!m || seed.auth) { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
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
