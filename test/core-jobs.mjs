// Core-jobs gate (#147, part of #143): a browser script that walks the five core jobs at 1360 and 400 px and fails when a
// job takes more steps than its limit. Run it before every UI merge: npm run gate:jobs
//
// The five jobs: start an agent, answer an approval, read the change, discard a room (the offline half of "merge or
// discard": a merge needs a pull request on a real remote), find a past session.
// A step is one thing the user does: one click or one key press. A job ends when its goal shows on the page. The script
// takes the shortest route the page offers (a step is skipped when the page already shows its target, for example
// Approve in the left column). When the page asks for more steps than the limit, or the goal never shows, the job fails.
//
// It starts its own office on a free port (never 4317), seeds it with fake hooks sent with the agent token, drives a
// headless Chrome or Edge over DevTools (test/fixtures/cdp.mjs) and stops both by pid. No paid call, no dependency.
// It is not in `npm test` or CI: it needs a browser, a GPU-less WebGL scene, and about two minutes.
// Screenshots of every run go to .screens/core-jobs/ (never committed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startOnFreePort } from './fixtures/office-server.mjs';
import { launch, findBrowser } from './fixtures/cdp.mjs';
import { officeFiles } from '../files.mjs';
import { pageFile } from '../auth.mjs';
import { resolveExe } from '../git.mjs';

// ---------- the one place the step limits are set ----------
// Steps per job, at every width. Lower a limit when a job gets shorter. Raise one only with a reason in the commit.
export const LIMITS = { start: 3, approve: 2, read: 3, discard: 5, find: 3, approveAfterDesk: 5 };
export const WIDTHS = [1360, 400];
export const JOBS = ['start', 'approve', 'approveAfterDesk', 'read', 'discard', 'find'];

/**
 * results: [{ job, width, steps, ok, why? }]. Returns one line for every run that fails: the goal did not show, or the
 * steps are over the limit of the job. An empty list is a pass. A job with no limit is a failure too (nothing is unchecked).
 */
export function verdict(results, limits = LIMITS) {
  const out = [];
  for (const r of results) {
    const at = `${r.job} at ${r.width} px`;
    const limit = limits[r.job];
    if (!Number.isInteger(limit)) { out.push(`${at}: no step limit is set for this job`); continue; }
    if (!r.ok) { out.push(`${at}: goal not reached after ${r.steps} steps${r.why ? ` (${r.why})` : ''}`); continue; }
    if (r.steps > limit) out.push(`${at}: ${r.steps} steps, the limit is ${limit}`);
  }
  return out;
}

// ---------- page helpers (strings run in the page) ----------
// Visible = has a box AND is what a click at its middle reaches (#162: at 400 px the phone list covers the scene, whose buttons
// keep a box under it; a box off screen counts, the click scrolls to it; a real click on one of those lands on the list and does nothing).
const VIS = '(()=>{const r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return false;if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)return true;const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!t&&(t===e||e.contains(t))})()';
const LABEL = '(e.getAttribute("aria-label")||e.textContent).trim()';
const ITEMS = 'document.querySelectorAll("button,[role=option],[role=menuitem]")';
/** Expression for the first visible control whose label starts with `text` (`last`: the last one, the top dialog's). */
const control = (text, { exact = false, last = false } = {}) => {
  const t = JSON.stringify(text);
  const test = exact ? `${LABEL}===${t}` : `${LABEL}.startsWith(${t})`;
  return `(()=>{const l=[...${ITEMS}].filter(e=>${VIS}&&${test});return l[${last ? 'l.length-1' : '0'}]||null})()`;
};
const seen = (text, opts) => `!!${control(text, opts)}`;
const textHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;

// ---------- the run ----------
const log = (...a) => console.log(...a);

function seedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-jobs-'));
  const repo = path.join(dir, 'gate-repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync(resolveExe('git'), a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'gate@example.com'); git('config', 'user.name', 'gate'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');   // the change to read
  return { dir, repo, git };
}

export async function run({ shots = true } = {}) {
  if (!findBrowser()) throw new Error('No Chrome or Edge found. Set OFFICE_BROWSER to the browser program.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { dir, repo } = seedRepo();
  const env = { ...process.env, OFFICE_OPEN: '0' };
  delete env.OFFICE_PORT;
  // Only a session the office ran is kept in Past sessions, so the past record is seeded in the history file of this port.
  const PAST = 'gate-past-session';
  const past = { uid: 'gatepast1', sid: 'gate-past-sid', provider: 'claude-code', name: PAST, cwd: repo, model: 'sonnet', mode: 'default', cost: 0.05, turns: 2,
    startedAt: Date.now() - 3600000, endedAt: Date.now() - 3000000, worktree: null, replies: [{ id: 1, text: 'Fixed the title.', at: Date.now() - 3000000 }], prompt: 'Fix the title', budget: 2, calls: [] };
  const { office, port } = await startOnFreePort(root, env, { prepare: (n) => fs.writeFileSync(officeFiles(root, n).history, JSON.stringify([past])) });
  const files = officeFiles(root, port);
  const results = [];
  let browser = null, room = null;
  try {
    const agent = JSON.parse(fs.readFileSync(files.token, 'utf8')).token;
    const pageTok = JSON.parse(fs.readFileSync(pageFile(process.env, port), 'utf8')).token;
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body, token, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token, ...headers }, body: JSON.stringify(body) });
    const hook = (body) => post('/hook/http', { cwd: repo, ...body }, agent);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // data on screen: one live session with a change in its folder (the past session is in the history file, above)
    await hook({ hook_event_name: 'SessionStart', session_id: 'gate-live', source: 'startup', model: 'claude-sonnet-4-5' });
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'gate-live', prompt: 'Add a line to a.txt' });
    const snapshot = () => new Promise((res) => { fetch(`${base}/events`, { headers: { 'x-office-token': pageTok } }).then(async (r) => { const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel(); res(JSON.parse(new TextDecoder().decode(value).split('\n')[0].slice(6))); }); });
    let live = null;
    for (let i = 0; i < 50 && !live; i++) {   // the place of a session comes a moment after its first hook
      live = (await snapshot()).sessions.find((s) => s.status !== 'ended' && s.place) || null;
      if (!live) await sleep(200);
    }
    if (!live) throw new Error('The seeded session has no place in the snapshot.');
    const made = await (await post('/api/floor/create', { repo: live.place.buildingKey, branch: 'agent-gate', from: 'main', name: 'gate-room' }, pageTok)).json();
    room = made.root;
    if (!room) throw new Error('The seeded room was not made: ' + JSON.stringify(made));
    const repoName = live.place.building;

    browser = await launch({});
    const p = browser.page;
    const link = await (await post('/api/launch-link', {}, pageTok)).json();
    let first = true;
    const load = async (w) => {
      await p.size(w, 900, w < 700);
      if (first) {   // the launch link sets the cookie; the lobby tour is for a new user, so a returning one has seen it
        await p.goto(link.url);
        await p.waitFor('!!document.querySelector(".ao-office")', 40000, 'the page');
        await p.evaluate(`try{localStorage.setItem('ao-tour','1')}catch(e){}`);
        first = false;
      }
      await p.goto(base + '/');
      await p.waitFor(textHas(repoName), 40000, 'the page to show the seeded building');
      await sleep(1500);
    };

    // palette: the Ctrl+K button where the page shows one, else the key. One step either way.
    const palette = { label: 'open the command palette', run: async () => {
      if (await p.evaluate(seen('Open the command palette'))) return p.click(control('Open the command palette'));
      await p.key('k', { ctrl: true }); return true;
    } };
    const entry = (text) => ({ label: `pick "${text}"`, run: async () => { await p.waitFor(seen(text), 5000, `palette entry ${text}`); return p.click(control(text)); } });

    let held = null, answered = false;   // the held approval of the approve job
    const poll = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
    const approveJob = {};
    const jobs = {
      start: {
        before: async () => {},
        steps: [palette, entry('Open a session')],
        goal: `(()=>{const b=${control('Open session', { exact: true })};return !!b&&!b.disabled&&!!document.querySelector(".ao-dialog,[role=dialog]")})()`,
      },
      approve: Object.assign(approveJob, {
        before: async () => {
          answered = false;
          held = hook({ hook_event_name: 'PermissionRequest', session_id: 'gate-live', tool_name: 'Bash', tool_input: { command: 'npm test' } }).then((r) => r.json()).then((j) => { answered = true; return j; }).catch(() => null);
          await sleep(500);
        },
        steps: [
          { label: 'open the queue', run: async () => { if (await p.evaluate(seen('Approve', { exact: true }))) return false; return p.click(control('Needs you')); } },
          { label: 'Approve', run: async () => { await p.waitFor(seen('Approve', { exact: true }), 8000, 'Approve'); return p.click(control('Approve', { exact: true })); } },
        ],
        goal: null,   // the hook answer, below
        extra: async () => { const a = await Promise.race([held, sleep(8000).then(() => null)]); return !!a && JSON.stringify(a).includes('allow'); },
        waitFor: (ms) => poll(async () => answered, ms),
      }),
      // #162: a desk screen was opened and closed, then Approve in the Needs you list must still answer the request.
      approveAfterDesk: {
        before: async () => approveJob.before(),
        steps: [palette, entry('Terminal of'),
          { label: 'Back', run: async () => { await p.waitFor(seen('Back'), 15000, 'Back'); const ok = await p.click(control('Back')); await sleep(1500); return ok; } },
          ...approveJob.steps],
        goal: null,
        extra: (...a) => approveJob.extra(...a),
        waitFor: (ms) => approveJob.waitFor(ms),
      },
      read: {
        before: async () => {},
        steps: [palette, entry('Changes of')],
        goal: `${textHas('+two')}&&${textHas('a.txt')}`,
        ms: 15000,   // the wall screen gets 5 s, then the dialog takes over
      },
      discard: {
        before: async () => {},
        steps: [palette, entry('Branches and worktrees'),
          { label: 'Remove room', run: async () => { await p.waitFor(seen('Remove room'), 5000, 'Remove room'); return p.click(control('Remove room')); } },
          { label: 'confirm', run: async () => { await sleep(500); return p.click(control('Remove room', { last: true })); } }],
        goal: null,
        waitFor: (ms) => poll(async () => !fs.existsSync(room), ms),
      },
      find: {
        before: async () => {},
        steps: [palette, entry('Past sessions')],
        goal: `(()=>{const d=document.querySelector(".ao-dialog,[role=dialog]");return !!d&&d.innerText.startsWith("Past sessions")&&d.innerText.includes(${JSON.stringify(PAST)})&&!d.innerText.includes("No past sessions yet")})()`,
      },
    };

    for (const w of WIDTHS) {
      for (const id of JOBS) {
        if (id === 'discard' && w !== WIDTHS[0] && !fs.existsSync(room)) {
          // the room is gone after the first width: make another for this one
          const again = await (await post('/api/floor/create', { repo: live.place.buildingKey, branch: `agent-gate-${w}`, from: 'main', name: `gate-room-${w}` }, pageTok)).json();
          room = again.root;
        }
        const job = jobs[id];
        await load(w);
        await job.before();
        let steps = 0, ok = false, why = '';
        const reached = async (ms) => {
          if (job.waitFor) return job.waitFor(ms);
          try { await p.waitFor(job.goal, ms, 'goal'); return true; } catch { return false; }
        };
        for (const step of job.steps) {
          let acted;
          try { acted = await step.run(); } catch (e) { why = `${step.label}: ${e.message}`; break; }
          if (!acted) { if (acted === false && step.label === 'open the queue') continue; why = `${step.label}: target not found`; break; }
          steps += 1;
          const last = step === job.steps[job.steps.length - 1];
          if (await reached(last ? (job.ms || 8000) : 1200)) { ok = true; break; }
        }
        if (ok && job.extra && !(await job.extra())) { ok = false; why = 'the answer did not reach the agent'; }
        if (!ok && !why) why = 'route ended before the goal showed';
        if (shots) await p.screenshot(path.join(root, '.screens', 'core-jobs', `${id}-${w}.png`));
        results.push({ job: id, width: w, steps, ok, ...(why ? { why } : {}) });
        log(`${ok ? 'PASS' : 'FAIL'} ${id} at ${w} px: ${steps} steps (limit ${LIMITS[id]})${why ? ' ' + why : ''}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    await office.stop();
    for (const f of Object.values(files)) fs.rmSync(f, { force: true });
    try { execFileSync(resolveExe('git'), ['worktree', 'prune'], { cwd: repo, stdio: 'pipe' }); } catch { /* the repo is going */ }
    if (room) fs.rmSync(room, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await run();
  const bad = verdict(results);
  if (bad.length) { console.error('\nCore-jobs gate failed:\n' + bad.map((l) => '  ' + l).join('\n')); process.exit(1); }
  log(`\nCore-jobs gate passed: ${results.length} runs within their limits.`);
  process.exit(0);
}
