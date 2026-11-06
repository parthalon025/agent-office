// A fake OpenAI-compatible chat server for provider tests. No model, no cost, 127.0.0.1 on a free port.
// script: one entry per chat request, in order. { text } streams a reply; { toolCalls: [{ name, args }] } asks for tools;
// { status: 500 } fails; { delayMs } waits before it answers; { usage } sets the token numbers. The last entry repeats. models: ids (or { id, max_context_length, loaded_context_length, ... } entries) for GET /v1/models. `requests` holds the chat bodies, `calls` every method and path.
import http from 'node:http';

export async function startFakeOpenAI({ script = [{ text: 'ok' }], models = ['fake-model'] } = {}) {
  const requests = [];
  const calls = []; // every request of any kind: { method, path }, so a test can see a different endpoint
  let n = 0;
  let steps = script;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname });
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: models.map((m) => (typeof m === 'string' ? { id: m, object: 'model' } : { object: 'model', ...m })) }));
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* keep {} */ }
        requests.push(json);
        const step = steps[Math.min(n++, steps.length - 1)];
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        if (step.status) {
          res.writeHead(step.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'fake failure' } }));
        }
        const usage = step.usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const msg = step.toolCalls
          ? { role: 'assistant', content: null, tool_calls: step.toolCalls.map((t, i) => ({ id: `call_${n}_${i}`, type: 'function', function: { name: t.name, arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {}) } })) }
          : { role: 'assistant', content: step.text ?? '' };
        if (json.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: json.model, choices: [{ index: 0, message: msg, finish_reason: step.toolCalls ? 'tool_calls' : 'stop' }], usage }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const chunk = (delta, finish = null) => ({ id: 'x', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        if (step.toolCalls) {
          msg.tool_calls.forEach((t, i) => send(chunk({ tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } }] })));
          send(chunk({}, 'tool_calls'));
        } else {
          const t = msg.content;
          const mid = Math.ceil(t.length / 2);
          if (t) { send(chunk({ role: 'assistant', content: t.slice(0, mid) })); send(chunk({ content: t.slice(mid) })); }
          send(chunk({}, 'stop'));
        }
        send({ id: 'x', object: 'chat.completion.chunk', model: json.model, choices: [], usage });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    calls,
    /** Start the script again with new steps (a shared server, one test after another). */
    reset(next) { steps = next; n = 0; requests.length = 0; calls.length = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
