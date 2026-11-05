// Fake Azure services for the cloud provider tests (providers/foundry.mjs, providers/copilot-studio.mjs). No Azure, no token that
// means anything, no cost: 127.0.0.1 on a free port. These are NOT recordings. The event shapes follow the public documents of the
// two services (the Agent Service run stream, the Copilot Studio conversation activities). A real recording of each is still to
// come; the live run waits for the owner's own account (#24).
//
// Both fakes keep `calls`: { method, path, query, auth, body } for every request, so a test can see what was sent, to which path,
// and with which token. script: one entry per run (Foundry) or per message (Copilot Studio), in order; the last entry repeats.
import http from 'node:http';

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch { resolve(null); } });
});
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/**
 * The Foundry Agent Service. A script entry: { events: [[name, data], ...], hang?: true (keep the stream open), status?: n (answer
 * with an error) }. A run stream ends with `done` unless hang is set. `agents` answers GET /assistants. `runInfo` answers
 * GET /threads/<t>/runs/<id> (the run as the service keeps it, for example its usage after a cancel). A function gets the run id and is awaited, so a test can hold the answer.
 */
export async function startFakeFoundry({ script = [{ events: [] }], agents = [{ id: 'asst_1', name: 'Helper', model: 'gpt-4o' }], threadId = 'thread_1', runInfo = { status: 'cancelled', usage: null } } = {}) {
  const calls = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || '', body });
    const p = url.pathname;
    if (req.method === 'GET' && p === '/assistants') return json(res, 200, { object: 'list', data: agents });
    if (req.method === 'POST' && p === '/threads') return json(res, 200, { id: threadId, object: 'thread' });
    if (req.method === 'POST' && /^\/threads\/[^/]+\/messages$/.test(p)) return json(res, 200, { id: 'msg_user', object: 'thread.message' });
    if (req.method === 'POST' && /\/cancel$/.test(p)) return json(res, 200, { id: 'run_1', status: 'cancelling' });
    if (req.method === 'GET' && /^\/threads\/[^/]+\/runs\/[^/]+$/.test(p)) return json(res, 200, { id: p.split('/').pop(), object: 'thread.run', ...(typeof runInfo === 'function' ? await runInfo(p.split('/').pop()) : runInfo) });
    if (req.method === 'POST' && (/^\/threads\/[^/]+\/runs$/.test(p) || /\/submit_tool_outputs$/.test(p))) {
      const step = script[Math.min(n++, script.length - 1)];
      if (step.status) return json(res, step.status, { error: { code: 'x', message: step.message || 'fake failure' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [name, data] of step.events || []) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      if (step.hang) return undefined;
      res.write('event: done\ndata: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  const l = await listen(server);
  return { url: l.url, calls, close: l.close };
}

/**
 * Copilot Studio. The conversations path is /copilotstudio/dataverse-backed/authentication/agents/<schema>/conversations.
 * A script entry (one per message): { activities: [activity, ...], hang?: true, status?: n }. Each activity is one SSE `activity`
 * event; the stream ends with an `end` event unless hang is set. Starting a conversation answers x-ms-conversationid: conv-<n>.
 */
export async function startFakeCopilotStudio({ script = [{ activities: [] }], schema = 'cr123_helper' } = {}) {
  const calls = [];
  const root = `/copilotstudio/dataverse-backed/authentication/agents/${schema}/conversations`;
  let n = 0, conv = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || '', body });
    if (req.method === 'POST' && url.pathname === root) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ms-conversationid': `conv-${++conv}` });
      res.write('event: end\ndata: end\n\n');
      return res.end();
    }
    if (req.method === 'POST' && url.pathname.startsWith(root + '/')) {
      const step = script[Math.min(n++, script.length - 1)];
      if (step.status) return json(res, step.status, { error: { message: step.message || 'fake failure' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const a of step.activities || []) res.write(`event: activity\ndata: ${JSON.stringify(a)}\n\n`);
      if (step.hang) return undefined;
      res.write('event: end\ndata: end\n\n');
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  const l = await listen(server);
  return { url: l.url + root + '?api-version=2022-03-01-preview', calls, close: l.close };
}
