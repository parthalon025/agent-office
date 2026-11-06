// Rituals and the attention measure (#151): what the weekly recap and the while-you-were-away list read, and the merge record.
// Owns: the merge record, the measure (approvals per merge, minutes from done to merged, interruptions per hour) computed from the
// feed, the merges and the history, the weekly recap and the away list. The rules the page shares (Focus mode, reduced motion, the
// stand-up due rule, the merged moment) are in public/vocab.js (OfficeVocab.rituals).
// Pure: no I/O, no clock (the caller passes `now`). The server keeps the lists and calls these.

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const WEEK_DAYS = 7;
export const MERGES_KEPT = 100;

/** The record kept for a merge the user confirmed. The head branch links it to the session that made it. */
export function mergeRecord(repo, pr, at) {
  const number = Number(pr.number);
  return { key: `${repo}#${number}`, repo: String(repo), number, title: String(pr.title || '').slice(0, 140), head: String(pr.head || '').slice(0, 200), at };
}

// What a feed line says about the user's answers. The words are the office's own (server.mjs answer and sendMessage).
const isApproval = (f) => f.kind === 'tool' && /^approved\b/.test(f.text);
const isAnswer = (f) => isApproval(f) || (f.kind === 'tool' && /^declined\b/.test(f.text)) || (f.kind === 'prompt' && /^answered (yes|no|in the office)\b/.test(f.text));

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const round1 = (x) => Math.round(x * 10) / 10;

/** The attention measure over the last `windowMs`. A ratio with nothing to divide by is null, never 0. */
export function metrics({ feed = [], merges = [], history = [], now, windowMs = WEEK_DAYS * DAY }) {
  const from = now - windowMs;
  const lines = feed.filter((f) => f && f.t >= from && f.t <= now);
  const done = merges.filter((m) => m.at >= from && m.at <= now);
  const approvals = lines.filter(isApproval).length;
  const interruptions = lines.filter(isAnswer).length;
  const gaps = [];
  for (const m of done) {
    const h = history.find((x) => x.worktree && m.head && x.worktree.branch === m.head && x.endedAt);
    if (h && m.at >= h.endedAt) gaps.push((m.at - h.endedAt) / MIN);
  }
  const activeMs = history.reduce((n, h) => n + (h.startedAt ? overlap(h.startedAt, h.endedAt || now, from, now) : 0), 0);
  return {
    merges: done.length, approvals, interruptions,
    approvalsPerMerge: done.length ? round1(approvals / done.length) : null,
    minutesToMerge: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    interruptionsPerHour: activeMs >= 1 * MIN ? round1(interruptions / (activeMs / HOUR)) : null,
  };
}

/** The weekly recap: shipped work (newest first), the measure, the cost of sessions that started in the week, and each agent's best moment
 *  (its latest merge). history may include live sessions as { name, cost, startedAt, endedAt, worktree }. */
export function recap({ feed, merges = [], history = [], now, days = WEEK_DAYS }) {
  const from = now - days * DAY;
  const shipped = merges.filter((m) => m.at >= from && m.at <= now).sort((a, b) => b.at - a.at);
  const cost = Math.round(history.filter((h) => h.startedAt >= from && Number.isFinite(h.cost)).reduce((n, h) => n + h.cost, 0) * 100) / 100;
  const best = [], seen = new Set();
  for (const m of shipped) {
    const h = history.find((x) => x.worktree && m.head && x.worktree.branch === m.head);
    const name = h && h.name;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    best.push({ name, text: `Merged #${m.number}${m.title ? ' ' + m.title : ''}.` });
  }
  return { days, shipped, cost, metrics: metrics({ feed, merges, history, now, windowMs: days * DAY }), best };
}

/** While you were away: the feed since `since`, oldest first, a repeated line once, the newest `max` of them. */
export function away({ feed = [], since, now, max = 12 }) {
  if (!(max > 0)) return [];
  const out = [];
  for (const f of feed) {
    if (!f || f.t <= since || f.t > now) continue;
    const text = `${f.name ? f.name + ' ' : ''}${f.text}`;
    if (out.length && out[out.length - 1].text === text) continue;
    out.push({ t: f.t, text, kind: f.kind });
  }
  return out.slice(-max);
}

// ---------- the saved slices (state.mjs) ----------
/** The merge list from a saved file: a list, at most MERGES_KEPT long. */
export function cleanMerges(raw) { return Array.isArray(raw) ? raw.slice(0, MERGES_KEPT) : []; }
/** Agent name -> the day of its last stand-up: a plain map. */
export function cleanStandups(raw) { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
/** Focus mode is on only when saved as true. */
export function cleanFocus(raw) { return raw === true; }
