// Agent character (#150): the persona record of an agent, its working style and its body cue.
// Owns: the record (name, look, style), its clean-up, the style's tone line for the system prompt, and the cue
// a status gives a bot. A style changes the TONE of what an agent says, never what it may do: the Security room
// never reads a persona (test/personas.test.mjs proves the decision is the same). A cue comes from a status
// (adapter events) only, so a bot never moves by itself, and it is none under reduced motion.
//
// Pure: no I/O, no clock (the cue rule is read from public/vocab.js, which is shared with the page). The map is injected; the server saves it in state.json (persisted.personas).

import './vocab.mjs';

export const NAME_MAX = 40;
export const SHAPES = ['round', 'square', 'tall', 'wide'];
export const ACCESSORIES = ['none', 'glasses', 'hat', 'headset', 'scarf'];
export const ROLE_MAX = 300;
export const TEAM_MAX = 8; // members of a team template
export const COLORS = 8; // the DS bot colors, by index

/** Working styles. `tone` is the one line added to the system prompt. It says how to talk, nothing about what is allowed. */
export const STYLES = Object.freeze({
  careful: { label: 'Careful', tone: 'Working style: careful. Check your work, say what you verified, and name what you are unsure about.' },
  fast: { label: 'Fast', tone: 'Working style: fast. Keep replies short, lead with the result, and leave out long explanations.' },
  chatty: { label: 'Chatty', tone: 'Working style: chatty. Be friendly, think out loud in short notes, and say what you plan to do next.' },
});

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const keyOf = (name) => String(name ?? '').trim().toLowerCase();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A clean record from user input, or null when it has no name. Unknown fields are dropped. */
export function cleanPersona(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, NAME_MAX);
  if (!name) return null;
  const p = { name };
  if (typeof raw.style === 'string' && own(STYLES, raw.style)) p.style = raw.style;
  if (SHAPES.includes(raw.shape)) p.shape = raw.shape;
  if (ACCESSORIES.includes(raw.accessory)) p.accessory = raw.accessory;
  const role = typeof raw.role === 'string' ? raw.role.trim().slice(0, ROLE_MAX) : '';
  if (role) p.role = role;
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 80) : '';
  if (model) p.model = model;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().slice(0, 40) : '';
  if (kind) p.kind = kind;
  if (Number.isInteger(raw.color) && raw.color >= 0 && raw.color < COLORS) p.color = raw.color;
  return p;
}

/** Saves a persona under the agent's name (any case). The record's name is the key. Throws a 400 for no name or a poison key. */
export function setPersona(map, name, raw) {
  const k = keyOf(name);
  const p = cleanPersona({ ...raw, name });
  if (!p || BAD_KEYS.has(k)) { const e = new Error('Give the agent a name.'); e.status = 400; throw e; }
  map[k] = p;
  return p;
}

export function removePersona(map, name) { const k = keyOf(name); if (own(map, k)) delete map[k]; }
export function personaOf(map, name) { const k = keyOf(name); return k && own(map, k) ? map[k] : null; }

/** The tone line for the system prompt: '' for no persona or no style. */
export function stylePrompt(p) { return p && typeof p.style === 'string' && own(STYLES, p.style) ? STYLES[p.style].tone : ''; }

/** The body cue of a DS status key, or null. Reduced motion gives none. The rule is one copy, in vocab.js (the page reads it too). */
export function bodyCue(status, { reduced = false } = {}) { return globalThis.OfficeVocab.persona.cueOf(status, reduced); }

/** The prompt text of a persona: its style tone and its role line. Text only: it never reaches the Security room. */
export function personaPrompt(p) {
  const role = p && typeof p.role === 'string' && p.role.trim() ? 'Role: ' + p.role.trim() : '';
  return [stylePrompt(p), role].filter(Boolean).join(' ');
}

// ---------- the customization store (#152): starters, team templates, export and import ----------
// One store in the office state file (persisted.personas, .teams, .screens, .layouts). Exported as one JSON file. Security rules,
// notes, schedules and past sessions are never in it: a shared file must not loosen anyone's rules.

/** Starter personas: a place to begin, saved only when the user asks (addStarters). */
export const STARTER_PERSONAS = Object.freeze({
  reviewer: { name: 'Reviewer', style: 'careful', role: 'Review changes. Read the diff, run the tests and list the problems you find.', shape: 'square', accessory: 'glasses', color: 1 },
  fixer: { name: 'Fixer', style: 'fast', role: 'Fix one small bug or task at a time. Keep the change small.', shape: 'wide', accessory: 'headset', color: 3 },
  researcher: { name: 'Researcher', style: 'chatty', role: 'Find facts in the code and the docs. Report what you found and where.', shape: 'tall', accessory: 'scarf', color: 5 },
});
/** Starter team templates. Members are persona names. */
export const STARTER_TEAMS = Object.freeze({
  'fix-and-review': { name: 'Fix and review', members: ['Researcher', 'Fixer', 'Reviewer'] },
});

/** Saves each starter the user does not have yet. Never overwrites. Returns how many it added. */
export function addStarters(map) {
  let n = 0;
  for (const [k, p] of Object.entries(STARTER_PERSONAS)) if (!own(map, k)) { map[k] = cleanPersona(p); n++; }
  return n;
}
export function addStarterTeams(map) {
  let n = 0;
  for (const t of Object.values(STARTER_TEAMS)) { const key = keyOf(t.name); if (!own(map, key)) { map[key] = cleanTeam(t); n++; } }
  return n;
}

/** A clean team record, or null for no name or no member. Members are unique persona names, at most TEAM_MAX. */
export function cleanTeam(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, NAME_MAX);
  if (!name || !Array.isArray(raw.members)) return null;
  const seen = new Set(), members = [];
  for (const m of raw.members) {
    const n = typeof m === 'string' ? m.trim().slice(0, NAME_MAX) : '';
    if (n && !seen.has(keyOf(n)) && members.length < TEAM_MAX) { seen.add(keyOf(n)); members.push(n); }
  }
  return members.length ? { name, members } : null;
}
export function setTeam(map, name, raw) {
  const k = keyOf(name);
  const t = cleanTeam({ ...raw, name });
  if (!t || BAD_KEYS.has(k)) { const e = new Error('Give the team a name and a member.'); e.status = 400; throw e; }
  map[k] = t;
  return t;
}
export function removeTeam(map, name) { const k = keyOf(name); if (own(map, k)) delete map[k]; }
export function teamOf(map, name) { const k = keyOf(name); return k && own(map, k) ? map[k] : null; }

const FORMAT = 'agent-office-customization';
const cleanMap = (raw, clean) => {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) { const c = BAD_KEYS.has(keyOf(k)) ? null : clean(v, k); if (c) out[keyOf(k)] = c; }
  return out;
};
const cleanPersonas = (raw) => cleanMap(raw, (v) => cleanPersona(v));
const cleanTeams = (raw) => cleanMap(raw, (v) => cleanTeam(v));
const cleanScreens = (raw) => cleanMap(raw, (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null));
export { cleanPersonas, cleanTeams, cleanScreens };

/** The wall screen of a room (#152): which blackboard view it shows. Saved by room key; Overview is the default and clears the entry. */
export function setScreen(map, key, view) {
  const k = keyOf(key);
  if (!k || BAD_KEYS.has(k)) { const e = new Error('Pick a room first.'); e.status = 400; throw e; }
  if (!globalThis.OfficeVocab.wall.isView(view)) { const e = new Error('This wall screen has no such view.'); e.status = 400; throw e; }
  if (view === 'overview') delete map[k]; else map[k] = view;
  return view;
}

/** The state's customization as one JSON-safe object. Nothing else of the state goes in. */
export function exportCustom(state) {
  const st = state && typeof state === 'object' ? state : {};
  return { format: FORMAT, version: 1, personas: st.personas || {}, teams: st.teams || {}, screens: st.screens || {}, layouts: st.layouts || {} };
}

/** A clean customization from an exported file. Throws a 400 for anything else. Takes { cleanLayout } (the server's layout rule). */
export function importCustom(raw, { cleanLayout = () => null } = {}) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) { const e = new Error('This is not an Agent Office customization file.'); e.status = 400; throw e; }
  return { personas: cleanPersonas(raw.personas), teams: cleanTeams(raw.teams), screens: cleanScreens(raw.screens), layouts: cleanMap(raw.layouts, (v) => cleanLayout(v)) };
}
