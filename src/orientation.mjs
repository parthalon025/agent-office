// Orientation (#196, parent #191): the first-run walk through the whole office. Each step is skippable and reachable again from the
// Reception and Ctrl+K. This module owns the steps, their words and the saved progress (the `orientation` slice of the state file:
// `{ seen, steps: { <id>: 'done' | 'skipped' } }`); the page draws each step's own controls and keeps no copy of the list.
// The company step (#199) installs or connects Paperclip and creates the company; the first hire (#201) is the HR desk. A `later` step is a
// placeholder the page says so for: the memory step. Pure: no I/O, no clock.
import { httpError } from './office-core.mjs';

/** The steps in order. Words are Simplified Technical English: short sentences, buttons say the result. */
export const STEPS = [
  { id: 'kinds', title: 'Agent kinds', text: 'See which agent kinds are installed and ready. You can run a ready kind now.' },
  { id: 'security', title: 'Security room', text: 'Every call of every agent asks you first, unless you set a rule. Look at the rules before an agent runs.' },
  { id: 'spend', title: 'Spend limit', text: 'Set the most one paid session may spend. The office stops the session at this limit.' },
  { id: 'startup', title: 'Start with Windows', text: 'Start the office when you sign in. It is off until you turn it on.' },
  { id: 'remote', title: 'Remote access', text: 'Reach the office from your phone through Cloudflare Access. It is off until you set it up.' },
  { id: 'company', title: 'Company', text: 'Install Paperclip or connect the one you run. Then create your company. You make the first account and approve the board key in Paperclip. The office waits for you.' },
  { id: 'hire', title: 'First hire', text: 'Hire your first employee at the HR desk. Pick a role and set a monthly budget. You see what the office creates before it sends anything.' },
  { id: 'memory', title: 'Company memory', text: 'Set up the memory your employees learn from.', later: true },
  { id: 'tour', title: 'Tour', text: 'Walk around the office. The tour has four stops.' },
];
const IDS = new Set(STEPS.map((s) => s.id));
const WORDS = new Set(['done', 'skipped']);

/** The saved progress in one form: `seen` is true after the user closed Orientation once; unknown steps and words drop out. */
export function cleanOrientation(raw) {
  const out = { seen: false, steps: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.seen = raw.seen === true;
  const steps = raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps) ? raw.steps : {};
  for (const id of IDS) if (Object.hasOwn(steps, id) && WORDS.has(steps[id])) out.steps[id] = steps[id];
  return out;
}

/** Mark a step 'done' or 'skipped', or 'open' to put it back. Changes `state` in place; a bad step or word is a 400. */
export function mark(state, step, status) {
  if (!IDS.has(step)) throw httpError(400, 'Unknown step.');
  if (status === 'open') delete state.steps[step];
  else if (WORDS.has(status)) state.steps[step] = status;
  else throw httpError(400, 'A step is done, skipped or open.');
  return state;
}

/**
 * What the page reads: each step with its status, `next` (the first step not done or skipped, else the first skipped one, else
 * none), `finished` (no step left open) and `skipped` (the ids the user can still reach).
 */
export function view(state) {
  const steps = STEPS.map((s) => ({ ...s, status: state.steps[s.id] || 'open' }));
  const open = steps.find((s) => s.status === 'open');
  const skipped = steps.filter((s) => s.status === 'skipped').map((s) => s.id);
  return { seen: state.seen === true, steps, next: open ? open.id : skipped[0] || null, finished: !open, skipped };
}
