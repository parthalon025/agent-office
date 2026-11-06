// Agent character (#150): the persona record of an agent, its working style and its body cue.
// Owns: the record (name, look, style), its clean-up, the style's tone line for the system prompt, and the cue
// a status gives a bot. A style changes the TONE of what an agent says, never what it may do: the Security room
// never reads a persona (test/personas.test.mjs proves the decision is the same). A cue comes from a status
// (adapter events) only, so a bot never moves by itself, and it is none under reduced motion.
//
// Pure: no I/O, no clock (the cue rule is read from public/vocab.js, which is shared with the page). The map is injected; the server saves it in state.json (persisted.personas).

import './public/vocab.js';

export const NAME_MAX = 40;
export const SHAPES = ['round', 'square', 'tall', 'wide'];
export const ACCESSORIES = ['none', 'glasses', 'hat', 'headset', 'scarf'];
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
