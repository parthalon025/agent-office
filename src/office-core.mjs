// Office core: the Interface the office offers its two adapters, the HTTP server (server.mjs) and the in-process test driver.
//
// A route table lists every route once: method, path, group and handler. The route group of a path (public, launch, agent or
// page, see auth.mjs) is read from the table, so a route and its token rule are written in one place. handle(request) runs
// the handler of a request and gives a response; it does no gate, no body parsing and no socket work. Those belong to the
// adapter: the HTTP server gates every request (auth.gateRequest) and parses its body before it calls handle.
//
//   request:  { method, path, query?: URLSearchParams, headers?, body?, remote?, signal? }
//   response: { status, body, type?, headers?, bare?, stream? }
//     body: an object (sent as JSON), or a string or Buffer (sent as is, with `type`, default application/json).
//     stream(write): the response is a feed; the adapter calls it with a function that writes one chunk, and calls what
//       stream returns when the client goes away (the page's /events).
//     bare: no standard headers (a 204 for the favicon).
//
// A handler gets { body, query, headers, signal, remote } and gives its answer: a value (200, sent as JSON), reply(...) for another
// status, header or feed, or a promise of either. A held request (a permission prompt, an office_ask question) is a promise
// that settles when the user answers; signal aborts when the client gives up first. A handler throws httpError(status, text)
// for a refusal, or askFirst(...) for a call that needs the user's yes first (ask.js): the answer is built here, once.
import path from 'node:path';
import fs from 'node:fs';

/** An error that carries its HTTP status. */
export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** A call that needs the user's yes first (ask.js): handle sends e.answer; the page asks and sends the call again. */
export function askFirst(kind, text, extra) { const a = globalThis.OfficeAsk.answer(kind, text, extra); return Object.assign(httpError(a.status, text), { answer: a }); }

const REPLY = Symbol('reply');
/** A handler's answer with a status other than 200, headers, a type or a feed: reply(401, { error }), reply(200, html, { type }). */
export const reply = (status, body, more = {}) => ({ [REPLY]: true, status, body, ...more });

const NEVER = new AbortController().signal;
/** The response of a request whose client went away before the answer (nobody reads it). */
const GONE = { status: 499, body: { error: 'The client went away.' } };
const NO_QUERY = new URLSearchParams();

/**
 * The core of a route table: routes is a list of { method, path, group, run }. A path and method appear once.
 * Returns { handle(request), groupOf(method, path), routes }. groupOf is what auth.gateRequest reads (site.groupOf); a path the table
 * does not list falls back to the prefix rule of auth.routeOf, so an unknown path under /api/ or /hook/ still needs its token.
 */
export function createCore({ routes }) {
  const byKey = new Map();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (byKey.has(key)) throw new Error(`Route listed twice: ${key}`);
    byKey.set(key, r);
  }
  const groupOf = (method, p) => byKey.get(`${method} ${p}`)?.group;
  async function handle(req) {
    const route = byKey.get(`${req.method} ${req.path}`);
    if (!route) return { status: 404, body: { error: 'Not found' } };
    const signal = req.signal || NEVER;
    if (signal.aborted) return GONE;
    let leave = null;
    try {
      // A request whose client goes away is over: a held request (a prompt nobody will answer) does not wait for ever.
      const gone = new Promise((resolve) => { leave = () => resolve(GONE); signal.addEventListener('abort', leave, { once: true }); });
      const out = await Promise.race([route.run({ body: req.body ?? {}, query: req.query || NO_QUERY, headers: req.headers || {}, signal, remote: req.remote || null }), gone]);
      if (out === GONE) return GONE;
      if (out && out[REPLY]) { const { status, body, type, headers, bare, stream } = out; return { status, body, type, headers, bare, stream }; }
      return { status: 200, body: out };
    } catch (e) {
      // ask-first (ask.js): the request needs the user's yes first; the page asks and sends it again.
      if (e.answer) return { status: e.answer.status, body: e.answer.body };
      return { status: e.status || 500, body: { error: e.message } };
    } finally {
      if (leave) signal.removeEventListener('abort', leave);
    }
  }
  return { handle, groupOf, routes: routes.map(({ method, path: p, group }) => ({ method, path: p, group })) };
}

// Static files: the page, its scripts, the Agent Office DS runtime (tokens, bundle, three.js), and the vendored React and fonts
// (public/vendor/README.md: versions, sources, SHA-256). The page loads nothing from another site. An exact-match list: a request
// path is only a key, never part of a file path. The font names are read once from the vendored folder, and only plain names
// (a-z, 0-9, -) ending in .woff2 count.
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
export function staticFiles(root) {
  const fonts = fs.readdirSync(path.join(root, 'public', 'vendor', 'fonts')).filter((f) => /^[a-z0-9-]+\.woff2$/.test(f));
  return new Map([
    ['/page-core.js', 'public/page-core.js'], ['/dialogs.js', 'public/dialogs.js'], ['/schedules.js', 'public/schedules.js'], ['/extensions.js', 'public/extensions.js'], ['/hq.js', 'public/hq.js'], ['/characters.js', 'public/characters.js'], ['/reception.js', 'public/reception.js'], ['/panels.js', 'public/panels.js'], ['/changes.js', 'public/changes.js'], ['/needs.js', 'public/needs.js'], ['/office.js', 'public/office.js'], ['/scene-host.js', 'public/scene-host.js'], ['/city.js', 'public/city.js'], ['/board.js', 'public/board.js'], ['/terminal.js', 'public/terminal.js'], ['/persona.js', 'public/persona.js'], ['/lobby.js', 'public/lobby.js'], ['/desk.js', 'public/desk.js'], ['/security.js', 'public/security.js'], ['/office.css', 'public/office.css'], ['/chat-extras.js', 'public/chat-extras.js'], ['/adapter.js', 'public/adapter.js'], ['/vocab.js', 'public/vocab.js'], ['/ask.js', 'public/ask.js'], ['/client.js', 'public/client.js'], ['/wire.js', 'public/wire.js'], ['/format.js', 'public/format.js'], ['/wheel-gate.js', 'public/wheel-gate.js'], ['/building.js', 'public/building.js'], ['/toasts.js', 'public/toasts.js'], ['/screen-kit.js', 'public/screen-kit.js'], ['/skills.js', 'public/skills.js'], ['/screens.js', 'public/screens.js'], ['/merge.js', 'public/merge.js'], ['/vocab-security.js', 'public/vocab-security.js'], ['/vocab-layers.js', 'public/vocab-layers.js'], ['/vocab-persona.js', 'public/vocab-persona.js'], ['/tokens.css', 'tokens.css'],
    ['/components/bundle.css', 'components/bundle.css'], ['/components/bundle.js', 'components/bundle.js'],
    ['/components/lib/three.min.js', 'components/lib/three.min.js'],
    ['/components/lib/three-orbit-controls.js', 'components/lib/three-orbit-controls.js'],
    ['/components/lib/three-postprocessing.js', 'components/lib/three-postprocessing.js'],
    ['/vendor/react.production.min.js', 'public/vendor/react.production.min.js'],
    ['/vendor/react-dom.production.min.js', 'public/vendor/react-dom.production.min.js'],
    ['/vendor/fonts/fonts.css', 'public/vendor/fonts/fonts.css'],
    ...fonts.map((f) => [`/vendor/fonts/${f}`, `public/vendor/fonts/${f}`]),
  ]);
}

/** The public routes: the page, the favicon and every static file. Each is read at request time. */
export function staticRoutes(root, files = staticFiles(root)) {
  const page = { method: 'GET', path: '/', group: 'public', run: () => reply(200, fs.readFileSync(path.join(root, 'public', 'index.html')), { type: 'text/html; charset=utf-8' }) };
  const icon = { method: 'GET', path: '/favicon.ico', group: 'public', run: () => reply(204, '', { bare: true }) };
  return [page, icon, ...[...files].map(([url, rel]) => ({ method: 'GET', path: url, group: 'public', run: () => reply(200, fs.readFileSync(path.join(root, rel)), { type: MIME[path.extname(rel)] || 'application/octet-stream' }) }))];
}
