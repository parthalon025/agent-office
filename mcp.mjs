#!/usr/bin/env node
// Agent Office MCP server (stdio). Gives a Claude Code session two tools:
//   office_inbox  read messages the user typed in the office
//   office_ask    ask the user a question in the office and wait for the answer
// It identifies its session by OFFICE_ID (sessions the office opened) or by its parent pid.
// Zero dependencies; speaks newline-delimited JSON-RPC 2.0.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTRUCTIONS =
  'The user may be watching this session in Agent Office. Call office_inbox when they say they sent you a message there, ' +
  'and call office_ask when you need a decision and the user may be away from the terminal.';

const TOOLS = [
  {
    name: 'office_inbox',
    description: 'Read new messages the user sent to this session from Agent Office. Returns them and clears the queue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'office_ask',
    description: 'Ask the user a question in Agent Office and wait for their answer (up to 10 minutes). Use for decisions you cannot make alone.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'A short, specific question. A yes or no question works best.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(here, '.office-token'), 'utf8')); } catch { return null; }
}

async function office(route, body, ms) {
  const cfg = config();
  if (!cfg) throw new Error('Agent Office is not running.');
  const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-token': cfg.token },
    body: JSON.stringify({ office_id: process.env.OFFICE_ID || null, pid: process.ppid, ...body }),
    signal: AbortSignal.timeout(ms),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Agent Office answered ${res.status}.`);
  return json;
}

async function callTool(name, args) {
  if (name === 'office_inbox') return (await office('/mcp/inbox', {}, 5000)).text;
  if (name === 'office_ask') {
    const question = String(args?.question || '').slice(0, 600);
    if (!question) throw new Error('office_ask needs a question.');
    return (await office('/mcp/ask', { question }, 11 * 60 * 1000)).text;
  }
  throw new Error(`Unknown tool: ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return send({ id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-office', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params?.name, params?.arguments);
        return send({ id, result: { content: [{ type: 'text', text: String(text) }] } });
      } catch (e) {
        return send({ id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  void handle(req);
});
