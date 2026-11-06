/* Agent Office for Claude Code x0.2: page core (split out of office.js, #1 story 26).
   The helpers every page file shares: the calls to the server, the formats, the small parts (Area, Tag, Busy, Pairs, CostDialog,
   FeatureTags) and the agent kind hooks (useKinds, KindFields, KindNeeds). It loads first and puts its names on
   window.OfficePage; the other page files read them from there. No DOM work at load, no scene code. */
(function () {
  'use strict';
  var O = window.OfficePage = {};
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo;
  A.strict = true;

  // A repository is a building. Its floors are company functions (#92: the archetype of the building picks them; the Lobby
  // is the ground floor), an agent sits on the floor of its role, and a worktree or folder is a room named from its task.
  // The adapter builds the shown building (a building adapter from officeAdapter.mount) and adds rooms as sessions arrive.

  // The fallback Claude Code model list: shown only before /api/providers answers (#101). The server's list replaces it.
  var MODELS = [
    { value: '', label: 'Default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' }, { value: 'claude-fable-5-1', label: 'Fable' }
  ];
  var MODES = [{ value: '', label: 'Default' }, { value: 'plan', label: 'Plan only' }, { value: 'acceptEdits', label: 'Accept edits' }];
  var WHERE = [{ value: 'office', label: 'In the office (no terminal)' }, { value: 'terminal', label: 'In a terminal window' }];
  var ISOLATION = [{ value: 'same', label: 'Same folder' }, { value: 'worktree', label: 'New git worktree' }];
  // The spend limit field (#33). The server owns the default (info.spendLimit, in dollars, 0 = none). The field starts with it.
  // An empty field is "no limit" and is sent as 0, but only once the default is known: before that, send nothing so the server decides.
  function limitText(def) { return def > 0 ? String(def) : ''; }
  function limitSent(text, known) {
    var t = String(text == null ? '' : text).trim();
    if (t === '') return known ? 0 : undefined;
    var n = Number(t);
    return isFinite(n) ? n : t;
  }
  function limitHint(label, cloud) {
    // A cloud service reports no dollars. The office counts the prices the owner sets in the environment (docs/agents.md).
    return label + (cloud ? ' stops at this limit, counted from the prices you set (see docs/configuration.md). With no prices set, nothing is counted. Clear the field for no limit.' : ' stops at this limit. Clear the field for no limit.');
  }
  var KIND = [{ value: 'every', label: 'Every N minutes' }, { value: 'daily', label: 'Every day at' }];

  // ---------- helpers ----------
  // The page holds no token: calls send the page cookie by themselves (adapter.js has the access flow). They wait
  // until the page knows whether it has access, so a first call never runs before the launch code is traded.
  function call(path, opts) { return window.officeAdapter.ready.then(function () { return fetch(path, opts); }); }
  function api(path, body) {
    return call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'The office could not do that (' + r.status + ').'); e.status = r.status; e.body = j; throw e; }
        // A question before the call can run (the cost question: 200 { confirm, question }): the caller asks, as for a 409.
        if (j && j.confirm && j.question) { var q = new Error(j.question); q.status = r.status; q.body = j; throw q; }
        return j;
      }); });
  }
  function getInfo(first) { return call('/api/info' + (first ? '?first=' + encodeURIComponent(first) : '')).then(function (r) { return r.json(); }); }
  function ago(t) {
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  var F = window.OfficeFormat, money = F.money;   // one money format: $0.00, <$0.01, two decimals (format.js)
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function cadence(s) { return s.kind === 'daily' ? 'Every day at ' + s.at : 'Every ' + s.every + ' min'; }
  function useSnapshot() {
    var st = useState(null);
    useEffect(function () { return window.officeAdapter.onSnapshot(st[1]); }, []);
    return st[0];
  }
  // The bot whose chat is open. The office draws the chat itself, so read the name from the message box.
  // (The Decisions inbox is controlled by the page: OfficeScene inbox and onInbox.)
  function useChatBot() {
    var st = useState(null);
    useEffect(function () {
      var raf = 0;
      function read() {
        raf = 0;
        var input = document.querySelector('.ao-hud-chat .ao-input');
        st[1](input ? (input.placeholder || '').replace(/^Message\s+/, '') : null);
      }
      var mo = new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(read); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder'] });
      read();
      return function () { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, []);
    return st[0];
  }
  function resetText(at) {
    var m = Math.max(0, Math.round((at - Date.now()) / 60000)), d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60);
    return 'Resets in ' + (d ? d + 'd ' + hr + 'h' : hr ? hr + 'h ' + (m % 60) + 'm' : (m % 60) + 'm');
  }
  // A bot's body color, the same one the scene uses (building.js). BotAvatar draws an SVG with a fill color, so it needs the value.
  function colorOf(uid) { return window.officeAdapter.colorOf(uid); }
  // The look of a session's bot in lists and previews: its persona's shape and color (#150), else the uid's.
  function look(s) {
    var l = window.OfficeVocab.persona.lookOf(s && s.persona, Array.prototype.slice.call(window.AgentOffice.BODY_COLORS || []));
    return { shape: (l && l.shape) || window.officeAdapter.shapeOf(s.uid), color: (l && l.color) || colorOf(s.uid) };
  }
  function cssMs(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  var plural = F.plural;
  function statusOf(s) { return window.OfficeVocab.status(s).key; }

  // ---------- small parts ----------
  function Area(p) {
    return h('div', { className: 'ao-field' },
      h('label', { className: 'ao-label', htmlFor: p.id }, p.label),
      h('textarea', { id: p.id, className: 'ao-input area', rows: p.rows || 4, value: p.value, placeholder: p.placeholder, onChange: function (e) { p.onChange(e.target.value); } }),
      p.hint ? h('span', { className: 'ao-hint' }, p.hint) : null,
      p.error ? h('span', { className: 'ao-err', role: 'alert' }, p.error) : null);
  }
  function Tag(p) { return h('span', { className: 'tag' }, p.children); }
  function Pair(a, b) { return h('div', { className: 'row' }, a, b); }
  // Export (#72): the server writes the Markdown of a session (every agent kind has it); the browser saves it as a file.
  function exportSession(uid, toast) {
    return api('/api/export', { uid: uid }).then(function (j) {
      var url = URL.createObjectURL(new Blob([j.text], { type: 'text/markdown;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url; a.download = j.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      if (toast) toast({ tone: 'success', title: 'Exported', text: j.filename });
    }, function (x) { if (toast) toast({ tone: 'error', title: 'Export failed', text: x.message }); });
  }
  // An agent that reports no cost asks once before it runs while its Security room cell is Ask (security.mjs costAsk): the
  // server answers 200 with confirm: 'cost' and the question (api() turns it into an Error with .body); the page asks, then sends the same call with confirmCost: true.
  function costAsked(x) { return !!(x && x.body && x.body.confirm === 'cost'); }
  // p: { title, text (the server's question), busy, err, onCancel, onRun }
  function CostDialog(p) {
    return h(A.Dialog, { open: true, title: p.title, onClose: p.onCancel, actions: [
      h(A.Button, { key: 'c', variant: 'quiet', onClick: p.onCancel }, 'Cancel'),
      h(A.Button, { key: 'r', variant: 'primary', icon: 'approve', loading: !!p.busy, onClick: p.onRun }, 'Run it')] },
      h('div', { className: 'form' },
        h('p', { className: 'note' }, p.text),
        h('p', { className: 'note' }, 'The office shows its cost as unknown, and no spend limit can stop it. The Security room can run such agents without this question.'),
        p.err ? h('p', { className: 'ao-err', role: 'alert' }, p.err) : null));
  }
  // The words of what an agent kind has beyond the seam (vocab.js featuresOf): only the ones it declares.
  function FeatureTags(p) {
    var list = window.OfficeVocab.featuresOf(p.session);
    return list.length ? h('span', { className: 'feature-tags', 'aria-label': 'Features of ' + (window.officeAdapter.kindWord(p.session) || 'this agent') }, list.map(function (f) { return h(Tag, { key: f.key }, f.label); })) : null;
  }
  function Busy(p) { return p.on ? h(A.Skeleton, { lines: p.lines || 3, label: 'Loading' }) : null; }
  // Fields two to a row; a field that is null leaves no gap.
  function Pairs(list) {
    var f = list.filter(Boolean), out = [];
    for (var i = 0; i < f.length; i += 2) out.push(f[i + 1] ? h('div', { key: i, className: 'row' }, f[i], f[i + 1]) : h('div', { key: i, className: 'row' }, f[i], h('span', null)));
    return out;
  }

  // ---------- agent kinds (#20) ----------
  // The kinds and their options come with the snapshot (officeAdapter.kinds(), from src/providers/index.mjs describe):
  // label, paid (spend limit), terminal (Runs), modes (Permissions), needsModel, control (the dock's live changes).
  // Readiness and models come from GET /api/providers, which asks each provider and can take a few seconds
  // (Claude Code runs claude --version). Until it answers a kind is checking, and Claude Code offers the fallback models in MODELS. One shared answer feeds every place that shows a model.
  var DEFAULT_KIND = 'claude-code';
  function kindOf(list, id) { return (list || []).filter(function (k) { return k.kind === (id || DEFAULT_KIND); })[0] || null; }
  // The kind rules and words (state, model choices, first model, the note, a kind change) live in vocab.js.
  var KV = window.OfficeVocab;
  // Claude Code before its answer (or no kinds yet) offers the models in MODELS.
  function modelChoices(k) { return KV.modelChoices(k, !k || k.kind === DEFAULT_KIND ? MODELS : null); }
  // on: false asks nothing yet (a room's list shows before its Add agent form).
  // checking: an ask is out. A second ask (Check again) keeps the last answer on screen until the new one comes,
  // so a not-ready box stays and its Check again button shows that it works.
  // One shared ask for every useKinds (#101): an open dialog, the schedule form, the dock and the model words share one answer,
  // so none repeats claude --version. Check again (fresh) always asks anew. The server keeps its own answer for 30 s too.
  var provShared = { by: null, at: 0, flight: null };
  function fetchProviders(fresh) {
    if (!fresh && provShared.flight) return provShared.flight;
    if (!fresh && provShared.by && Date.now() - provShared.at < 30000) return Promise.resolve(provShared.by);
    var f = call(fresh ? '/api/providers?fresh=1' : '/api/providers').then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function (j) {
      var by = {};
      (j.providers || []).forEach(function (x) { by[x.kind] = x; });
      provShared.by = by; provShared.at = Date.now(); if (provShared.flight === f) provShared.flight = null;
      return by;
    }, function (e) { if (provShared.flight === f) provShared.flight = null; throw e; });
    provShared.flight = f;
    return f;
  }
  function useKinds(on) {
    var snap = useSnapshot();
    var st = useState(null), status = st[0], setStatus = st[1];   // kind -> its /api/providers entry, or null before the first answer
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var rd = useState(0), round = rd[0], setRound = rd[1];
    // The server keeps its answer for 30 s. Only Check again asks it to look again (fresh=1); opening a dialog or a room's
    // list does not. The flag is used once, so a later ask of the same hook (the list shows again) reads the kept answer.
    var wantFresh = React.useRef(false);
    var ask = on !== false;
    useEffect(function () {
      var live = true;
      if (!ask) { setStatus(null); setBusy(false); return undefined; }
      setBusy(true);
      var fresh = wantFresh.current; wantFresh.current = false;
      fetchProviders(fresh).then(function (by) {
        if (!live) return;
        setStatus(by); setBusy(false);
      }, function () { if (live) { setStatus({}); setBusy(false); } });
      return function () { live = false; };
    }, [round, ask]);
    var list = ((snap && snap.kinds) || []).map(function (k) {
      if (!status) return Object.assign({}, k, { checking: true, ready: false, version: null, needs: [], models: [] });
      var r = status[k.kind] || { ready: false, version: null, models: [], needs: ['The office could not check ' + k.label + '. Check again.'] };
      return Object.assign({}, k, { checking: false, ready: r.ready === true, configured: r.configured !== false, version: r.version || null, needs: r.needs || [], models: r.models || [] });
    });
    return { list: list, checking: busy || !status, recheck: function () { wantFresh.current = true; setRound(round + 1); } };
  }
  // Why a kind is not ready, and what to do. p: { kind, onRecheck, checking (a Check again is out) }
  function KindNeeds(p) {
    var k = p.kind, needs = k.needs && k.needs.length ? k.needs : ['It did not say what it needs.'];
    return h('div', { className: 'kind-need', role: 'status' },
      h('span', { className: 'sess-state' }, h(A.StatusDot, { status: 'waiting' }), h('b', null, KV.needsTitle(k))),
      h('ul', { className: 'kind-steps' }, needs.map(function (n, i) { return h('li', { key: i }, n); })),
      p.onRecheck ? h('div', { className: 'btn-row' }, h(A.Button, { variant: 'quiet', icon: 'retry', loading: !!p.checking, onClick: p.onRecheck }, 'Check again')) : null);
  }
  // The agent kind and its model, for Open session and a room's Add agent. p: { id, kinds (useKinds), kind, model, onKind(id), onModel(v) }
  function KindFields(p) {
    var K = p.kinds, k = kindOf(K.list, p.kind);
    var opts = K.list.map(function (x) { return { value: x.kind, label: x.label + (x.checking || x.ready ? '' : ' · ' + KV.kindState(x).word) }; });
    var model = h(A.Select, { id: p.id + '-model', label: KV.modelLabel(k), options: modelChoices(k), value: p.model, disabled: KV.noModelFor(k), onChange: p.onModel,
      hint: k && k.needsModel && k.checking ? 'Asking ' + k.label + ' for its ' + KV.modelNoun(k) + 's.' : undefined });
    return h(React.Fragment, null,
      K.list.length > 1 ? Pair(h(A.Select, { id: p.id + '-kind', label: 'Agent', options: opts, value: k ? k.kind : '', onChange: p.onKind }), model) : model,
      k && !k.checking && !k.ready ? h(KindNeeds, { kind: k, onRecheck: K.recheck, checking: K.checking }) : null);
  }
  // A local model's list comes later than the dialog: pick its first model when it arrives, or when the one picked is gone.
  function useFirstModel(k, form, setForm) {
    var ids = k && k.models ? k.models.map(function (m) { return m.id; }).join('|') : '';
    useEffect(function () {
      if (!k || !k.needsModel) return;
      var ok = (k.models || []).some(function (m) { return m.id === form.model; });
      if (!ok) setForm(function (f) { return Object.assign({}, f, { model: KV.firstModel(k) }); });
    }, [k ? k.kind : '', ids]);
  }

  // A row of a dialog list goes (answered, kept). If the focus was on it, it falls to the page. Move it inside the dialog:
  // to the button of the row that took its place, else to the first dialog button. inner = any element inside the dialog.
  function refocusRow(inner, idx) {
    var root = inner && inner.closest('.ao-dialog');
    if (!root || root.contains(document.activeElement)) return;
    var rows = root.querySelectorAll('.past-row'), next = rows[Math.min(idx, rows.length - 1)];
    var f = next ? next.querySelector('button') : root.querySelector('.ao-dialog-a button');
    if (f) f.focus();
  }

  // ---------- room helpers ----------
  // The word for a session's model, from the models of its own kind (#101); an unknown id shows as itself.
  function modelWord(kinds, s) { return KV.modelWord(kindOf(kinds, s.provider), s.model, MODELS); }


  // The scene's own name of a session (unique per building), else its plain name.
  function sceneName(s) { return window.officeAdapter.botName(s.uid) || s.name; }

  Object.assign(O, { Area: Area, Busy: Busy, CostDialog: CostDialog, DEFAULT_KIND: DEFAULT_KIND, F: F,
      FeatureTags: FeatureTags, ISOLATION: ISOLATION, KIND: KIND, KV: KV, KindFields: KindFields, MODELS: MODELS,
      MODES: MODES, Pair: Pair, Pairs: Pairs, Tag: Tag, WHERE: WHERE, ago: ago, api: api, cadence: cadence, call: call,
      clip: clip, costAsked: costAsked, cssMs: cssMs, exportSession: exportSession, getInfo: getInfo, kindOf: kindOf,
      limitHint: limitHint, limitSent: limitSent, limitText: limitText, look: look, modelWord: modelWord, money: money,
      plural: plural, reduced: reduced, refocusRow: refocusRow, resetText: resetText, sceneName: sceneName,
      statusOf: statusOf, useChatBot: useChatBot, useFirstModel: useFirstModel, useKinds: useKinds,
      useSnapshot: useSnapshot });
})();
