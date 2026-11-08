// The HQ write kinds (#232, ADR 0010): every change the office can make in Paperclip. A write kind (GLOSSARY.md) is one file in this
// folder, and KINDS below lists them in the order of the write grid. The writer (paperclip.mjs hq.write) runs one pipeline for every kind
// and never names one. Pure: no I/O, no clock; a kind's `before` and `send` reach Paperclip only through the context the writer hands them.
// Tested in test/hq-writes.test.mjs (every kind against its samples, and the pipeline with a stand-in kind), test/hq-write-grid.test.mjs,
// test/hq-write.test.mjs and test/paperclip-contract.test.mjs (the samples against the validators of the pinned release).
//
// A kind entry (default export of its file):
//   kind                        the name in a write body and in the saved grid
//   label, options, def         its row of the write grid: the words, the values it offers (RULES, or fewer: a secret and Supervise never
//                               take Allow, an export is never asked), its default (Confirm, unless the kind's ticket says otherwise)
//   ownAddress?                 true when an action names its own Paperclip address (plan.scope 'none', the first company, #199): the writer
//                               plans it before it asks for a connection
//   actions                     { <action>(body) -> request }: pure builders, 400 (gridError) for a bad field. A request: { method,
//                               path(companyId), body, targets, summary } and, when the kind needs them, review(org, { kindOf }) (checks
//                               against the org chart the writer holds and a better summary), scope and url, preflight and summarize,
//                               timeoutMs, forbidden (the words of a 403), name, fill
//   before?(plan, ctx)          before the Confirm: refuse (throw), change plan.summary or plan.body, or answer with no write (return a
//                               result: nothing is asked and nothing is sent)
//   send?(plan, ctx)            the kind sends its own way (Supervise's read-then-PATCH, the export's bundle): it calls ctx.confirm() before
//                               its first change, sends with ctx.request(body), feeds and returns its result. Without it the writer asks
//                               the Confirm, sends plan.body, then runs expect, result and note.
//   busy?(plan) -> id           the employee marked busy while the write is sent (a second change of it is 409), and read again after it
//   employee?(plan, made) -> id an employee the write made, read again after it (a hire: the onboarding task can name it at once)
//   expect?(plan, made)         what Paperclip must name in its answer: '' when it does, else the problem: 'words' (the feed line
//                               "<words>: <summary>." and the 502 "<words>.") or { line, error }. made is the answer as an object.
//   result?(plan, made)         the ids the write returns, after { ok: true }. Never a body from Paperclip.
//   note?(plan, made)           a sentence added to the feed line "Wrote to <company>: <summary>."
//   samples                     { <action>: { body, request: { method, path, body }, answer, result } } for every action: the write body,
//                               the exact request it plans for company SAMPLE.co (before `before`), a Paperclip answer, and what the write
//                               returns for it (no result: the kind has `send` and its result is tested through the writer)
//
// The context (built per write by paperclip.mjs; the board key stays inside every call):
//   company, companyId          the words of the company (or of the Paperclip address, for the first company) and its id
//   read(route)                 a GET of Paperclip at the write's address: the answer, or an error with its status
//   feed(text, kind?)           a feed line ('tool', or 'wait' for a refusal)
//   adapter(), adapterDir()     the office adapter in Paperclip ({ state, why }, GET /api/adapters) and the office's adapter folder ('' when
//                               it is not there)
//   preview()                   the plan's preflight POST; a refusal leaves a feed line
//   confirm()                   throws the ask-first question while the grid's Confirm waits for the user's yes; nothing once it has it
//   request(body)               the plan's own request with this body, as an object; a refusal leaves a feed line
//   connected()                 the write's connection is still the watched one
//   hold(id, text, fn)          runs fn with the employee marked busy (409 with text while another change of it runs)
//   employee                    { read(id): the agent as Paperclip has it now, env values dropped; keep(agent): the read model holds it;
//                               changed(id): its last run no longer says what its next run does }
//   supervision                 Supervise in office's rules of paperclip.mjs: { hooksFile(), of(id) (the supervision of a held agent),
//                               patch(agent, file) (supervisePatch), otherSettings(args, file) (its own --settings that no longer load) }
//
// The write grid. cleanWriteGrid cleans the saved slice `hqGrid`, which holds only the cells the user set (a value equal to the default
// counts: the user set it). writeValueOf gives a cell (an unknown kind is Deny: fail closed). setWriteCell changes one: a looser change,
// Deny to Confirm or Confirm to Allow, is 409 until `confirmed: true` (the painted Confirm); a value the kind does not offer is 400 (a
// secret never takes Allow). gridRows gives the rows of GET /api/hq/grid, with the labels of the kinds. Every lookup is by own key: the
// names come from requests and saved files.
// planWrite(body) gives the exact request of a write from { kind, action, ...fields }, checked before anything is asked or sent: any other
// kind or action is 400, never sent.
//
// Page routes (the office.mjs route table; the agent token never reaches them). GET /api/hq/grid gives gridRows and the self-approval
// slice (hq-model.mjs). POST /api/hq/grid/set { kind, value, confirmed } takes value null as Use default; it is 409 for a looser change
// without `confirmed: true` and 400 for Allow on a secret or an unknown kind or value; a change writes a feed line and saves
// persisted.hqGrid. POST /api/hq/write { kind, action, ...fields, confirmed } is the one writer: 409 { error, confirm: 'write', write:
// { kind, action, summary } } until the same call comes with `confirmed: true`, 403 for Deny, 400 for a bad write, 404 for a task,
// approval or agent that is not in the connected company, 409 for an approval that waits for no decision. Every Paperclip write is a
// kind of this folder: never add a second sender. A new kind is one file here plus its line in KINDS; it starts at Confirm unless its
// ticket says otherwise.
import { gridError } from './shared.mjs';
import hire from './hire.mjs';
import pause from './pause.mjs';
import budget from './budget.mjs';
import approval from './approval.mjs';
import reporting from './reporting.mjs';
import routine from './routine.mjs';
import access from './access.mjs';
import secret from './secret.mjs';
import task from './task.mjs';
import comment from './comment.mjs';
import company from './company.mjs';
import goal from './goal.mjs';
import instance from './instance.mjs';
import profile from './profile.mjs';
import adapter from './adapter.mjs';
import supervise from './supervise.mjs';
import exportKind from './export.mjs';

/** Every write kind, in the order of the write grid. */
export const KINDS = Object.freeze([hire, pause, budget, approval, reporting, routine, access, secret, task, comment, company, goal, instance, profile, adapter, supervise, exportKind]);

const STRICT = { deny: 0, confirm: 1, allow: 2 };

/**
 * The write grid and the plans of a list of kinds. The office uses one, of KINDS (WRITES, below); a test hands createHq its own list
 * (deps.writeKinds) to run the writer with a stand-in kind.
 */
export function writeRegistry(kinds) {
  const by = new Map(kinds.map((k) => [k.kind, k]));
  const kindOf = (name) => (typeof name === 'string' && by.has(name) ? by.get(name) : null);
  const table = Object.freeze(Object.fromEntries(kinds.map((k) => [k.kind, { label: k.label, options: k.options, def: k.def }])));

  /** The saved write grid: only cells the grid has, with values the kind offers. */
  function cleanWriteGrid(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) { const row = kindOf(k); if (row && row.options.includes(v)) out[k] = v; }
    return out;
  }
  /** The value of a cell: what the user set, else the default. An unknown kind is Deny (fail closed). */
  function writeValueOf(grid, kind) {
    const row = kindOf(kind);
    if (!row) return 'deny';
    const v = grid && typeof grid === 'object' && Object.hasOwn(grid, kind) ? grid[kind] : undefined;
    return row.options.includes(v) ? v : row.def;
  }
  /**
   * One change from the HQ. change: { kind, value, confirmed }. value null is Use default. A looser value (Deny to Confirm, Confirm to
   * Allow) needs confirmed: true, the painted Confirm; a stricter one applies at once. Returns { grid, from, to } with a new grid; the old
   * one is not changed. A value the kind does not offer is 400 (a secret never takes Allow, confirmed or not).
   */
  function setWriteCell(grid, change) {
    const { kind } = change || {};
    const row = kindOf(kind);
    if (!row) throw gridError(400, 'Unknown write kind.');
    const value = change.value === undefined ? null : change.value;
    if (value !== null && !row.options.includes(value)) throw gridError(400, `${row.label} cannot be set to ${String(value)}.`);
    const from = writeValueOf(grid, kind), to = value === null ? row.def : value;
    if (STRICT[to] > STRICT[from] && change.confirmed !== true) throw gridError(409, 'Confirm the looser rule first.');
    const next = { ...cleanWriteGrid(grid) };
    if (value === null) delete next[kind]; else next[kind] = value;
    return { grid: next, from, to };
  }
  /** The rows of GET /api/hq/grid: { kind, label, options, def, value, set } per kind, in grid order. */
  const gridRows = (grid) => kinds.map((k) => ({ kind: k.kind, label: k.label, options: k.options, def: k.def, value: writeValueOf(grid, k.kind), set: !!grid && Object.hasOwn(grid, k.kind) }));
  /** The exact request of a write: { kind, action, ...the action's request }. 400 for a kind or action with no plan. */
  function planWrite(b) {
    const kind = b && b.kind, action = b && b.action;
    const row = kindOf(kind);
    const make = row && typeof action === 'string' && Object.hasOwn(row.actions, action) ? row.actions[action] : null;
    if (!make) throw gridError(400, 'The office cannot make that write.');
    return { kind, action, ...make(b) };
  }
  /** What Paperclip's answer lacks for this write (null: nothing): { line, error } for the feed line and the 502. */
  function problemOf(plan, made) {
    const k = kindOf(plan.kind), p = k && k.expect ? k.expect(plan, made) : '';
    if (!p) return null;
    return typeof p === 'string' ? { line: p, error: `${p}.` } : p;
  }
  /** What the writer answers for a write it sent: { ok: true } and the ids its kind names. */
  const resultOf = (plan, made) => { const k = kindOf(plan.kind); return { ok: true, ...(k && k.result ? k.result(plan, made) : {}) }; };
  return { kinds, kindOf, table, cleanWriteGrid, writeValueOf, setWriteCell, gridRows, planWrite, problemOf, resultOf };
}

/** The office's write kinds. */
export const WRITES = writeRegistry(KINDS);
/** The grid rows as a table: { kind: { label, options, def } }, in grid order. */
export const WRITE_KINDS = WRITES.table;
export const { kindOf: writeKind, cleanWriteGrid, writeValueOf, setWriteCell, gridRows, planWrite, problemOf, resultOf } = WRITES;
