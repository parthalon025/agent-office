// A stand-in of the office's agent kinds for tests that build the HQ (createHq deps.kinds) without an office: the facts office.mjs passes from
// providers/index.mjs describe() (label, gated, supervision; the labels of hermes and cursor are copied from src/providers/acp.mjs and
// cli-tools.mjs), with the word of OfficeVocab.hq.kindSupervision. The real wiring is tested through the in-process office
// (test/hq-hire.test.mjs). Used by the HQ tests that hire or show an office adapter employee.
import '../../public/vocab.js';

const KINDS = {
  'claude-code': { kind: 'claude-code', label: 'Claude Code', gated: true, supervision: null },
  ollama: { kind: 'ollama', label: 'Ollama', gated: true, supervision: null },
  hermes: { kind: 'hermes', label: 'Hermes Agent', gated: false, supervision: 'Partly supervised: file edits and risky commands ask' },
  cursor: { kind: 'cursor', label: 'Cursor CLI', gated: false, supervision: 'Unsupervised' },
};

/** createHq deps.kinds: an office agent kind, or null for a kind the office does not have. */
export const officeKinds = (k) => (typeof k === 'string' && Object.hasOwn(KINDS, k) ? { ...KINDS[k], word: globalThis.OfficeVocab.hq.kindSupervision(KINDS[k]) } : null);
