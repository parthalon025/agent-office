// The run of the Agent Office adapter for Paperclip (#200): what execute() and testEnvironment() do. Pure apart from the file read,
// the environment, the HTTP call and the sleep, which are injected, so the office's tests run it without Paperclip
// (test/paperclip-adapter.test.mjs, with the stand-in host test/fixtures/fake-paperclip-host.mjs and a fake office).
//
// The wire is the office's (src/paperclip-runs.mjs): start the run, then ask for news again and again (each ask is held by the office
// for up to 25 s), until the answer says done, with the result. A call the office asks the user about waits in Needs you, so a run can
// take hours; plain polls need no long request, and Paperclip's abort ends the loop and cancels the run in the office.
// Every failure is a failed run with a reason, never a thrown error and never a guess.
import http from 'node:http';
import path from 'node:path';

export const ROUTES = Object.freeze({ start: '/hook/paperclip/run/start', wait: '/hook/paperclip/run/wait', cancel: '/hook/paperclip/run/cancel' });
const MAX_ANSWER = 16 * 1024 * 1024; // bytes of one answer (a long log chunk)
const RETRIES = 5;                   // waits that fail in a row before the run is called lost
const RETRY_MS = 2000;
const PLAIN = /^[A-Za-z0-9_-]{1,80}$/;
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * One POST to the office on loopback with node:http, not the global fetch: fetch gives up after 300 s without answer headers, and a
 * wait is held up to 25 s but the host may replace the global fetch. Resolves { status, json }; rejects when the request fails or the
 * signal aborts. The office's answer is JSON; anything else is json null.
 */
export function httpPost({ port, path: route, token, body, signal }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false, timeout: 0, signal,
        headers: { 'content-type': 'application/json', 'x-office-token': token, 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let out = '', size = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => { size += Buffer.byteLength(c); if (size <= MAX_ANSWER) out += c; else res.destroy(new Error('the answer is too large')); });
        res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch { /* not JSON */ } resolve({ status: res.statusCode || 0, json }); });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('the answer stopped')));
      });
    } catch (e) { reject(e); return; }
    req.on('error', reject);
    req.end(payload);
  });
}

/** The run prompt: the template of the config (or "Continue your work."), then the task and why Paperclip woke the employee. */
export function promptOf({ agent = {}, config = {}, context = {} }) {
  const vars = { 'agent.name': text(agent.name), 'agent.id': text(agent.id) };
  const base = text(config.promptTemplate) ? config.promptTemplate.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => vars[k] || '') : 'Continue your work.';
  const id = text(context.taskId) || text(context.issueId);
  const name = [text(context.issueIdentifier), text(context.issueTitle) || text(context.taskTitle)].filter(Boolean).join(' ');
  const extra = [
    id || name ? `Task: ${name ? `${name}${id ? ` (${id})` : ''}` : id}` : '',
    text(context.wakeReason) ? `Wake reason: ${text(context.wakeReason)}` : '',
    text(context.wakeCommentId) || text(context.commentId) ? `Comment: ${text(context.wakeCommentId) || text(context.commentId)}` : '',
  ].filter(Boolean);
  return extra.length ? `${base}\n\n${extra.join('\n')}` : base;
}

/**
 * @param {object} deps
 * @param {() => object} deps.env the environment (AGENT_OFFICE_TOKEN_FILE).
 * @param {(file: string) => Promise<string>} deps.readFile reads the token file.
 * @param {typeof httpPost} [deps.post]  @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 */
export function createRunner(deps) {
  const post = deps.post || httpPost;
  const sleep = deps.sleep || ((ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true }); }));

  const failed = (message, code) => ({ exitCode: 1, signal: null, timedOut: false, errorMessage: message, errorCode: code });
  const tokenFileOf = (config) => text(config?.tokenFile) || text(deps.env()?.AGENT_OFFICE_TOKEN_FILE);

  /** { token, port } from the token file, or { error } that says what to do. */
  async function officeOf(config) {
    const file = tokenFileOf(config);
    if (!file) return { error: 'The adapter does not know the office token file. Set AGENT_OFFICE_TOKEN_FILE for Paperclip, or tokenFile in the adapter config.' };
    let raw;
    try { raw = await deps.readFile(file); } catch (e) { return { error: `The adapter cannot read the office token file ${file} (${e.code || e.message}).` }; }
    let c;
    try { c = JSON.parse(raw); } catch { return { error: `The office token file ${file} is not JSON.` }; }
    const port = Number(c && c.port);
    if (!c || typeof c.token !== 'string' || !c.token || !Number.isInteger(port) || port < 1 || port > 65535) return { error: `The office token file ${file} has no token and port.` };
    return { token: c.token, port };
  }
  const down = (o) => `Agent Office is not running or does not answer on 127.0.0.1:${o.port}. Start the office, then wake the employee again.`;
  const ask = (o, route, body, signal) => post({ port: o.port, path: route, token: o.token, body, signal });
  const reason = (r) => (r.json && typeof r.json.error === 'string' && r.json.error) || `HTTP ${r.status}`;

  async function execute(ctx) {
    const config = ctx.config || {}, context = ctx.context || {}, agent = ctx.agent || {};
    const cwd = text(config.cwd) || text(context.paperclipWorkspace?.cwd);
    if (!cwd) return failed('The run has no folder to work in. Set cwd in the adapter config, or give the employee a workspace in Paperclip.', 'agent_office_config');
    const o = await officeOf(config);
    if (o.error) return failed(o.error, 'agent_office_config');
    const kind = text(config.agentKind) || 'claude-code';
    const prompt = promptOf({ agent, config, context });
    const taskId = text(context.taskId) || text(context.issueId);
    try { await ctx.onMeta?.({ adapterType: 'agent_office', command: `agent-office:${kind}`, cwd, prompt, context: { agentKind: kind } }); } catch { /* a log sink never stops a run */ }

    let key = null, start;
    const cancelled = () => { if (key) void ask(o, ROUTES.cancel, { key }).catch(() => {}); return { exitCode: null, signal: 'SIGTERM', timedOut: false, errorMessage: 'Paperclip cancelled the run.' }; };
    try {
      start = await ask(o, ROUTES.start, {
        run_id: ctx.runId, agent: { id: agent.id, company_id: agent.companyId, name: agent.name }, agent_kind: kind, ...(text(config.model) ? { model: text(config.model) } : {}),
        cwd, isolation: config.isolation === 'worktree' ? 'worktree' : 'same', prompt, ...(PLAIN.test(taskId) ? { task_id: taskId } : {}),
      }, ctx.signal);
    } catch { return ctx.signal?.aborted ? cancelled() : failed(down(o), 'agent_office_down'); }
    if (start.status < 200 || start.status > 299 || !start.json || typeof start.json.key !== 'string') return failed(`Agent Office refused the run: ${reason(start)}`, 'agent_office_refused');
    key = start.json.key;

    let cursor = 0, misses = 0, last = '';
    for (;;) {
      if (ctx.signal?.aborted) return cancelled();
      let r;
      try { r = await ask(o, ROUTES.wait, { key, cursor }, ctx.signal); } catch { r = null; if (ctx.signal?.aborted) return cancelled(); }
      if (r && r.status === 404) return failed(`Agent Office lost the run: ${reason(r)}`, 'agent_office_lost');
      if (!r || r.status < 200 || r.status > 299 || !r.json) {
        last = r ? reason(r) : down(o);
        if (++misses >= RETRIES) return failed(`Lost contact with Agent Office: ${last}`, 'agent_office_lost');
        await sleep(RETRY_MS, ctx.signal);
        continue;
      }
      misses = 0;
      const d = r.json;
      for (const l of Array.isArray(d.log) ? d.log : []) {
        try { await ctx.onLog?.(l.stream === 'stderr' ? 'stderr' : 'stdout', `${String(l.text)}\n`); } catch { /* a log sink never stops a run */ }
      }
      if (Number.isInteger(d.cursor) && d.cursor >= cursor) cursor = d.cursor;
      if (d.done) return resultOf(d.result || {});
    }
  }

  /** The AdapterExecutionResult of the office's result. Cost is null (unpriced) when the agent reported none: never 0. */
  function resultOf(x) {
    const ok = x.ok === true;
    const cost = typeof x.cost === 'number' && Number.isFinite(x.cost) ? x.cost : null;
    const out = {
      exitCode: ok ? 0 : 1, signal: null, timedOut: false,
      ...(ok ? {} : { errorMessage: text(x.error) || 'The run failed in Agent Office.', errorCode: 'agent_office_failed' }),
      provider: text(x.provider) || null, model: text(x.model) || null, costUsd: cost, costStatus: cost === null ? 'unpriced' : 'reported',
      usageComplete: !!x.usage, sessionDisplayId: text(x.uid) || null, summary: text(x.summary) || null,
      resultJson: { office: { uid: x.uid ?? null, sessionId: x.sessionId ?? null, turns: x.turns ?? 0, costUnknown: x.costUnknown !== false && cost === null } },
    };
    if (x.usage) out.usage = { inputTokens: Number(x.usage.inputTokens) || 0, outputTokens: Number(x.usage.outputTokens) || 0, cachedInputTokens: Number(x.usage.cachedInputTokens) || 0 };
    return out;
  }

  /** Diagnostics before a run: the token file, the office (it answers a wait for a run that does not exist with 404), the folder. */
  async function testEnvironment(ctx) {
    const config = ctx.config || {}, checks = [];
    const add = (level, code, message, hint) => checks.push({ level, code, message, ...(hint ? { hint } : {}) });
    const o = await officeOf(config);
    if (o.error) add('error', 'token_file', o.error, 'Set AGENT_OFFICE_TOKEN_FILE in the environment of Paperclip to the office token file (.office-token).');
    else {
      add('info', 'token_file', 'The office token file is readable.');
      try {
        const r = await ask(o, ROUTES.wait, { key: 'environment-check' });
        if (r.status === 404) add('info', 'office_reachable', `Agent Office answers on 127.0.0.1:${o.port}.`);
        else if (r.status === 401 || r.status === 403) add('error', 'office_refused', 'Agent Office refused the token.', 'The token file may be from another office. Use the token file of the office that runs now.');
        else add('warn', 'office_odd', `Agent Office answered HTTP ${r.status}.`);
      } catch { add('error', 'office_down', down(o), 'Start Agent Office.'); }
    }
    const cwd = text(config.cwd);
    if (!cwd) add('info', 'cwd_from_workspace', 'No cwd is set: each run works in the workspace Paperclip gives it.');
    else if (!path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd)) add('warn', 'cwd_not_absolute', `The working folder is not an absolute path: ${cwd}`, 'Use a full path such as C:\\work\\project.');
    return { adapterType: ctx.adapterType || 'agent_office', status: checks.some((c) => c.level === 'error') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass', checks, testedAt: new Date().toISOString() };
  }

  return { execute, testEnvironment };
}
