// What every HQ write kind shares (#232): the error a refusal throws, the plain id and the text checks, the limits, the values more
// than one kind writes, and the sample ids of the samples. One copy: the write kinds of this folder import it, and so do hq-model.mjs
// (ID_RE, short, gridError) and paperclip.mjs (obj, strings, text, gridError). Pure, and it imports nothing.

/** The three values of a write grid cell. */
export const RULES = ['confirm', 'allow', 'deny'];
/** A refusal: an Error with the HTTP status the route answers. */
export const gridError = (status, message) => Object.assign(new Error(message), { status });

/** A plain id: it goes into a path, so nothing else is let in. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// The limits of what the office writes.
export const TITLE_MAX = 200, TEXT_MAX = 10000, NOTE_MAX = 2000, DESC_MAX = 4000, NAME_MAX = 80, COMPANY_DESC_MAX = 300;
export const HIRE_BUDGET_MAX = 100000;   // dollars a month, for a hire and for a budget: a typing slip (an extra zero) is refused, not sent
// What a company export and a company import may name (Paperclip companyPortabilityExportSchema and the import's include).
export const EXPORT_INCLUDES = ['company', 'agents', 'projects', 'issues', 'skills'];

export const short = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** A plain id from a write body, else 400 "Give the <what>." */
export function idOf(v, what) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw gridError(400, `Give the ${what}.`);
  return v;
}
/** Text from a write body: trimmed, at most max characters ('' when not given), else 400 with the reason. */
export function textOf(v, what, max, { required = false } = {}) {
  if (v === undefined || v === null) { if (required) throw gridError(400, `Give the ${what}.`); return ''; }
  if (typeof v !== 'string') throw gridError(400, `The ${what} must be text.`);
  const t = v.trim();
  if (required && !t) throw gridError(400, `Give the ${what}.`);
  if (t.length > max) throw gridError(400, `The ${what} is too long (at most ${max} characters).`);
  return t;
}

// Reading what Paperclip answers: an object (else {}), the strings of a list, and text on one line, cut.
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
export const text = (v, n = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// The ids of the samples of the kinds (test/hq-writes.test.mjs and test/paperclip-contract.test.mjs). Each is a letter or two and a
// digit, so the contract test reads it as a path parameter; a sample request names it as ${SAMPLE.<thing>} for the same reason. The
// company of every sample request is SAMPLE.co.
export const SAMPLE = Object.freeze({ co: 'c1', issue: 'i1', agent: 'a1', manager: 'a2', approval: 'ap1', goal: 'g1', routine: 'r1', trigger: 't1', invite: 'v1', join: 'j1', member: 'm1', environment: 'e1', project: 'pr1' });
