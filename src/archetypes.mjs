// Function floors (#88, #92): the function catalog, the archetypes and the detection of a building's archetype.
// Data plus pure functions, like place.mjs: no I/O, no timers, safe to import in tests. The server keeps one record per
// building (persisted.layouts[buildingKey]) and sends the floors it gives (layoutView) in the snapshot; the page keeps no copy.
//   function catalog  every floor type, grouped in wings. Floor names, roles and words are strings here, so a user can rename a
//                     floor and a later preset needs no code.
//   archetype         a preset of floors for a kind of work. Every building also has the Lobby (ground floor) and Records (top).
//   detection         from file names at the repository root and one level down. Mixed or unclear gives General.
//   record            { proposed, why, archetype, confirmed, floors: [{ id, hidden? }], names: { id: name } }. Detection runs once:
//                     the record keeps the result, and only a user action (edit) changes it.
// newRecord and cleanRecord make the record of a building. edit(rec, op) applies the user's changes to it: confirm, switch, rename,
// add, hide, show, move. floorsOf gives the floors (Lobby first, Records last) and floorOfKind seats an agent kind. The snapshot
// carries layouts[key] (layoutView) and `catalog` (catalogView). Tested in test/archetypes.test.mjs.

export const WINGS = [
  { id: 'product', name: 'Product and tech' },
  { id: 'market', name: 'Go to market' },
  { id: 'corporate', name: 'Corporate' },
  { id: 'operations', name: 'Operations' },
  { id: 'leadership', name: 'Leadership' },
];

// role: the DS role icon of the floor (the desk type and the badge of an agent seated there).
// words: the agent kinds that seat on this floor (an agent type or definition name such as "reviewer" or "lane-hard").
const F = (id, name, wing, role, words) => ({ id, name, wing, role, words: words || [] });
export const FUNCTIONS = [
  F('lobby', 'Lobby', '', 'planner'),
  F('records', 'Records', 'operations', 'ops', ['records', 'record', 'archivist', 'changelog']),
  // Product and tech
  F('engineering', 'Engineering', 'product', 'coder', ['engineer', 'engineering', 'coder', 'code', 'developer', 'dev', 'implement', 'implementer', 'build', 'builder', 'lane']),
  F('quality', 'Quality', 'product', 'analyst', ['quality', 'review', 'reviewer', 'test', 'tester', 'qa', 'verify', 'verifier', 'audit', 'auditor', 'check']),
  F('security', 'Security', 'product', 'ops', ['security', 'secure', 'pentest', 'threat', 'vuln']),
  F('it-ops', 'IT and Ops', 'product', 'ops', ['ops', 'infra', 'infrastructure', 'deploy', 'devops', 'sre', 'platform']),
  F('design', 'Design', 'product', 'designer', ['design', 'designer', 'ui', 'ux']),
  F('docs', 'Docs', 'product', 'writer', ['docs', 'doc', 'documentation', 'writer', 'technical-writer']),
  F('research', 'Research', 'product', 'research', ['research', 'researcher', 'explore', 'explorer', 'search', 'investigate', 'investigator']),
  F('work', 'Work', 'product', 'coder', ['work', 'worker', 'general-purpose']),
  F('review', 'Review', 'product', 'analyst', ['review', 'reviewer', 'check', 'verify']),
  // Go to market
  F('sales', 'Sales', 'market', 'sales', ['sales', 'seller']),
  F('marketing', 'Marketing', 'market', 'writer', ['marketing', 'marketer', 'campaign']),
  F('customer-success', 'Customer success', 'market', 'csam', ['customer', 'success', 'csm']),
  F('partnerships', 'Partnerships', 'market', 'partner', ['partner', 'partnerships', 'alliance']),
  F('communications', 'Communications', 'market', 'writer', ['communications', 'comms', 'announce', 'release-notes', 'blog']),
  F('support', 'Support', 'market', 'csa', ['support', 'helpdesk', 'triage', 'triager']),
  // Corporate
  F('finance', 'Finance', 'corporate', 'analyst', ['finance', 'cost', 'budget', 'billing']),
  F('legal', 'Legal and compliance', 'corporate', 'analyst', ['legal', 'compliance', 'license', 'licensing']),
  F('people', 'People', 'corporate', 'planner', ['people', 'hr', 'hiring', 'recruiter']),
  F('procurement', 'Procurement', 'corporate', 'analyst', ['procurement', 'purchasing', 'vendor']),
  F('facilities', 'Facilities', 'corporate', 'ops', ['facilities', 'office']),
  // Operations
  F('supply-chain', 'Supply chain', 'operations', 'ops', ['supply', 'logistics', 'inventory']),
  F('delivery', 'Delivery', 'operations', 'planner', ['delivery', 'release', 'shipping']),
  F('field-operations', 'Field operations', 'operations', 'fde', ['field', 'onsite']),
  F('capture', 'Capture', 'operations', 'research', ['capture', 'clip', 'clipper', 'inbox', 'ingest']),
  F('organize', 'Organize', 'operations', 'analyst', ['organize', 'organizer', 'curate', 'curator', 'tag', 'link']),
  F('publish', 'Publish', 'operations', 'writer', ['publish', 'publisher', 'editor', 'edit']),
  F('archive', 'Archive', 'operations', 'ops', ['archive', 'archiver']),
  // Leadership
  F('executive', 'Executive', 'leadership', 'planner', ['executive', 'manager', 'orchestrator', 'lead', 'chief', 'director']),
  F('planning', 'Planning', 'leadership', 'planner', ['plan', 'planner', 'planning', 'architect', 'roadmap']),
  F('strategy', 'Strategy', 'leadership', 'planner', ['strategy', 'strategist']),
  F('governance', 'Governance', 'leadership', 'analyst', ['governance', 'policy', 'risk']),
];
const BY_ID = new Map(FUNCTIONS.map((f) => [f.id, f]));
const WING_NAME = new Map(WINGS.map((w) => [w.id, w.name]));
export const LOBBY = 'lobby', RECORDS = 'records';
const FIXED = new Set([LOBBY, RECORDS]);

export const ARCHETYPES = [
  { id: 'software', name: 'Software product', floors: ['engineering', 'quality', 'security', 'it-ops', 'design', 'support', 'docs'] },
  { id: 'knowledge', name: 'Knowledge base', floors: ['capture', 'organize', 'publish', 'archive'] },
  { id: 'ops-hub', name: 'Operations Hub', floors: ['executive', 'planning', 'research', 'engineering', 'quality', 'security', 'it-ops', 'communications'] },
  { id: 'general', name: 'General', floors: ['work', 'review'] },
];
const ARCH = new Map(ARCHETYPES.map((a) => [a.id, a]));
export const GENERAL = 'general';

/** The catalog entry of a function id, or null. */
export function functionOf(id) { return BY_ID.get(String(id || '')) || null; }
/** The archetype of an id, or null. */
export function archetypeOf(id) { return ARCH.get(String(id || '')) || null; }

// ---------- detection ----------
const MANIFESTS = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|gemfile|composer\.json|cmakelists\.txt|makefile|deno\.json|mix\.exs|[^/]+\.(csproj|fsproj|sln))$/i;
const TEST_DIRS = /^(test|tests|spec|specs|__tests__|e2e)\/$/i;
const TEST_FILE = /(^|\/)[^/]+(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
const SRC_DIRS = /^(src|lib|app|cmd|pkg|internal|public|server|client)\/$/i;
const VAULTS = /^\.(obsidian|logseq|foam|dendron)\/$/i;
const AGENT_DIRS = /^\.claude\/(agents|worktrees)\/$/i;
const MARKDOWN = /\.(md|markdown|mdx|org|txt)$/i;
const CODE = /\.(m?js|cjs|ts|tsx|jsx|py|rs|go|java|kt|cs|cpp|c|h|rb|php|swift|scala|ex|exs)$/i;

/** The archetype a repository looks like, from its file names. names: paths relative to the repository root, at the root and
 *  one level down, with a trailing '/' on a folder ('package.json', 'test/', 'test/a.test.mjs', '.obsidian/'). Anything
 *  deeper is ignored. Returns { archetype, why }. A mixed or unclear repository gives General. */
export function detect(names) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').replace(/\\/g, '/').replace(/^\.\//, '')).filter((n) => n && n.split('/').filter(Boolean).length <= 2);
  const root = list.filter((n) => !n.replace(/\/$/, '').includes('/'));
  const rootFiles = root.filter((n) => !n.endsWith('/'));
  const manifest = rootFiles.some((n) => MANIFESTS.test(n));
  const tests = root.some((n) => TEST_DIRS.test(n)) || list.some((n) => TEST_FILE.test(n));
  const src = root.some((n) => SRC_DIRS.test(n)) || rootFiles.filter((n) => CODE.test(n)).length >= 3;
  const vault = root.some((n) => VAULTS.test(n));
  const agents = list.some((n) => AGENT_DIRS.test(n));
  const md = list.filter((n) => MARKDOWN.test(n)).length, code = list.filter((n) => CODE.test(n)).length;
  const software = manifest && (tests || src);
  const notes = vault || (!manifest && md >= 5 && code === 0);
  if (software && notes) return { archetype: GENERAL, why: 'The folder has both code and a notes vault.' };
  if (software && agents) return { archetype: 'ops-hub', why: 'A package manifest, tests or sources, and Claude Code agents or worktrees.' };
  if (software) return { archetype: 'software', why: tests ? 'A package manifest and tests.' : 'A package manifest and sources.' };
  if (notes) return { archetype: 'knowledge', why: vault ? 'A notes vault folder.' : 'Mostly notes and documents, no code.' };
  return { archetype: GENERAL, why: 'The folder does not clearly show one kind of work.' };
}

// ---------- the record of a building ----------
function presetFloors(archetype) { return (archetypeOf(archetype) || archetypeOf(GENERAL)).floors.map((id) => ({ id })); }
/** A new record from a detection result. Not confirmed: the reception memo asks the user once. */
export function newRecord(found) {
  const a = archetypeOf(found && found.archetype) ? found.archetype : GENERAL;
  return { proposed: a, why: String((found && found.why) || ''), archetype: a, confirmed: false, floors: presetFloors(a), names: {} };
}
/** An older or hand-edited record in the one form: known archetype, known function ids once each, no Lobby or Records in
 *  the list (they are fixed), names as short strings. A record that is not an object gives null. */
export function cleanRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const a = archetypeOf(rec.archetype) ? rec.archetype : GENERAL;
  const seen = new Set(), floors = [];
  for (const f of Array.isArray(rec.floors) ? rec.floors : []) {
    const id = f && typeof f === 'object' ? String(f.id || '') : String(f || '');
    if (!BY_ID.has(id) || FIXED.has(id) || seen.has(id)) continue;
    seen.add(id); floors.push(f && f.hidden ? { id, hidden: true } : { id });
  }
  const names = {};
  for (const [k, v] of Object.entries(rec.names && typeof rec.names === 'object' ? rec.names : {})) {
    const n = cleanName(v);
    if (BY_ID.has(k) && n) names[k] = n;
  }
  const hidden = rec.recordsHidden === true;
  return { proposed: archetypeOf(rec.proposed) ? rec.proposed : a, why: String(rec.why || ''), archetype: a, confirmed: rec.confirmed === true,
    floors: floors.length ? floors : presetFloors(a), names, ...(hidden ? { recordsHidden: true } : {}) };
}
const cleanName = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);

/** The floors of a building, ground floor first: Lobby, the function floors in the user's order, then Records.
 *  Each is { id, name, wing, wingName, role, hidden, fixed }. Hidden floors are in the list (the reception shows them). */
export function floorsOf(rec) {
  const r = cleanRecord(rec) || newRecord(null);
  const one = (id, hidden) => {
    const f = BY_ID.get(id);
    return { id, name: r.names[id] || f.name, wing: f.wing, wingName: WING_NAME.get(f.wing) || '', role: f.role, hidden: !!hidden, fixed: FIXED.has(id) };
  };
  return [one(LOBBY, false), ...r.floors.map((f) => one(f.id, f.hidden)), one(RECORDS, r.recordsHidden)];
}
/** The floors the elevator shows: floorsOf without the hidden ones. */
export function shownFloors(rec) { return floorsOf(rec).filter((f) => !f.hidden); }

/** One user change to a record. Returns the new record; the old one does not change. Throws an Error with a message for
 *  the user when the change is not possible. op: { action, archetype?, floor?, name?, by? }
 *    confirm   the proposed archetype is right (or op.archetype: confirm another one); the memo does not ask again
 *    switch    another archetype: its preset floors, the user's names stay
 *    rename    op.floor gets op.name ('' gives the catalog name back)
 *    add       op.floor from the catalog goes on top of the function floors (below Records)
 *    hide      op.floor is not shown (not the Lobby). show: it is shown again
 *    move      op.floor moves op.by places up (+1) or down (-1) among the function floors */
export function edit(rec, op) {
  const r = cleanRecord(rec) || newRecord(null);
  const id = String((op && op.floor) || '');
  const fn = BY_ID.get(id);
  const need = () => { if (!fn) throw new Error('No such floor.'); };
  switch (op && op.action) {
    case 'confirm': case 'switch': {
      const a = op.archetype ? String(op.archetype) : r.archetype;
      if (!archetypeOf(a)) throw new Error('No such archetype.');
      const out = { ...r, archetype: a, confirmed: true };
      if (a !== r.archetype || op.action === 'switch') out.floors = presetFloors(a);
      return out;
    }
    case 'rename': {
      need();
      const names = { ...r.names }, n = cleanName(op.name);
      if (n && n !== fn.name) names[id] = n; else delete names[id];
      return { ...r, names };
    }
    case 'add': {
      need();
      if (FIXED.has(id)) throw new Error(`${fn.name} is on every building.`);
      if (r.floors.some((f) => f.id === id)) {
        if (!r.floors.find((f) => f.id === id).hidden) throw new Error(`${fn.name} is already a floor.`);
        return { ...r, floors: r.floors.map((f) => (f.id === id ? { id } : f)) };
      }
      return { ...r, floors: [...r.floors, { id }] };
    }
    case 'hide': case 'show': {
      need();
      const hidden = op.action === 'hide';
      if (id === LOBBY) throw new Error('The Lobby is on every building.');
      if (id === RECORDS) { const out = { ...r }; if (hidden) out.recordsHidden = true; else delete out.recordsHidden; return out; }
      if (!r.floors.some((f) => f.id === id)) throw new Error(`${fn.name} is not a floor of this building.`);
      if (hidden && r.floors.filter((f) => !f.hidden && f.id !== id).length === 0) throw new Error('A building keeps at least one function floor.');
      return { ...r, floors: r.floors.map((f) => (f.id === id ? (hidden ? { id, hidden: true } : { id }) : f)) };
    }
    case 'move': {
      need();
      const i = r.floors.findIndex((f) => f.id === id), by = Number(op.by) > 0 ? 1 : -1, j = i + by;
      if (i < 0) throw new Error(`${fn.name} cannot move.`);
      if (j < 0 || j >= r.floors.length) return r;
      const floors = r.floors.slice();
      [floors[i], floors[j]] = [floors[j], floors[i]];
      return { ...r, floors };
    }
    default: throw new Error('Unknown change.');
  }
}

/** What the snapshot carries for one building: the record's facts and its floors (floorsOf). */
export function layoutView(rec) {
  const r = cleanRecord(rec) || newRecord(null);
  return { archetype: r.archetype, archetypeName: archetypeOf(r.archetype).name, proposed: r.proposed, proposedName: archetypeOf(r.proposed).name,
    why: r.why, confirmed: r.confirmed, floors: floorsOf(r) };
}
/** The catalog as the page offers it (Add floor, Switch): fixed while the server runs. */
export function catalogView() {
  return {
    wings: WINGS.map((w) => ({ ...w })),
    functions: FUNCTIONS.filter((f) => !FIXED.has(f.id)).map((f) => ({ id: f.id, name: f.name, wing: f.wing, wingName: WING_NAME.get(f.wing) || '' })),
    archetypes: ARCHETYPES.map((a) => ({ id: a.id, name: a.name, floors: a.floors.map((id) => BY_ID.get(id).name) })),
  };
}

/** The floor of a building that an agent kind seats on. kind: an agent type or definition name ("code-reviewer",
 *  "lane-hard"). The last word of the name says the job ("code-reviewer" is a reviewer), so the words are tried from the
 *  last one back; for each, the first shown floor (bottom up) that has it wins. floors: shownFloors. Null when none matches. */
export function floorOfKind(kind, floors) {
  const whole = String(kind || '').toLowerCase();
  const words = whole.split(/[^a-z0-9]+/).filter(Boolean);
  const list = (floors || []).filter((f) => f.id !== LOBBY && BY_ID.has(f.id));
  for (const f of list) if (BY_ID.get(f.id).words.some((w) => w.includes('-') && whole.includes(w))) return f.id;   // a whole name ("general-purpose")
  for (let i = words.length - 1; i >= 0; i--) {
    const hit = list.find((f) => BY_ID.get(f.id).words.includes(words[i]));
    if (hit) return hit.id;
  }
  return null;
}
