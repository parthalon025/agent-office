#!/usr/bin/env node
// Agent Office MCP server (stdio). Gives a Claude Code session four tools:
//   office_inbox        read messages the user typed in the office
//   office_ask          ask the user a question in the office and wait for the answer
//   office_room         describe the session's room: building (repository), floor (branch), room
//                       (worktree folder), the other sessions there and what they work on, the user's
//                       notes board, the blackboard pin, the things in the room, and what it can change
//   office_room_update  change the room: append to or replace the notes board, pin or clear a short
//                       message (at most 140 characters) on the blackboard
// Room awareness: when the user talks about the office, the room, the boards, the notes, the door or the
// desks, the agent reads its room with office_room, so it can talk about it and guide the user. It changes
// the room only with office_room_update, and only its own room: the server finds the room from the calling
// session (server.mjs callerRoom, keys from git.mjs roomKeys), never from the arguments. Notes and pins
// live in the office's state.json and show on the room's boards at once.
// It identifies its session by OFFICE_ID (sessions the office opened) or by its parent pid.
// Zero dependencies; speaks newline-delimited JSON-RPC 2.0.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIN_MAX = 140; // the server checks it too (server.mjs PIN_MAX)
const INSTRUCTIONS =
  'The user may be watching this session in Agent Office. Call office_inbox when they say they sent you a message there, ' +
  'and call office_ask when you need a decision and the user may be away from the terminal. ' +
  'When the user talks about the office, the room, the boards, the notes, the door or the desks, call office_room first. ' +
  'Use office_room_update when the user asks to change the notes or the blackboard.';

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
  {
    name: 'office_room',
    description: 'Describe your place in Agent Office: the building (repository), the floor (branch) and the room (worktree folder); ' +
      'the other sessions in the room and what they work on; the notes board with the user\'s notes; the blackboard pin; ' +
      'the things in the room (blackboard, notes board, stats display, door, desks with monitors); and what office_room_update can change. ' +
      'Call it first when the user talks about the office, the room, the boards, the notes, the door or the desks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'office_room_update',
    description: 'Change your room in Agent Office when the user asks you to change the notes or the blackboard. ' +
      'Give one or more of notes_append, notes_replace and pin (not notes_append and notes_replace together). Returns what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        notes_append: { type: 'string', description: 'Text to add as a new line at the end of the user\'s notes board. The office puts your session name in front of it, so the user sees it is from you.' },
        notes_replace: { type: 'string', description: 'New text for the whole notes board. It replaces the user\'s notes. Use it only when the user asks you to rewrite or clear the notes. An empty string clears the board.' },
        pin: { type: 'string', maxLength: PIN_MAX, description: `A short message to pin on the room's blackboard, ${PIN_MAX} characters or less. It replaces the last pin. An empty string clears it.` },
      },
      additionalProperties: false,
    },
  },
];
const ROOM_FIELDS = ['notes_append', 'notes_replace', 'pin'];

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
  // The room lookup may run git once (about 50 ms; git.locate gives up after 8 s).
  if (name === 'office_room') return (await office('/mcp/room', {}, 15000)).text;
  if (name === 'office_room_update') {
    // Only the three room fields go to the server, so an argument can never stand in for office_id or pid.
    const body = {};
    for (const k of ROOM_FIELDS) {
      const v = args?.[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') throw new Error(`${k} must be text.`);
      body[k] = v;
    }
    if (!Object.keys(body).length) throw new Error('office_room_update needs notes_append, notes_replace or pin.');
    return (await office('/mcp/room/update', body, 15000)).text;
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
