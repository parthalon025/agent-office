// One POST to the local office, for hook.mjs and mcp.mjs (#128). Node built-ins only, so the command hook stays light.
// Not the global fetch: its undici gives up after 300 s without answer headers (UND_ERR_HEADERS_TIMEOUT), and a held
// request waits longer (a permission request 15 min, office_ask 10 min). So: node:http, no socket timeout, a socket of
// its own (agent: false), and the caller's AbortSignal ends the wait. The answer is capped. Pure apart from the call.
import http from 'node:http';

export const MAX_ANSWER = 65_536; // bytes of the office's answer that are read

/** @returns {Promise<{ status: number, text: string }>} rejects on a refused connection, an abort, a cut answer or a too large one. */
export function httpPost({ port, path, headers, body, signal, maxAnswer = MAX_ANSWER }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, timeout: 0, signal,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '', size = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => { size += Buffer.byteLength(c); if (size <= maxAnswer) text += c; else { reject(new Error('the answer is too large')); res.destroy(); } });
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('the answer stopped')));
      });
    } catch (e) { reject(e); return; }
    req.on('error', reject);
    req.end(body);
  });
}
