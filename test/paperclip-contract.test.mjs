// Contract test (pinned release): every Paperclip route the office sends or reads exists in the release it pins, and the
// values the office writes fit the validators of that release. The release comes from `npm run paperclip:source`
// (test/paperclip-source.mjs) into .paperclip-source/. Without it the test is skipped, so a run with no network passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_DIR, current } from './paperclip-source.mjs';
import { PINNED } from '../src/paperclip-runtime.mjs';
import { planWrite } from '../src/hq-model.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
const ROOT = path.resolve(HERE, '..');
const have = current();
const skip = have ? false : 'The pinned Paperclip source is not on disk. Run: npm run paperclip:source';

const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (dir, keep = () => true) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, keep)); else if (keep(p)) out.push(p);
  }
  return out;
};

// ---------- the routes of the release ----------
const norm = (p) => p.replace(/\/+$/, '').replace(/:[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\??/g, ':p').replace(/\$\{[^}]*\}/g, ':p') || '/';

/** String constants of the server and shared packages (`const NAME = "/x"`), to resolve routes declared with a name. */
function constants(files) {
  const map = new Map();
  for (const f of files) for (const m of read(f).matchAll(/(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'`])([^"'`\n]*)\2\s*;/g)) map.set(m[1], m[3]);
  return map;
}

function releaseRoutes() {
  const server = path.join(SOURCE_DIR, 'server', 'dist'), shared = path.join(SOURCE_DIR, 'shared', 'dist');
  const routeFiles = walk(path.join(server, 'routes'), (p) => p.endsWith('.js'));
  const consts = constants([...routeFiles, path.join(server, 'app.js'), ...walk(shared, (p) => p.endsWith('.js'))]);
  const prefix = { 'health.js': '/api/health', 'companies.js': '/api/companies', 'auth.js': '/api/auth' };
  const routes = new Set(), unresolved = [], schemas = new Map();
  const resolve = (expr) => {
    expr = expr.trim();
    let m;
    if ((m = /^(["'`])([^"'`]*)\1$/.exec(expr))) return [m[2]];
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*(["'`])([^"'`]*)\2$/.exec(expr))) return consts.has(m[1]) ? [consts.get(m[1]) + m[3]] : null;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) return consts.has(expr) ? [consts.get(expr)] : null;
    if (expr.startsWith('[')) { const parts = [...expr.matchAll(/(["'`])([^"'`]*)\1/g)].map((x) => x[2]); return parts.length ? parts : null; }
    return null;
  };
  for (const f of routeFiles) {
    const base = path.basename(f), pre = prefix[base] ?? '/api';
    const text = read(f);
    for (const m of text.matchAll(/\brouter\.(get|post|patch|put|delete)\(\s*(\[[^\]]*\]|[^,]+?)\s*,/g)) {
      const paths = resolve(m[2]);
      if (!paths) { unresolved.push(`${base}: ${m[1]} ${m[2].slice(0, 60)}`); continue; }
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 260).split(/async\s*\(/)[0];
      const schema = (/validate\w*\(\s*([A-Za-z_]\w*)\s*\)/.exec(tail) || [])[1];
      for (const p of paths) { const key = `${m[1].toUpperCase()} ${norm(pre + p)}`; routes.add(key); if (schema) schemas.set(key, schema); }
    }
  }
  return { routes, unresolved, schemas };
}

/** The keys at the top level of the `{ ... }` that starts at text[at] (the character after the brace). */
function topKeys(text, at) {
  const keys = new Set();
  let depth = 1, i = at, lineStart = true;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (depth === 1 && lineStart) { const k = /^\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*:/.exec(text.slice(i, i + 120)); if (k) keys.add(k[1] || k[2]); lineStart = false; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1; else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    if (ch === '\n') lineStart = true;
    i += 1;
  }
  return keys;
}

/** The keys of a zod schema of the shared package, read from its source: `NAME = z.object({...})`, its `.extend({...})` and the base schema it starts from. Omit is ignored, so this is a superset. null: not found. */
function schemaKeys(name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  for (const f of walk(path.join(SOURCE_DIR, 'shared', 'dist', 'validators'), (p) => p.endsWith('.js'))) {
    const text = read(f), at = text.search(new RegExp(`(?:export )?const ${name}\\s*=`));
    if (at < 0) continue;
    const next = text.slice(at + 10).search(/\n(?:export )?(?:const|function) /);
    const body = next < 0 ? text.slice(at) : text.slice(at, at + 10 + next);
    const keys = new Set();
    for (const m of body.matchAll(/(?:\bobject|\.extend|\.merge)\(\s*\{/g)) for (const k of topKeys(body, m.index + m[0].length)) keys.add(k);
    const base = /=\s*(?:\w+\(\s*)*([A-Za-z_]\w*Schema|[A-Za-z_]\w*BaseSchema)\b/.exec(body);
    if (base) { const sub = schemaKeys(base[1], seen); if (sub) for (const k of sub) keys.add(k); }
    return keys;
  }
  return null;
}


// ---------- the routes the office uses ----------
const METHOD = /method:\s*['"](GET|POST|PATCH|PUT|DELETE)['"]/;

/**
 * The alternatives of one template path. `${a ? 'x' : 'y'}` gives both words; `${route}` after a slash is the route word of
 * the helper that builds the write (decision(...), employeeStep(...)), read from its call sites; a `${...}` glued to a word is a
 * query or a suffix and goes; any other `${...}` is an id.
 */
function expand(raw, text) {
  const helper = /^\/api\/approvals\//.test(raw) ? /\bdecision\('[a-z]+',\s*'([a-z-]+)'/g : /^\/api\/agents\//.test(raw) ? /\bemployeeStep\('([a-z-]+)'/g : null;
  let out = [raw];
  const step = (re, f) => { out = out.flatMap((p) => { const m = re.exec(p); return m ? f(m, p) : [p]; }); };
  for (let n = 0; n < 6; n += 1) {
    step(/\$\{[^}?]+\?\s*'([^']*)'\s*:\s*(?:[^}?]+\?\s*'([^']*)'\s*:\s*)?'([^']*)'\}/, (m, p) => [m[1], m[2], m[3]].filter((x) => x !== undefined).map((w) => p.replace(m[0], w)));
    step(/\/\$\{route\}/, (m, p) => (helper ? [...text.matchAll(helper)].map((x) => p.replace(m[0], `/${x[1]}`)) : [p]));
    step(/([^/])\$\{[^}]*\}(?=$|\/)/, (m, p) => [p.replace(m[0], m[1])]);
  }
  return out;
}

/** Paperclip paths in a source file: `/api/...` strings and template literals, with the method written on the same line. */
function officeRoutes(file) {
  const found = [], text = read(file);
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(/`(\/api\/[^`]*)`|(["'])(\/api\/[^"']*)\2/g)) {
      const raw = (m[1] || m[3]).replace(/\?[a-z]+=.*$/, '');
      if (/^\/api\/(hq|paperclip|office|open|answer|merge|security|settings)\b/.test(raw)) continue;
      const method = /preflight:\s*\{\s*path/.test(line) ? 'POST' : (METHOD.exec(line) || [, 'GET'])[1];
      for (const p of expand(raw, text)) found.push({ method, path: norm(p), where: `${path.relative(ROOT, file)}:${i + 1}`, raw });
    }
  });
  return found;
}

const OFFICE_FILES = ['src/paperclip.mjs', 'src/hq-model.mjs', 'src/paperclip-runtime.mjs'].map((f) => path.join(ROOT, f));

test('the pinned source is the pinned version', { skip }, () => {
  const marker = JSON.parse(read(path.join(SOURCE_DIR, 'office-source.json')));
  assert.equal(marker.version, PINNED.version);
  assert.equal(JSON.parse(read(path.join(SOURCE_DIR, 'paperclipai', 'package.json'))).version, PINNED.version);
  assert.equal(JSON.parse(read(path.join(SOURCE_DIR, 'server', 'package.json'))).version, PINNED.version);
});

test('the route reader finds the routes of the release', { skip }, () => {
  const { routes, unresolved } = releaseRoutes();
  assert.ok(routes.size > 800, `only ${routes.size} routes read`);
  assert.ok(routes.has('GET /api/health'));
  assert.ok(routes.has('GET /api/companies/:p/agents'));
  assert.ok(unresolved.length < 40, `too many routes the reader cannot name: ${unresolved.join('; ')}`);
});

test('every Paperclip route the office sends or reads exists in the pinned release', { skip }, () => {
  const { routes } = releaseRoutes();
  const missing = [], checked = [];
  for (const f of OFFICE_FILES) for (const r of officeRoutes(f)) {
    const key = `${r.method} ${r.path}`;
    checked.push(key);
    if (!routes.has(key)) missing.push(`${key}  (${r.where})`);
  }
  assert.ok(checked.length > 30, 'the reader found too few office routes');
  if (process.env.CONTRACT_LIST) console.log([...new Set(checked)].sort().join('\n'));
  assert.deepEqual(missing, [], `Routes the pinned release ${PINNED.version} does not have:\n${missing.join('\n')}`);
});

// One example input for every write plan of the office (planWrite). Its body keys must be keys of the validator the release runs on that route.
const SAMPLES = [
  { kind: 'task', action: 'create', title: 'T', description: 'D', status: 'todo', parentId: 'p1', assigneeAgentId: 'a1' },
  { kind: 'task', action: 'status', issue: 'i1', status: 'done' },
  { kind: 'task', action: 'assign', issue: 'i1', agent: 'a1' },
  { kind: 'comment', action: 'add', issue: 'i1', text: 'hello' },
  { kind: 'approval', action: 'approve', approval: 'ap1', note: 'n' },
  { kind: 'approval', action: 'reject', approval: 'ap1', note: 'n' },
  { kind: 'approval', action: 'revise', approval: 'ap1', note: 'n' },
  { kind: 'hire', action: 'create', name: 'N', role: 'engineer', title: 'T', manager: 'a1', model: 'sonnet', budgetDollars: 10, skills: [] },
  { kind: 'company', action: 'create', name: 'Co', description: 'D', url: 'http://127.0.0.1:3100' },
  { kind: 'company', action: 'update', name: 'Co', description: 'D', requireBoardApprovalForNewAgents: true },
  { kind: 'access', action: 'invite', allowedJoinTypes: 'both', humanRole: 'viewer', agentMessage: 'hi' },
  { kind: 'access', action: 'member', member: 'm1', role: 'viewer', status: 'active' },
  { kind: 'instance', action: 'general', censorUsernameInLogs: true, feedbackDataSharingPreference: 'prompt' },
  { kind: 'instance', action: 'defaultEnvironment', environment: 'e1' },
  { kind: 'instance', action: 'environment', environment: 'e1', name: 'E', description: 'D', status: 'archived' },
  { kind: 'reporting', action: 'set', agent: 'a1', manager: 'a2' },
  { kind: 'goal', action: 'create', title: 'G', description: 'D', level: 'team', status: 'active', parent: 'g1', owner: 'a1' },
  { kind: 'goal', action: 'update', goal: 'g1', title: 'G', description: 'D', status: 'achieved', owner: 'a1' },
  { kind: 'routine', action: 'create', title: 'R', description: 'D', agent: 'a1', status: 'active', project: 'pr1' },
  { kind: 'routine', action: 'update', routine: 'r1', title: 'R', description: 'D', agent: 'a1', status: 'paused' },
  { kind: 'routine', action: 'schedule', routine: 'r1', trigger: 't1', cron: '0 9 * * *', timezone: 'UTC' },
  { kind: 'pause', action: 'pause', agent: 'a1' },
  { kind: 'budget', action: 'company', budgetDollars: 50 },
  { kind: 'budget', action: 'agent', agent: 'a1', budgetDollars: 5 },
];

// Routes whose validator the reader cannot see in the route line (a middleware chain, or the schema parsed in the handler). Read from routes/*.js of the release.
const VALIDATED_BY = {
  'POST /api/companies': 'createCompanySchema',
  'PATCH /api/companies/:p': 'updateCompanySchema',
  'PATCH /api/issues/:p': 'updateIssueSchema',
  'PATCH /api/instance/settings/general': 'instanceGeneralSettingsSchema',
};

test('the bodies the office sends carry only keys the release validators know', { skip }, () => {
  const { routes, schemas } = releaseRoutes();
  const unchecked = [], wrong = [], seen = new Set();
  for (const s of SAMPLES) {
    let plan;
    try { plan = planWrite(s); } catch (e) { assert.fail(`the sample ${s.kind}/${s.action} is no longer a valid write (${e.message}); update SAMPLES`); }
    const route = norm(plan.path('c1').split('/').map((x) => (/^[a-z]{1,2}\d+$/.test(x) ? ':p' : x)).join('/')), key = `${plan.method} ${route}`;
    assert.ok(routes.has(key), `${key} is not a route of the release`);
    seen.add(key);
    const schema = VALIDATED_BY[key] || schemas.get(key);
    const keys = schema ? schemaKeys(schema) : null;
    if (!keys || !keys.size) { unchecked.push(`${key} (${schema || 'no validator named on the route'})`); continue; }
    const extra = Object.keys(plan.body).filter((k) => !keys.has(k));
    if (extra.length) wrong.push(`${key} sends ${extra.join(', ')}; ${schema} has ${[...keys].join(', ')}`);
  }
  if (process.env.CONTRACT_LIST) console.log(`not checked by key:\n${unchecked.join('\n')}`);
  assert.deepEqual(wrong, [], `Body keys the release does not know:\n${wrong.join('\n')}`);
  assert.ok(seen.size - unchecked.length >= 8, `too few bodies were checked by key (${seen.size - unchecked.length} of ${seen.size})`);
});

// The answers the office reads (SHAPES of hq-model.mjs) against the TypeScript types of the release (shared/dist/types/*.d.ts).
const TYPES = {
  company: ['Company', 'company'], issues: ['Issue', 'issue'], agents: ['Agent', 'agent'], goals: ['Goal', 'goal'], approvals: ['Approval', 'approval'], activity: ['ActivityEvent', 'activity'],
  costs: ['CostSummary', 'cost'], secrets: ['CompanySecret', 'secrets'], costsByAgent: ['CostByAgent', 'cost'], costsByProject: ['CostByProject', 'cost'],
  budgets: ['BudgetOverview', 'budget'], skills: ['CompanySkill', 'company-skill'], plugins: ['PluginRecord', 'plugin'], environments: ['Environment', 'environment'],
  instanceSettings: ['InstanceSettings', 'instance'], joinRequests: ['JoinRequest', 'access'],
};

test('the answers the office reads have the fields and types it expects in the release', { skip }, async () => {
  const { SHAPES } = await import('../src/hq-model.mjs');
  const problems = [];
  for (const [name, [iface, file]] of Object.entries(TYPES)) {
    const text = read(path.join(SOURCE_DIR, 'shared', 'dist', 'types', `${file}.d.ts`));
    const at = text.search(new RegExp(`export interface ${iface}\\b`));
    assert.ok(at >= 0, `${iface} is not in types/${file}.d.ts of the release`);
    const open = text.indexOf('{', at);
    let depth = 1, i = open + 1;
    while (i < text.length && depth > 0) { if (text[i] === '{') depth += 1; else if (text[i] === '}') depth -= 1; i += 1; }
    const body = text.slice(open + 1, i - 1);
    const props = new Map([...body.matchAll(/^\s{4}(\w+)(\?)?:\s*([^;]*);/gm)].map((m) => [m[1], m[3]]));
    for (const [field, want] of Object.entries(SHAPES[name].fields)) {
      const have = props.get(field);
      if (have === undefined) { problems.push(`${name}.${field}: ${iface} of the release has no such field`); continue; }
      const base = want.replace('?', '');
      const ok = { string: /string|"/, number: /number/, boolean: /boolean/, array: /\[\]|Array<|ReadonlyArray</, object: /./ }[base];
      if (ok && !ok.test(have) && !/^[A-Z]\w*$/.test(have.trim())) problems.push(`${name}.${field}: the office reads ${want}, the release says ${have.trim()}`);
    }
  }
  assert.deepEqual(problems, [], `Fields the release does not have in the shape the office reads:\n${problems.join('\n')}`);
});

test('the route reader does not accept a route the release lacks', { skip }, () => {
  const { routes } = releaseRoutes();
  assert.equal(routes.has('GET /api/companies/:p/no-such-thing'), false);
  assert.equal(routes.has('POST /api/health'), false);
  assert.ok(expand('/api/approvals/${a}/${route}', "decision('approve', 'approve', 'x') decision('reject', 'reject', 'y')").includes('/api/approvals/${a}/reject'));
});

// ---------- the stand-in and the live socket ----------
/** The method and path of every route the stand-in serves (`req.method === 'X' && ... m(/^\/api\/...$/)`), alternations opened. */
function fakeRoutes() {
  const out = [];
  const text = read(path.join(ROOT, 'test', 'fixtures', 'fake-paperclip.mjs'));
  for (const line of text.split('\n')) {
    const method = (/req\.method === '([A-Z]+)'/.exec(line) || [])[1];
    if (!method) continue;
    let paths = [];
    for (const m of line.matchAll(/u\.pathname === '(\/api\/[^']*)'/g)) paths.push(m[1]);
    const re = /m\(\/\^(\\\/api\\\/.*?)\$\/\)/.exec(line);
    if (re) paths.push(re[1].replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':p'));
    paths = paths.flatMap((p) => {
      let list = [p];
      for (let n = 0; n < 4; n += 1) list = list.flatMap((q) => { const m = /\(([a-z-]+(?:\|[a-z-]+)+)\)/.exec(q); return m ? m[1].split('|').map((w) => q.replace(m[0], w)) : [q]; });
      return list;
    });
    for (const p of paths) out.push({ method, path: norm(p) });
  }
  return out;
}

test('every route the stand-in serves exists in the pinned release', { skip }, () => {
  const { routes } = releaseRoutes();
  const mine = fakeRoutes();
  assert.ok(mine.length > 60, `the reader found only ${mine.length} stand-in routes`);
  const missing = mine.filter((r) => !routes.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual([...new Set(missing)], [], 'The stand-in (test/fixtures/fake-paperclip.mjs) serves routes the pinned release does not have.');
});

test('the live events socket path is the one the release serves', { skip }, () => {
  const ws = read(path.join(SOURCE_DIR, 'server', 'dist', 'realtime', 'live-events-ws.js'));
  assert.ok(ws.includes(String.raw`/^\/api\/companies\/([^/]+)\/events\/ws$/`), 'the release does not serve /api/companies/:id/events/ws');
  assert.ok(read(path.join(ROOT, 'src', 'paperclip.mjs')).includes('/events/ws'));
});

// ---------- the words the office writes ----------
test('the enums the office writes are values of the release', { skip }, async () => {
  const shared = path.join(SOURCE_DIR, 'shared', 'dist');
  const url = (f) => new URL(`file:///${path.join(shared, f).replace(/\\/g, '/')}`).href;
  const c = await import(url('constants.js'));
  const feedback = await import(url(path.join('types', 'feedback.js')));
  const m = await import('../src/hq-model.mjs');
  const inside = (name, mine, theirs) => assert.deepEqual(mine.filter((x) => !theirs.includes(x)), [], `${name}: the office writes values the release ${PINNED.version} does not have (release: ${theirs.join(', ')})`);
  inside('agent role (HIRE_ROLES, the Manager role)', [...m.HIRE_ROLES.map((r) => r.role), m.MANAGER_ROLE], c.AGENT_ROLES);
  inside('issue status', m.ISSUE_STATUS, c.ISSUE_STATUSES);
  inside('goal status', m.GOAL_STATUSES, c.GOAL_STATUSES);
  inside('goal level', m.GOAL_LEVELS, c.GOAL_LEVELS);
  inside('routine status', m.ROUTINE_STATUS, c.ROUTINE_STATUSES);
  inside('invite join type', m.JOIN_TYPES, c.INVITE_JOIN_TYPES);
  inside('human role', m.HUMAN_ROLES, c.HUMAN_COMPANY_MEMBERSHIP_ROLES);
  inside('member status', m.MEMBER_STATUS, c.MEMBERSHIP_STATUSES);
  inside('environment status', m.ENVIRONMENT_STATUS, c.ENVIRONMENT_STATUSES);
  inside('feedback sharing', m.FEEDBACK_SHARING, feedback.FEEDBACK_DATA_SHARING_PREFERENCES);
  inside('approval status the office reads', ['pending'], c.APPROVAL_STATUSES);
  const src = read(path.join(ROOT, 'src', 'paperclip.mjs'));
  const open = /OPEN_APPROVAL\s*=\s*new Set\(\[([^\]]*)\]/.exec(src);
  if (open) inside('open approval status', [...open[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), c.APPROVAL_STATUSES);
  for (const q of src.matchAll(/issues\?status=([a-z_,]+)\b/g)) inside('issue status filter', q[1].split(','), c.ISSUE_STATUSES);
});
