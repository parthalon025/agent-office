/* Agent Office for Claude Code x0.2: page script.
   Mounts the DS office, the Reception, the lobby tour, the dialogs (open, past sessions, schedules, changes, hooks), and the pinned
   screens (#89): the chat and terminal on a desk monitor and the changes on a room's wall screen, laid over the 3D scene.
   There is no dock (#92): the office's actions are in the scene (open desks, the reception memo, the elevator) and in Ctrl+K. */
(function () {
  'use strict';
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
    // A cloud service reports no dollars. The office counts the prices the owner sets in the environment (README).
    return label + (cloud ? ' stops at this limit, counted from the prices you set (see the README). With no prices set, nothing is counted. Clear the field for no limit.' : ' stops at this limit. Clear the field for no limit.');
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
  // The kinds and their options come with the snapshot (officeAdapter.kinds(), from providers/index.mjs describe):
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

  // ---------- open a session ----------
  // "Use this folder": the opt-out of a room of its own. The DS has no Checkbox, so this is a native checkbox on DS tokens (.check in office.css).
  function UseFolder(p) {
    return h('div', { className: 'ao-field' },
      h('label', { className: 'check', htmlFor: 'f-usefolder' },
        h('input', { id: 'f-usefolder', type: 'checkbox', checked: !!p.checked, disabled: !!p.disabled, 'aria-describedby': 'f-usefolder-hint', onChange: function (e) { p.onChange(e.target.checked); } }),
        h('span', null, 'Use this folder')),
      h('span', { id: 'f-usefolder-hint', className: 'ao-hint' }, p.hint));
  }
  // True while the user set an Ask for a Claude Code call cell, in the office or in any building (snap.security.rules, the rules
  // the server sends). Only such an Ask opens the session in Default mode; a default Ask does not (security.mjs permissionModeFor).
  function userAskSet(sec) {
    var rules = sec && sec.rules, V = window.OfficeVocab.security;
    if (!rules) return false;
    var scopes = [null].concat(Object.keys(rules.buildings || {}));
    return Object.keys(V.rows).some(function (row) {
      return !V.rows[row].office && scopes.some(function (b) { return V.valueOf(rules, b, row, 'claude-code') === 'ask' && V.sourceOf(rules, b, row, 'claude-code') !== 'default'; });
    });
  }
  function OpenDialog(p) {
    var snapOpen = useSnapshot();
    var f = useState({ cwd: p.folder || p.shownPath || p.recent[0] || '', name: '', provider: p.kind || DEFAULT_KIND, where: 'office', useFolder: false, model: '', permissionMode: '', maxBudget: limitText(p.spendLimit), prompt: '', template: '' }), form = f[0], setForm = f[1];
    var K = useKinds(), k = kindOf(K.list, form.provider);
    useFirstModel(k, form, setForm);
    // The options of the kind (providers/index.mjs describe). Without kinds yet, the dialog offers what Claude Code takes.
    // limited: the kind takes a spend limit (paid and it reports cost); a kind whose cost is unknown has none (review M2).
    var canWindow = !k || k.terminal, limited = KV.limitShown(k), costNote = KV.costNote(k);
    var modes = k ? MODES.filter(function (o) { return !o.value || k.modes.indexOf(o.value) >= 0; }) : MODES;
    var hasModes = modes.length > 1;
    var b = useState(false), busy = b[0], setBusy = b[1];
    var e = useState(''), err = e[0], setErr = e[1];
    var sv = useState(null), saving = sv[0], setSaving = sv[1];
    function set(k) { return function (v) { var n = Object.assign({}, form); n[k] = v; setForm(n); }; }
    function pickTemplate(id) {
      var t = p.templates.filter(function (x) { return x.id === id; })[0];
      setForm(Object.assign({}, form, { template: id, prompt: t ? t.text : form.prompt }));
    }
    var cq = useState(null), costQ = cq[0], setCostQ = cq[1];   // the cost question of an agent that reports no cost, or null
    function submit(confirmed) {
      setBusy(true); setErr('');
      // Each agent gets its own room (a new worktree) unless the user keeps the folder. A terminal window always uses the folder.
      // Only the options the kind takes go to the server: a local model has no spend limit, window or permission mode.
      var where = canWindow ? form.where : 'office';
      var body = Object.assign({}, form, { where: where, isolation: form.useFolder || where === 'terminal' ? 'same' : 'worktree', permissionMode: hasModes ? form.permissionMode : '', maxBudget: limited ? limitSent(form.maxBudget, p.spendLimit !== undefined) : undefined, confirmCost: confirmed === true, role: p.role || undefined });
      delete body.useFolder;
      api('/api/open', body).then(function () { setBusy(false); setCostQ(null); p.onClose(); }, function (x) {
        setBusy(false);
        if (costAsked(x) && confirmed !== true) { setCostQ(x.message); return; }
        setErr(x.message);
      });
    }
    function saveTemplate() {
      api('/api/template/save', { name: saving, text: form.prompt }).then(function (t) { setSaving(null); p.onTemplates(); setForm(Object.assign({}, form, { template: t.id })); }, function (x) { setErr(x.message); });
    }
    function delTemplate() { api('/api/template/delete', { id: form.template }).then(function () { setForm(Object.assign({}, form, { template: '' })); p.onTemplates(); }, function (x) { setErr(x.message); }); }
    var terminal = canWindow && form.where === 'terminal';
    var blocked = KV.noModelFor(k) || KV.notConfigured(k);
    // The server owns the folder rules (place.mjs recentChoices); until its answer comes, show the stored list.
    var fc = useState(null), fetched = fc[0], setFetched = fc[1];
    useEffect(function () {
      call('/api/choices?first=' + encodeURIComponent(p.shownPath || ''))
        .then(function (r) { return r.json(); }).then(function (j) { setFetched(j.folders || null); }, function () {});
    }, [p.shownPath]);
    var folders = fetched || (p.recent || []).slice(0, 6);
    var tpl = [{ value: '', label: 'No template' }].concat(p.templates.map(function (t) { return { value: t.id, label: t.name }; }));
    if (costQ) return h(CostDialog, { title: 'Run ' + (k ? k.label : 'the agent'), text: costQ, busy: busy, err: err, onCancel: function () { setCostQ(null); setErr(''); }, onRun: function () { submit(true); } });
    return h(A.Dialog, {
      open: true, title: !p.roleName ? 'Open a session' : p.role === 'lobby' ? 'Start an agent at the open desks' : 'Start an agent on the ' + p.roleName + ' floor', onClose: p.onClose,
      actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: p.onClose }, 'Cancel'),
        h(A.Button, { key: 'o', variant: saving === null ? 'primary' : 'quiet', icon: 'add', loading: busy, disabled: blocked, onClick: submit }, p.roleName ? 'Start agent' : 'Open session')
      ]
    }, h('div', { className: 'form' },
      p.roleName ? h('p', { className: 'note' }, p.role === 'lobby' ? 'The agent sits at the open desks of the Lobby. It has no role yet.' : 'The agent sits at a desk on the ' + p.roleName + ' floor and takes its role.') : null,
      h('p', { className: 'note' }, KV.kindNote(k, terminal)),
      h(A.TextInput, { id: 'f-cwd', label: 'Folder', value: form.cwd, placeholder: 'E:\\pensiv', onChange: set('cwd'), error: err || undefined, hint: p.shownPath && form.cwd === p.shownPath ? 'The building you are looking at.' : undefined }),
      folders.length ? h('div', { className: 'chips', role: 'group', 'aria-label': 'Recent folders' }, folders.map(function (d) { return h(A.Button, { key: d, variant: 'quiet', icon: 'floor', title: d, onClick: function () { set('cwd')(d); } }, F.shortPath(d)); })) : null,
      h(KindFields, { id: 'f', kinds: K, kind: form.provider, model: form.model, onKind: function (id) { setForm(KV.withKind(form, kindOf(K.list, id), id)); }, onModel: set('model') }),
      Pairs([
        h(A.TextInput, { key: 'n', id: 'f-name', label: 'Bot name (optional)', value: form.name, placeholder: 'Defaults to the folder name', onChange: set('name') }),
        canWindow ? h(A.Select, { key: 'w', id: 'f-where', label: 'Runs', options: WHERE, value: form.where, onChange: set('where') }) : null,
        h(UseFolder, { key: 'i', checked: form.useFolder || terminal, disabled: terminal, onChange: set('useFolder'),
          hint: terminal ? 'A terminal window works in the folder.' : form.useFolder ? 'The agent works in this folder. Other agents in it share its room.' : 'The agent gets its own room: a new branch in its own folder next to the repository. Your branch stays untouched.' }),
        limited ? h(A.TextInput, { key: 'b', id: 'f-budget', label: 'Spend limit in USD', value: form.maxBudget, placeholder: 'No limit', disabled: terminal, onChange: set('maxBudget'), hint: terminal ? undefined : limitHint(k ? k.label : 'Claude Code', k && k.cloud) })
          : costNote ? h('p', { key: 'b', className: 'note' }, costNote) : null,
        // The server opens Claude Code in Default mode while a rule the user set to Ask applies (security.mjs permissionModeFor); the hint shows only then.
        hasModes ? h(A.Select, { key: 'm', id: 'f-mode', label: 'Permissions', options: modes, value: form.permissionMode, onChange: set('permissionMode'),
          hint: form.permissionMode === 'acceptEdits' && form.provider === 'claude-code' && userAskSet(snapOpen && snapOpen.security) ? 'A Security room rule you set to Ask opens the session in Default mode. The office then answers its edits by the rules.' : undefined }) : null]),
      p.templates.length ? h(A.Select, { id: 'f-template', label: 'Template', options: tpl, value: form.template, onChange: pickTemplate }) : null,
      h(Area, { id: 'f-prompt', label: 'First instruction (optional)', value: form.prompt, placeholder: 'Review the open PRs and list what blocks merge.', rows: 4, onChange: set('prompt') }),
      saving === null
        ? h('div', { className: 'inline-actions' },
            h(A.Button, { variant: 'ghost', icon: 'copy', disabled: !form.prompt.trim(), onClick: function () { setSaving(''); } }, 'Save as template'),
            form.template ? h(A.Button, { variant: 'ghost', icon: 'remove', onClick: delTemplate }, 'Delete template') : null)
        : h('div', { className: 'inline-actions' },
            h(A.TextInput, { id: 'f-tname', label: 'Template name', value: saving, onChange: setSaving }),
            h(A.Button, { variant: 'primary', disabled: !saving.trim(), onClick: saveTemplate }, 'Save'),
            h(A.Button, { variant: 'quiet', onClick: function () { setSaving(null); } }, 'Cancel'))));
  }

  // ---------- skills an agent writes (#72) ----------
  // The room panel opens this for an agent kind that declares skills (Hermes). The user reads, edits and deletes. A write is held:
  // the server answers 409 with confirm: 'skill' and the question, the dialog asks, and the same call goes again with confirmed: true.
  function SkillsDialog(p) {
    var ls = useState(null), list = ls[0], setList = ls[1];
    var ed = useState(null), edit = ed[0], setEdit = ed[1];       // { name, text, orig }: the skill in the editor
    var cf = useState(null), ask = cf[0], setAsk = cf[1];         // { action, name, text, question }: waiting for the user's yes
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    function load() { api('/api/skills/list', { provider: p.kind }).then(function (j) { setList(j); }, function (x) { setList({ skills: [] }); setErr(x.message); }); }
    useEffect(load, []);
    function openEdit(name) {
      setBusy(name); setErr('');
      api('/api/skills/read', { provider: p.kind, name: name }).then(function (j) { setBusy(''); setEdit({ name: name, text: j.text, orig: j.text }); }, function (x) { setBusy(''); setErr(x.message); });
    }
    // action: 'save' or 'delete'. The first call asks; the call with confirmed: true writes.
    function write(action, name, text, confirmed) {
      setBusy(action + name); setErr('');
      api('/api/skills/' + action, { provider: p.kind, name: name, text: text, confirmed: confirmed === true }).then(function () {
        setBusy(''); setAsk(null); setEdit(null);
        p.toast({ tone: 'success', title: p.agent, text: action === 'delete' ? 'Skill ' + name + ' deleted' : 'Skill ' + name + ' saved' });
        load();
      }, function (x) {
        setBusy('');
        if (x.body && x.body.confirm === 'skill' && !confirmed) { setAsk({ action: action, name: name, text: text, question: x.message }); return; }
        setErr(x.message);
      });
    }
    if (ask) {
      var back = function () { setAsk(null); setErr(''); };
      var del = ask.action === 'delete';
      return h(A.Dialog, { key: 'ask', open: true, title: (del ? 'Delete ' : 'Save ') + ask.name, onClose: back, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: back }, 'Keep it as it is'),
        h(A.Button, { key: 'y', variant: del ? 'danger' : 'primary', icon: del ? 'remove' : 'approve', loading: busy === ask.action + ask.name, onClick: function () { write(ask.action, ask.name, ask.text, true); } }, del ? 'Delete skill' : 'Save skill')] },
        h('div', { className: 'form' }, h('p', { className: 'note' }, ask.question), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (edit) {
      var changed = edit.text !== edit.orig, leave = function () { setEdit(null); setErr(''); };
      return h(A.Dialog, { key: 'edit', open: true, title: 'Skill ' + edit.name, onClose: leave, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: leave }, 'Back to the list'),
        h(A.Button, { key: 's', variant: 'primary', icon: 'approve', disabled: !changed, loading: busy === 'save' + edit.name, onClick: function () { write('save', edit.name, edit.text, false); } }, 'Save skill')] },
        h('div', { className: 'form wide' },
          h('p', { className: 'note' }, p.agent + ' follows this skill in later sessions. Saving asks you first.'),
          h(Area, { id: 'sk-text', label: 'SKILL.md', value: edit.text, rows: 14, onChange: function (v) { setEdit(Object.assign({}, edit, { text: v })); }, error: err || undefined })));
    }
    var skills = list ? list.skills : null;
    return h(A.Dialog, { key: 'list', open: true, title: 'Skills of ' + p.agent, onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'Skills that ' + p.agent + ' wrote for itself. You can read, edit and delete them. It makes new ones on its own.'),
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h(Busy, { on: skills === null }),
        skills && !skills.length ? h(A.EmptyState, { icon: 'skill', title: 'No skills yet', text: p.agent + ' has not written a skill.' }) : null,
        h('ul', { className: 'past' }, (skills || []).map(function (k) {
          return h('li', { key: k.name, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, k.title), h(Tag, null, k.name)),
              k.description ? h('div', { className: 'past-snip' }, k.description) : null,
              h('div', { className: 'past-meta mono' }, ago(k.at) + ' · ' + k.bytes + ' bytes')),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'tool', loading: busy === k.name, onClick: function () { openEdit(k.name); } }, 'Edit'),
              h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { write('delete', k.name, '', false); } }, 'Delete')));
        }))));
  }

  // ---------- past sessions and search ----------
  function PastDialog(p) {
    var l = useState(null), list = l[0], setList = l[1];
    var qs = useState(''), q = qs[0], setQ = qs[1];
    var rs = useState(null), results = rs[0], setResults = rs[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var ak = useState(null), ask = ak[0], setAsk = ak[1];   // the session the user is about to forget
    var rc = useState(null), runAsk = rc[0], setRunAsk = rc[1];   // { s, text }: its agent reports no cost, so ask before it runs
    var fa = useState(null), forkAsk = fa[0], setForkAsk = fa[1];   // { s, text }: Fork waits for the user's yes
    function load() { api('/api/history').then(function (j) { setList(j.sessions); }, function (x) { setErr(x.message); }); }
    useEffect(load, []);
    useEffect(function () {
      if (q.trim().length < 2) { setResults(null); return undefined; }
      var t = setTimeout(function () { api('/api/search', { q: q }).then(function (j) { setResults(j.results); }, function (x) { setErr(x.message); }); }, 250);
      return function () { clearTimeout(t); };
    }, [q]);
    function act(uid, fn) { setBusy(uid); setErr(''); fn().then(function () { setBusy(''); }, function (x) { setBusy(''); setErr(x.message); }); }
    // The server answers confirm: 'cost' for an agent that reports no cost: the user says yes once, then the same call runs it.
    function reopen(s, confirmed) {
      act(s.uid, function () {
        return api('/api/reopen', { uid: s.uid, confirmCost: confirmed === true }).then(function () { setRunAsk(null); p.onClose(); }, function (x) {
          if (costAsked(x) && !confirmed) { setRunAsk({ s: s, text: x.message }); return; }
          throw x;
        });
      });
    }
    // Fork (#72) writes a worktree and a session, so the server holds it: 409 with confirm: 'fork' and the question; the same call with confirmed: true runs it.
    function fork(s, confirmed) {
      act(s.uid, function () {
        return api('/api/fork', { uid: s.uid, confirmed: confirmed === true }).then(function () {
          setForkAsk(null); if (p.toast) p.toast({ tone: 'success', title: s.name, text: 'Forked into a new worktree' }); p.onClose();
        }, function (x) {
          if (x.body && x.body.confirm === 'fork' && !confirmed) { setForkAsk({ s: s, text: x.message }); return; }
          throw x;
        });
      });
    }
    function forget(uid) { act(uid, function () { return api('/api/history/forget', { uid: uid }).then(function () { setAsk(null); if (p.toast) p.toast({ tone: 'info', title: 'Session forgotten', text: 'It is gone from Past sessions.' }); load(); }); }); }
    if (ask) {
      return h(A.Dialog, { open: true, title: 'Forget ' + ask.name, onClose: function () { setAsk(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'f', variant: 'danger', icon: 'remove', loading: busy === ask.uid, onClick: function () { forget(ask.uid); } }, 'Forget session')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'Removes this session from Past sessions, with its saved history. You cannot reopen it after that. Files in the folder stay.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (forkAsk) {
      var stopFork = function () { setForkAsk(null); setErr(''); };
      return h(A.Dialog, { open: true, title: 'Fork ' + forkAsk.s.name, onClose: stopFork, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: stopFork }, 'Cancel'),
        h(A.Button, { key: 'f', variant: 'primary', icon: 'flow', loading: busy === forkAsk.s.uid, onClick: function () { fork(forkAsk.s, true); } }, 'Fork session')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, forkAsk.text),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (runAsk) return h(CostDialog, { title: 'Reopen ' + runAsk.s.name, text: runAsk.text, busy: busy === runAsk.s.uid, err: err, onCancel: function () { setRunAsk(null); setErr(''); }, onRun: function () { reopen(runAsk.s, true); } });
    var hit = {};
    (results || []).forEach(function (r) { hit[r.uid] = hit[r.uid] || r; });
    var shown = results ? (list || []).filter(function (s) { return hit[s.uid]; }) : list;
    return h(A.Dialog, { open: true, title: 'Past sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h(A.TextInput, { id: 'f-search', label: 'Search every session', value: q, placeholder: 'A word from a reply, a folder or a first instruction', onChange: setQ, error: err || undefined }),
        h(Busy, { on: list === null }),
        list && !shown.length ? h(A.EmptyState, { icon: 'session', title: results ? 'No match' : 'No past sessions yet', text: results ? 'Try another word.' : 'Sessions that run in the office are saved here when they close.' }) : null,
        h('ul', { className: 'past' }, (shown || []).map(function (s) {
          return h('li', { key: s.uid, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, s.name), h(Tag, null, window.officeAdapter.kindWord(s)), s.branch ? h(Tag, null, s.branch) : null, s.model ? h(A.ModelBadge, { model: s.model }) : null),
              h('div', { className: 'past-sub mono', title: s.cwd }, F.shortPath(s.cwd)),
              hit[s.uid] ? h('div', { className: 'past-snip' }, h('em', null, hit[s.uid].kind + ': '), hit[s.uid].snippet) : (s.last ? h('div', { className: 'past-snip past-clip' }, s.last) : null),
              h('div', { className: 'past-meta mono' }, ago(s.endedAt) + ' · ' + plural(s.turns || 0, 'turn') + ' · ' + F.costLabel(s.cost, s.costUnknown))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'rollback', loading: busy === s.uid, onClick: function () { reopen(s); } }, 'Reopen'),
              window.OfficeVocab.hasFeature(s, 'fork') ? h(A.Button, { variant: 'quiet', icon: 'flow', disabled: busy === s.uid, title: 'Open a copy of this session in a new worktree', onClick: function () { fork(s, false); } }, 'Fork') : null,
              h(A.Button, { variant: 'quiet', icon: 'copy', title: 'Save this session as a Markdown file', onClick: function () { exportSession(s.uid, p.toast); } }, 'Export'),
              h(A.Button, { variant: 'quiet', icon: 'trace', onClick: function () { p.onChanges(s.uid, s.name); } }, 'Changes'),
              h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setAsk(s); } }, 'Forget')));
        }))));
  }

  // ---------- schedules ----------
  var BLANK = { id: '', name: '', cwd: '', prompt: '', provider: DEFAULT_KIND, kind: 'every', every: '60', at: '09:00', model: '', permissionMode: '', isolation: 'same', maxBudget: '', enabled: true };
  function SchedulesDialog(p) {
    var K = useKinds();
    var l = useState(null), list = l[0], setList = l[1];
    var ed = useState(null), edit = ed[0], setEdit = ed[1];
    // The same kind rules as Open session (vocab.js): the kind's models, no spend limit for a free kind, a model it needs.
    var k = edit ? kindOf(K.list, edit.provider) : null, limited = KV.limitShown(k);
    useFirstModel(k, edit || {}, function (fn) { setEdit(function (e) { return e ? fn(e) : e; }); });
    var er = useState(''), err = er[0], setErr = er[1];
    function load() { getInfo().then(function (i) { setList(i.schedules || []); p.onInfo(i); }, function (x) { setErr(x.message); }); }
    useEffect(load, []);
    function set(k) { return function (v) { var n = Object.assign({}, edit); n[k] = v; setEdit(n); }; }
    function save() {
      api('/api/schedule/save', Object.assign({}, edit, { every: Number(edit.every) || 60, maxBudget: limited ? limitSent(edit.maxBudget, p.spendLimit !== undefined) : undefined })).then(function () { if (p.toast) p.toast({ tone: 'success', title: edit.id ? 'Schedule saved' : 'Schedule added', text: edit.name || cadence(edit) }); setEdit(null); setErr(''); load(); }, function (x) { setErr(x.message); });
    }
    var dl = useState(null), ask = dl[0], setAsk = dl[1];   // the schedule the user is about to delete
    function run(s) { api('/api/schedule/run', { id: s.id }).then(function () { setErr(''); if (p.toast) p.toast({ tone: 'success', title: s.name || 'Schedule', text: 'A session is starting now.' }); }, function (x) { setErr(x.message); }); }
    function del(id) { api('/api/schedule/delete', { id: id }).then(function () { setAsk(null); if (p.toast) p.toast({ tone: 'info', title: 'Schedule deleted', text: 'It will not run again.' }); load(); }, function (x) { setErr(x.message); }); }
    if (ask && !edit) {
      return h(A.Dialog, { open: true, title: 'Delete ' + (ask.name || 'this schedule'), onClose: function () { setAsk(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'd', variant: 'danger', icon: 'remove', onClick: function () { del(ask.id); } }, 'Delete schedule')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'The schedule will not run again. Sessions it already started stay open.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    function toggle(s) { api('/api/schedule/save', Object.assign({}, s, { enabled: !s.enabled })).then(load, function (x) { setErr(x.message); }); }
    if (edit) {
      return h(A.Dialog, { open: true, title: edit.id ? 'Edit schedule' : 'New schedule', onClose: function () { setEdit(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setEdit(null); } }, 'Cancel'),
        h(A.Button, { key: 's', variant: 'primary', disabled: KV.noModelFor(k) || KV.notConfigured(k), onClick: save }, 'Save schedule')] },
        h('div', { className: 'form' },
          h(A.TextInput, { id: 's-name', label: 'Name', value: edit.name, placeholder: 'Nightly dependency check', onChange: set('name') }),
          h(A.TextInput, { id: 's-cwd', label: 'Folder', value: edit.cwd, placeholder: 'E:\\pensiv', onChange: set('cwd'), error: err || undefined }),
          Pair(
            h(A.Select, { id: 's-kind', label: 'Runs', options: KIND, value: edit.kind, onChange: set('kind') }),
            edit.kind === 'daily'
              ? h(A.TextInput, { id: 's-at', label: 'Time (24 hours)', value: edit.at, placeholder: '09:00', onChange: set('at') })
              : h(A.TextInput, { id: 's-every', label: 'Minutes (5 or more)', value: String(edit.every), onChange: set('every') })),
          h(KindFields, { id: 's', kinds: K, kind: edit.provider, model: edit.model, onKind: function (id) { setEdit(KV.withKind(edit, kindOf(K.list, id), id)); }, onModel: set('model') }),
          h(A.Select, { id: 's-iso', label: 'Work in', options: ISOLATION, value: edit.isolation, onChange: set('isolation') }),
          limited ? h(A.TextInput, { id: 's-budget', label: 'Spend limit per run in USD', value: String(edit.maxBudget || ''), placeholder: 'No limit', onChange: set('maxBudget'), hint: limitHint(k ? k.label : 'Claude Code', k && k.cloud) }) : null,
          h(Area, { id: 's-prompt', label: 'Instruction', value: edit.prompt, rows: 4, onChange: set('prompt') })));
    }
    return h(A.Dialog, { open: true, title: 'Schedules', onClose: p.onClose, actions: [
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h(Busy, { on: list === null }),
        list && !list.length ? h(A.EmptyState, { icon: 'schedule', title: 'No schedules yet', text: 'A schedule opens a session on its own and runs one instruction.' }) : null,
        list ? h(A.AddButton, { label: 'Add a schedule', onClick: function () { setEdit(Object.assign({}, BLANK, { cwd: (p.recent || [])[0] || '', maxBudget: limitText(p.spendLimit) })); } }) : null,
        h('ul', { className: 'past' }, (list || []).map(function (s) {
          return h('li', { key: s.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, s.name), h(Tag, null, s.enabled ? cadence(s) : 'Paused'), s.provider && s.provider !== DEFAULT_KIND ? h(Tag, null, window.officeAdapter.kindWord(s) || s.provider) : null),
              h('div', { className: 'past-sub mono', title: s.cwd }, F.shortPath(s.cwd)),
              h('div', { className: 'past-snip past-clip' }, clip(s.prompt, 140)),
              h('div', { className: 'past-meta mono' }, s.lastRun ? 'Last run ' + ago(s.lastRun) : 'Has not run yet'),
              s.lastError ? h('p', { className: 'ao-err', role: 'alert' }, 'Did not start: ' + s.lastError) : null),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'resume', title: 'Starts a session now with this instruction. The schedule keeps its own times.', onClick: function () { run(s); } }, 'Run now'),
              h(A.Button, { variant: 'quiet', icon: s.enabled ? 'pause' : 'resume', onClick: function () { toggle(s); } }, s.enabled ? 'Pause' : 'Turn on'),
              h(A.Button, { variant: 'quiet', icon: 'settings', onClick: function () { setEdit(Object.assign({}, s, { provider: s.provider || DEFAULT_KIND, every: String(s.every), maxBudget: s.maxBudget ? String(s.maxBudget) : '' })); } }, 'Edit'),
              h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setAsk(s); } }, 'Delete')));
        })),
        list && list.length ? h('p', { className: 'note' }, 'Run now starts a session at once with the schedule’s instruction. It does not change the times.') : null));
  }

  // ---------- changes (diff, pull request, worktree) ----------
  function DiffView(p) {
    var lines = p.text.split('\n').slice(0, 1800);
    return h('pre', { className: 'diff', tabIndex: 0, 'aria-label': 'Diff' }, lines.map(function (l, i) {
      var c = l.charAt(0), cls = l.indexOf('+++') === 0 || l.indexOf('---') === 0 || l.indexOf('diff ') === 0 || l.indexOf('index ') === 0 ? 'meta' : c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : '';
      return h('span', { key: i, className: 'dl ' + cls }, l === '' ? ' ' : l);
    }));
  }
  // The changes of one session (its folder): the diff, and the pull request and worktree removal behind a confirm dialog.
  // The room's wall screen (ChangesScreen, pinned) and the fallback dialog (ChangesDialog) share it.
  function useChanges(uid, toast) {
    var d = useState(null), data = d[0], setData = d[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var rs = useState(null), result = rs[0], setResult = rs[1];
    function load() { setErr(''); api('/api/changes', { uid: uid }).then(setData, function (x) { setErr(x.message); setData({ files: [], diff: '', branch: '', stat: '' }); }); }
    useEffect(load, [uid]);
    function run(fn) {
      setBusy(true); setErr('');
      fn().then(function (r) {
        setBusy(false); setConfirm(null); setResult(r); load();
        if (toast && r && r.url) toast({ tone: 'success', title: 'Pull request created', text: r.url });
        if (toast && r && r.removed) toast({ tone: 'info', title: 'Worktree removed', text: r.branchKept ? 'The branch was kept.' : 'The folder is gone.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    return { data: data, err: err, setErr: setErr, confirm: confirm, setConfirm: setConfirm, busy: busy, result: result, load: load, wt: data && data.worktree,
      pr: function () { run(function () { return api('/api/pr', { uid: uid }); }); },
      remove: function (force) { run(function () { return api('/api/worktree/remove', { uid: uid, force: force }); }); } };
  }
  // The confirm dialog of a pull request or a worktree removal, or null. Push, pull request and removal always ask here.
  function ChangesConfirm(p) {
    var c = p.c, wt = c.wt;
    if (c.confirm === 'pr') {
      return h(A.Dialog, { open: true, title: 'Create a pull request', onClose: function () { c.setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { c.setConfirm(null); } }, 'Cancel'),
        h(A.Button, { key: 'p', variant: 'primary', icon: 'send', loading: c.busy, onClick: c.pr }, 'Create pull request')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'This sends your changes to the remote repository. It does these steps in order:'),
          h('pre', { className: 'code' }, '1. git add -A and git commit\n2. git push -u origin ' + (wt ? wt.branch : '') + '\n3. gh pr create --fill'),
          c.err ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null));
    }
    if (c.confirm === 'rm') {
      var dirty = /uncommitted/i.test(c.err);
      return h(A.Dialog, { open: true, title: 'Remove the worktree', onClose: function () { c.setConfirm(null); c.setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { c.setConfirm(null); c.setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: c.busy, onClick: function () { c.remove(dirty); } }, dirty ? 'Remove and discard changes' : 'Remove worktree')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'Deletes the folder ' + (wt ? wt.root : '') + '. The branch ' + (wt ? wt.branch : '') + ' stays if it has commits that are not merged.'),
          c.err ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null));
    }
    return null;
  }
  // The buttons of the changes: Refresh, Remove worktree (a closed session only), Create pull request. Each of the last two opens its confirm.
  function changesActions(c, ended) {
    var data = c.data, wt = c.wt;
    return [
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: c.load }, 'Refresh'),
      wt ? h(A.Button, { key: 'rm', variant: 'quiet', icon: 'remove', disabled: !ended, title: ended ? '' : 'Close the session first', onClick: function () { c.setConfirm('rm'); } }, 'Remove worktree') : null,
      wt ? h(A.Button, { key: 'pr', variant: 'primary', icon: 'send', disabled: !data || (!data.files.length && !data.ahead), onClick: function () { c.setConfirm('pr'); } }, 'Create pull request') : null];
  }
  function ChangesBody(p) {
    var c = p.c, data = c.data, result = c.result;
    return h(React.Fragment, null,
      c.err && !c.confirm ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null,
      result && result.url ? h('p', { className: 'note' }, 'Pull request created: ', /^https:\/\//i.test(result.url) ? h('a', { href: result.url, target: '_blank', rel: 'noreferrer' }, result.url) : result.url) : null,
      result && result.removed ? h('p', { className: 'note' }, 'Worktree removed.' + (result.branchKept ? ' The branch was kept.' : '')) : null,
      h(Busy, { on: !data }),
      data ? h('div', { className: 'chg-head' },
        data.branch ? h(Tag, null, data.branch) : null,
        h('span', { className: 'mono' }, data.stat || (data.files.length ? data.files.length + ' changed' : 'No changes')),
        data.ahead ? h('span', { className: 'mono' }, data.ahead + ' commit' + (data.ahead > 1 ? 's' : '') + ' ahead') : null) : null,
      data && data.files.length ? h('ul', { className: 'files' }, data.files.map(function (f, i) { return h('li', { key: i }, h('span', { className: 'fcode fc-' + f.code.charAt(0) }, f.word), h('span', { className: 'mono' }, f.path)); })) : null,
      data && data.diff ? h(DiffView, { text: data.diff }) : null,
      data && data.commits && data.commits.length ? h('h3', { className: 'ext-h' }, 'Recent commits on ' + (data.branch || 'this branch'), h('span', { className: 'ext-n' }, data.commits.length)) : null,
      data && data.commits && data.commits.length ? h(A.CheckpointTimeline, { checkpoints: data.commits }) : null,
      data && data.truncated ? h('p', { className: 'note' }, 'The diff is long, so only the start is shown.') : null,
      data && !data.diff && data.files.length ? h('p', { className: 'note' }, 'These files are new, so git has no diff for them yet.') : null,
      data && !data.files.length && !c.err ? h(A.EmptyState, { icon: 'checkpoint', compact: true, title: 'Nothing changed yet', text: 'Changes show here as the session edits files.' }) : null);
  }
  // The changes of a session that has no room in the scene on screen (a past session, another building). In the office the
  // changes show on the room's wall screen (ChangesScreen).
  function ChangesDialog(p) {
    var c = useChanges(p.uid, p.toast);
    if (c.confirm) return h(ChangesConfirm, { c: c });
    return h(A.Dialog, { open: true, title: 'Changes in ' + (p.name || 'this session'), onClose: p.onClose, actions: changesActions(c, p.ended).concat([
      h(A.Button, { key: 'd', variant: c.wt ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')]) },
      h('div', { className: 'form wide' }, h(ChangesBody, { c: c })));
  }

  // ---------- hooks ----------
  function HooksDialog(p) {
    var i = p.info || {};
    var live = p.snap ? p.snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    var channels = [
      { id: 'office', name: 'Office sessions', route: 'Opened from this page', today: live.filter(function (s) { return s.headless && !s.scheduleId; }).length },
      { id: 'schedule', name: 'Schedules', route: 'Open an office session on time', today: live.filter(function (s) { return s.scheduleId; }).length },
      { id: 'terminal', name: 'Terminal sessions', route: (i.hooksMode || 'command') + ' hooks', today: live.filter(function (s) { return !s.headless; }).length }];
    // Copy needs a secure page. The office runs on localhost, which counts as one; if the browser still refuses, say so.
    function copy(text, what, byHand) {
      var ok = function () { if (p.toast) p.toast({ tone: 'success', title: 'Copied', text: what + ' is on your clipboard.' }); };
      var no = function () { if (p.toast) p.toast({ tone: 'error', title: 'Not copied', text: 'The browser blocked the copy. ' + (byHand || 'Select the text and copy it by hand.') }); };
      try { navigator.clipboard.writeText(text).then(ok, no); } catch (x) { no(); }
    }
    // The agent token stays hidden until the user clicks Show, so a screen share or a screenshot does not leak it (#60).
    // It shows in the HTTP hooks (the snippet), so the token field and the mask apply only when the snippet holds it.
    var tk = useState(false), tokenShown = tk[0], setTokenShown = tk[1];
    var token = i.agentToken || '';
    var tokenUsed = !!token && String(i.settingsSnippet || '').indexOf(token) >= 0;
    var snippetText = tokenUsed && !tokenShown ? F.maskSecret(i.settingsSnippet, token) : (i.settingsSnippet || '');
    var su = useState(i.startup || null), startup = su[0], setStartup = su[1];
    var sb = useState(false), startBusy = sb[0], setStartBusy = sb[1];
    function toggleStartup() {
      setStartBusy(true);
      api('/api/startup', { enabled: !startup.enabled }).then(function (r) {
        setStartup(r); setStartBusy(false);
        if (p.toast) p.toast({ tone: 'info', title: r.enabled ? 'Start with Windows is on' : 'Start with Windows is off', text: r.enabled ? 'The office starts when you sign in.' : 'The office no longer starts when you sign in.' });
      }, function (x) { setStartBusy(false); if (p.toast) p.toast({ tone: 'error', title: 'Not changed', text: x.message }); });
    }
    // The default spend limit (#33): new Claude Code sessions, schedules and goals start with it. A local model has no limit.
    var sl = useState(limitText(i.spendLimit)), limit = sl[0], setLimit = sl[1];
    var sg = useState(false), limitBusy = sg[0], setLimitBusy = sg[1];
    var le = useState(''), limitErr = le[0], setLimitErr = le[1];
    function saveLimit() {
      setLimitBusy(true); setLimitErr('');
      // An empty field is No limit; Save on the typed field is the confirm the server asks for (it refuses 0 without one).
      api('/api/settings/spend', { limit: limitSent(limit, true), confirmed: true }).then(function (r) {
        setLimitBusy(false);
        if (p.onSaved) p.onSaved();
        if (p.toast) p.toast({ tone: 'info', title: r.spendLimit > 0 ? 'Default spend limit saved' : 'Default spend limit cleared', text: r.spendLimit > 0 ? 'New Claude Code sessions stop at $' + r.spendLimit + '.' : 'New Claude Code sessions have no limit.' });
      }, function (x) { setLimitBusy(false); setLimitErr(x.message); });
    }
    return h(A.Dialog, { open: true, title: 'Attach sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form' },
        startup && startup.available ? h('h3', { className: 'ext-h' }, 'Start with Windows') : null,
        startup && startup.available && startup.canChange !== false ? h('p', { className: 'note' }, startup.enabled ? 'The office starts when you sign in. It adds one file to your Startup folder. It needs no admin rights.' : 'Start the office when you sign in to Windows. It adds one file to your Startup folder. It needs no admin rights.') : null,
        // Another office owns the entry (#108): show the state and the reason, and no button.
        startup && startup.available && startup.canChange === false ? h('p', { className: 'note' }, (startup.enabled ? 'Start with Windows is on.' : 'Start with Windows is off.') + ' ' + startup.reason) : null,
        startup && startup.available && startup.canChange !== false ? h(A.Button, { variant: 'quiet', disabled: startBusy, onClick: toggleStartup }, startup.enabled ? 'Turn off start with Windows' : 'Turn on start with Windows') : null,
        h('h3', { className: 'ext-h' }, 'Remote access'),
        h('p', { className: 'note' }, F.remoteNote(i.remote)),
        h('h3', { className: 'ext-h' }, 'Default spend limit'),
        h('p', { className: 'note' }, 'New Claude Code sessions, schedules and goals stop at this limit. Local models cost nothing and have no limit. You can change the limit for one session when you open it.'),
        h('div', { className: 'copy-row' },
          h(A.TextInput, { id: 'h-limit', label: 'Spend limit in USD', value: limit, placeholder: 'No limit', onChange: setLimit, error: limitErr || undefined, hint: 'Clear the field for no default limit.' }),
          h(A.Button, { variant: 'quiet', disabled: limitBusy, onClick: saveLimit }, 'Save limit')),
        h('h3', { className: 'ext-h' }, 'Where sessions come from'),
        h(A.ChannelList, { channels: channels }),
        h('p', { className: 'note' }, 'Sessions opened here are wired up for you. To seat a session you start yourself, launch it with the office settings file.'),
        h('div', { className: 'copy-row' },
          h('pre', { className: 'code', tabIndex: 0 }, i.launchCommand || ''),
          h(A.Button, { variant: 'quiet', icon: 'copy', disabled: !i.launchCommand, onClick: function () { copy(i.launchCommand, 'The launch command'); } }, 'Copy command')),
        h('p', { className: 'note' }, 'Hooks: ' + (i.hooksMode || '') + ' on Claude Code ' + (i.claudeVersion || '') + '. Or merge these hooks into ~/.claude/settings.json to seat every session on this machine.'),
        h('div', { className: 'copy-row' },
          h('pre', { className: 'code', tabIndex: 0, style: { maxHeight: 200 } }, snippetText),
          h(A.Button, { variant: 'quiet', icon: 'copy', disabled: !i.settingsSnippet, onClick: function () { copy(i.settingsSnippet, 'The hooks', tokenUsed ? 'Click Show, then select the text and copy it by hand.' : undefined); } }, 'Copy hooks')),
        tokenUsed ? h('h3', { className: 'ext-h' }, 'Agent token') : null,
        tokenUsed ? h('p', { className: 'note' }, 'The HTTP hooks use this token to reach the office. Keep it private. It stays hidden until you click Show token.') : null,
        tokenUsed ? h('div', { className: 'copy-row' },
          h(A.TextInput, { id: 'h-token', label: 'Agent token', type: tokenShown ? 'text' : 'password', value: token, onChange: function () { /* read only */ } }),
          h('div', { className: 'btn-row' },
            h(A.Button, { variant: 'quiet', onClick: function () { setTokenShown(!tokenShown); } }, tokenShown ? 'Hide token' : 'Show token'),
            h(A.Button, { variant: 'quiet', icon: 'copy', onClick: function () { copy(token, 'The agent token', 'Click Show token, then select the token and copy it by hand.'); } }, 'Copy token'))) : null,
        h(PaperclipConnect, { hq: p.snap && p.snap.hq, toast: p.toast })));
  }

  // ---------- Paperclip HQ (#76): connect, and what the office reads from it ----------
  // Off until the user connects it. Paperclip must run on this computer: the server refuses any address that is not on
  // 127.0.0.1 (paperclip.mjs checkUrl), and the field says so before the first try.
  function PaperclipConnect(p) {
    var q = p.hq, H = window.OfficeVocab.hq;
    var u = useState((q && q.url) || 'http://127.0.0.1:3100'), url = u[0], setUrl = u[1];
    var b = useState(false), busy = b[0], setBusy = b[1];
    var e = useState(''), err = e[0], setErr = e[1];
    var c = useState(''), company = c[0], setCompany = c[1];
    var choose = q && q.state === 'choose' ? q.companies || [] : null;
    function connect(co) {
      setBusy(true); setErr('');
      api('/api/paperclip/connect', { url: url, company: co || undefined }).then(function (r) {
        setBusy(false);
        if (r.choose) { setCompany(r.choose[0] ? r.choose[0].id : ''); return; }
        if (p.toast) p.toast({ tone: 'success', title: 'Paperclip connected', text: H.state(r.hq) + '. The office only reads it.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function disconnect() {
      setBusy(true);
      api('/api/paperclip/disconnect', {}).then(function () { setBusy(false); if (p.toast) p.toast({ tone: 'info', title: 'Paperclip disconnected', text: 'Paperclip runs on as before. The office no longer watches it.' }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    var on = q && q.state !== 'choose';
    return h(React.Fragment, null,
      h('h3', { className: 'ext-h' }, 'Paperclip HQ'),
      h('p', { className: 'note' }, 'Watch a Paperclip company from the office: its agents, tasks, budgets, heartbeats and routines show as an HQ building in the city. The office only reads Paperclip. It never sends heartbeats or assigns tasks. Paperclip must run on this computer, at 127.0.0.1.'),
      q ? h('p', { className: 'note', role: 'status' }, H.state(q)) : null,
      on ? h(A.Button, { variant: 'quiet', disabled: busy, onClick: disconnect }, 'Disconnect Paperclip')
        : h('div', { className: 'copy-row' },
          h(A.TextInput, { id: 'h-paperclip', label: 'Paperclip address', value: url, onChange: setUrl, error: err || undefined, hint: 'Only an address on 127.0.0.1, for example http://127.0.0.1:3100.' }),
          h(A.Button, { variant: 'quiet', loading: busy && !choose, disabled: busy, onClick: function () { connect(null); } }, 'Connect')),
      on && err ? h('p', { className: 'note', role: 'alert' }, err) : null,
      choose && choose.length ? h('div', { className: 'copy-row' },
        h(A.Select, { id: 'h-paperclip-co', label: 'Company', options: choose.map(function (x) { return { value: x.id, label: x.name }; }), value: company || choose[0].id, onChange: setCompany }),
        h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { connect(company || choose[0].id); } }, 'Watch this company')) : null);
  }

  // The HQ: what Paperclip says about its company. Read only: Paperclip runs its heartbeats, routines and budgets. Supervise
  // in office is on the Agents screen of a Security room, with its painted Confirm (no button here: one place for a write).
  function HqDialog(p) {
    var q = p.snap && p.snap.hq, H = window.OfficeVocab.hq;
    var close = [h(A.Button, { key: 'a', variant: 'quiet', onClick: p.onAttach }, 'Connection'), h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')];
    if (!q || !q.company) return h(A.Dialog, { open: true, title: 'Paperclip HQ', onClose: p.onClose, actions: close },
      h(A.EmptyState, { icon: 'hq', compact: true, title: 'Paperclip is not connected', text: q ? H.state(q) : 'Connect it in Attach sessions.' }));
    return h(A.Dialog, { open: true, title: q.company.name + ': Paperclip HQ', onClose: p.onClose, actions: close },
      h('div', { className: 'form wide' },
        h('p', { className: 'note', role: 'status' }, H.state(q)),
        h('p', { className: 'note' }, 'Budget for its runs: ' + H.budget(q.budget) + '. Paperclip keeps this budget. The office sets no second limit on Paperclip runs.'),
        h('h3', { className: 'ext-h' }, 'Agents'),
        q.agents.length ? h('ul', { className: 'past' }, q.agents.map(function (a) {
          var st = H.status(a), sup = H.supervision(a);
          var facts = [a.kind || 'adapter', a.heartbeat.on ? 'Heartbeat ' + H.every(a.heartbeat.every) + (a.heartbeat.last ? ', last ' + ago(a.heartbeat.last) : '') : 'No heartbeat', H.budget(a.budget)].join(' · ');
          return h('li', { key: a.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, a.name), h(Tag, null, a.title || a.role), h('span', { className: 'sess-state' }, h(A.StatusDot, { status: st.key }), st.word)),
              h('div', { className: 'past-meta' }, a.task ? (a.task.identifier ? a.task.identifier + ' ' : '') + a.task.title : 'No open task'),
              h('div', { className: 'past-sub mono' }, facts),
              h('div', { className: 'past-meta', title: a.supervision.why || undefined }, sup + (a.supervision.why ? '. ' + a.supervision.why : ''))));
        })) : h('p', { className: 'note' }, 'This company has no agents yet.'),
        h('h3', { className: 'ext-h' }, 'Routines'),
        q.routines.length ? h('ul', { className: 'past' }, q.routines.map(function (r) {
          return h('li', { key: r.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.title), r.status ? h(Tag, null, r.status) : null),
              h('div', { className: 'past-meta' }, [r.agent ? 'For ' + r.agent : '', r.cron ? 'Cron ' + r.cron : '', r.next ? 'Next ' + new Date(r.next).toLocaleString() : 'No next run'].filter(Boolean).join(' · '))));
        })) : h('p', { className: 'note' }, 'No routines.'),
        h('p', { className: 'note' }, 'Both schedulers run: Paperclip runs its heartbeats and routines, the office runs its own schedules. The office never starts, changes or stops a Paperclip run. To hold the Claude Code calls of an agent here, use Supervise in office on the Agents screen of a Security room.')));
  }

  // ---------- agent kinds: each provider, whether it is ready, and what it needs (#20) ----------
  function KindsDialog(p) {
    var K = useKinds();
    return h(A.Dialog, { open: true, title: 'Agent kinds', onClose: p.onClose, actions: [
      h(A.Button, { key: 'r', variant: 'quiet', icon: 'retry', loading: K.checking, onClick: K.recheck }, 'Check again'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'The agents the office can run. A kind that is not ready says what it needs. Local models run on this machine and cost nothing. Cloud kinds stay off until you set them up. The README has the steps.'),
        h(Busy, { on: !K.list.length }),
        h('ul', { className: 'past' }, K.list.map(function (k) {
          var r = KV.kindState(k);
          var facts = [k.terminal ? 'Runs in the office or a terminal window' : k.cloud ? 'Runs in your cloud account, steered from the office' : 'Runs in the office',
            KV.limitShown(k) ? (k.cloud ? 'Spend limit counts the prices you set' : 'Spend limit applies') : KV.costNote(k) ? 'Cost unknown, no spend limit' : 'No cost',
            k.modes.length ? 'Permission modes' : null, KV.pickFact(k), k.team ? 'A team: members show as helper bots' : null].filter(Boolean).join(' · ');
          var names = k.models.map(function (m) { return m.label || m.id; }).join(', ');
          var noun = KV.modelNoun(k);
          return h('li', { key: k.kind, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, k.label), h('span', { className: 'sess-state' }, h(A.StatusDot, { status: r.key }), r.word), k.version ? h(Tag, null, k.version) : null),
              h('div', { className: 'past-meta' }, facts),
              k.checking ? null : k.ready
                ? (names ? h('div', { className: 'past-sub mono', title: names }, noun.charAt(0).toUpperCase() + noun.slice(1) + 's: ' + names) : null)
                : h('ul', { className: 'kind-steps' }, (k.needs.length ? k.needs : ['It did not say what it needs.']).map(function (n, i) { return h('li', { key: i }, n); }))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'add', disabled: k.checking || KV.noModelFor(k) || KV.notConfigured(k), onClick: function () { p.onOpen(k.kind); } }, 'Open session')));
        }))));
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

  // ---------- floors (branches) and rooms (worktrees) ----------
  var IGNORED_NOTE = 'Files that git ignores in a room, such as a local .env, are deleted too. Copy them first if you need them.';
  function FloorsDialog(p) {
    var snap = useSnapshot();
    var repo = snap && (snap.repos || []).filter(function (r) { return r.key === p.repo; })[0];
    var nf = useState(null), form = nf[0], setForm = nf[1];          // new floor: { branch, from }
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];    // { kind: 'floor' | 'room', branch, root }
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var nr = useState(null), newRoom = nr[0], setNewRoom = nr[1];    // naming a room: { branch, name }
    var cl = useState(null), clean = cl[0], setClean = cl[1];         // clean up: null, or { floors: [{ branch, rooms }], kept: floors the user left out }
    var box = React.useRef(null), lastIdx = React.useRef(null);       // lastIdx: the row that Keep removed; null when no row went
    var DONE = {
      '/api/floor/cleanup': function (b, j) { return F.cleanupNote(j); },
      '/api/floor/create': ['success', 'Floor added', function (b) { return 'Branch ' + b.branch + ' with its first room.'; }],
      '/api/floor/delete': ['info', 'Floor deleted', function (b) { return 'Branch ' + b.branch + ' and its rooms are gone.'; }],
      '/api/room/create': ['success', 'Room added', function (b) { return 'A new worktree on ' + b.branch + '.'; }],
      '/api/room/delete': ['info', 'Room removed', function (b) { return 'The folder ' + String(b.root).split(/[\\/]/).pop() + ' is gone. Its branch stays.'; }] };
    function run(key, path, body, after) {
      setBusy(key); setErr('');
      api(path, Object.assign({ repo: p.repo }, body)).then(function (j) {
        setBusy(''); if (after) after();
        var t = DONE[path]; if (typeof t === 'function') t = t(body, j) ; else if (t) t = [t[0], t[1], t[2](body)];
        if (t && p.toast) p.toast({ tone: t[0], title: t[1], text: t[2] });
      }, function (x) { setBusy(''); setErr(x.message); });
    }
    // A Keep press removes its row, so the focus would fall to the page. Keep it in the dialog (see refocusRow).
    useEffect(function () {
      if (lastIdx.current == null) return;
      refocusRow(box.current, lastIdx.current); lastIdx.current = null;
    }, [clean ? clean.floors.map(function (f) { return f.branch; }).join('|') : null]);
    if (!repo) {
      return h(A.Dialog, { open: true, title: 'Floors and rooms', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
        h(A.EmptyState, { icon: 'floor', title: 'No repository here', text: 'Folders outside git have no branches. Open a session in a git repository to get floors.' }));
    }
    var floors = {}, order = [];
    // The floor of a room is the server's place rule: an agent room sits on the floor of its base branch.
    repo.worktrees.forEach(function (w) { var fl = w.place.floor; if (!floors[fl]) { floors[fl] = []; order.push(fl); } floors[fl].push(w); });
    var main = repo.worktrees.filter(function (w) { return w.main; })[0];

    if (clean) {
      var fl = clean.floors;
      return h(A.Dialog, { open: true, title: 'Clean up unused floors', onClose: function () { setClean(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setClean(null); setErr(''); } }, fl.length ? 'Keep them' : 'Close'),
        fl.length ? h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'cleanup', onClick: function () { run('cleanup', '/api/floor/cleanup', { branches: fl.map(function (f) { return f.branch; }) }, function () { setClean(null); }); } }, 'Delete ' + fl.length + (fl.length === 1 ? ' floor' : ' floors')) : null] },
        h('div', { className: 'form', ref: box },
          fl.length
            ? h('p', { className: 'note' }, 'These floors are merged into ' + (main ? main.branch : 'the main branch') + ', have no changes, no session and are over an hour old. Press Keep this floor to leave one out. Deleting removes the rest with their rooms and branches. No commit is lost. ' + IGNORED_NOTE)
            : h(A.EmptyState, { icon: 'floor', title: 'Nothing to clean up', text: F.cleanupEmpty(clean.kept) }),
          h('ul', { className: 'past' }, fl.map(function (f, i) {
            return h('li', { key: f.branch, className: 'past-row' },
              h('div', { className: 'past-title' }, h(A.Icon, { name: 'floor', size: 16 }), h('b', null, f.branch), h(Tag, null, f.rooms + (f.rooms === 1 ? ' room' : ' rooms'))),
              h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', onClick: function () { lastIdx.current = i; setClean({ floors: fl.filter(function (x) { return x.branch !== f.branch; }), kept: (clean.kept || 0) + 1 }); } }, 'Keep this floor')));
          })),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (confirm) {
      var isFloor = confirm.kind === 'floor';
      var forced = /anyway/i.test(err);
      var go = function () {
        if (isFloor) run('confirm', '/api/floor/delete', { branch: confirm.branch, force: forced }, function () { setConfirm(null); });
        else run('confirm', '/api/room/delete', { root: confirm.root, force: forced }, function () { setConfirm(null); });
      };
      return h(A.Dialog, { open: true, title: isFloor ? 'Delete the floor ' + confirm.branch : 'Remove the room', onClose: function () { setConfirm(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'confirm', onClick: go }, forced ? (isFloor ? 'Delete and lose the commits' : 'Remove and discard changes') : (isFloor ? 'Delete floor' : 'Remove room'))] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, isFloor
            ? 'Deletes the branch ' + confirm.branch + ' and removes its rooms (worktree folders). Git refuses when the branch has commits that are not merged. ' + IGNORED_NOTE
            : 'Deletes the folder ' + confirm.root + '. The branch ' + confirm.branch + (confirm.floor && confirm.floor !== confirm.branch ? ' stays, and so does the floor ' + confirm.floor + '. ' : ' and its floor stay. ') + IGNORED_NOTE),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }

    var branches = order.map(function (b) { return { value: b, label: b }; });
    return h(A.Dialog, { open: true, title: 'Floors and rooms in ' + repo.name, onClose: p.onClose, actions: [
      h(A.Button, { key: 'd', variant: form ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'A floor is a branch. A room is a worktree: a folder with the branch checked out. A floor can have more than one room. Its rooms share the branch, so a commit in one room shows in the others.'),
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        form ? h('div', { className: 'past-row' },
          h('div', { className: 'form' },
            Pair(
              h(A.TextInput, { id: 'f-branch', label: 'Floor name (branch)', value: form.branch, placeholder: 'feature/login', onChange: function (v) { setForm(Object.assign({}, form, { branch: v })); } }),
              h(A.Select, { id: 'f-from', label: 'Start from', options: branches, value: form.from, onChange: function (v) { setForm(Object.assign({}, form, { from: v })); } })),
            h(A.TextInput, { id: 'f-room', label: 'Name of the first room (optional)', value: form.name || '', placeholder: 'login-work', onChange: function (v) { setForm(Object.assign({}, form, { name: v })); } }),
            h('div', { className: 'inline-actions' },
              h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'new', disabled: !form.branch.trim(), onClick: function () { run('new', '/api/floor/create', { branch: form.branch.trim(), from: form.from, name: (form.name || '').trim() }, function () { setForm(null); }); } }, 'Create floor and room'),
              h(A.Button, { variant: 'quiet', onClick: function () { setForm(null); setErr(''); } }, 'Cancel')))) : null,
        h('ul', { className: 'past' }, order.map(function (b) {
          var rooms = floors[b], hasMain = rooms.some(function (w) { return w.main; });
          return h('li', { key: b, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h(A.Icon, { name: 'floor', size: 16 }), h('b', null, b), hasMain ? h(Tag, null, 'main folder') : null),
              rooms.map(function (w) {
                var here = (snap ? snap.sessions : []).filter(function (s) { return s.status !== 'ended' && s.place && s.place.rootKey === w.place.rootKey; });
                return h('div', { key: w.root, className: 'room-row' },
                  h(A.OfficeTypeBadge, { type: 'lab', label: w.place.room }), h('span', { className: 'past-sub mono', title: w.root }, F.shortPath(w.root)),
                  here.map(function (s) { return h('span', { key: s.uid, className: 'room-bot', title: s.name }, h(A.BotAvatar, { shape: window.officeAdapter.shapeOf(s.uid), color: colorOf(s.uid), status: statusOf(s), size: 20 }), s.name); }),
                  w.main ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'room', branch: w.branch, floor: b, root: w.root }); } }, 'Remove room'));
              }),
              newRoom && newRoom.branch === b ? h('div', { className: 'inline-actions' },
                h(A.TextInput, { id: 'r-name', label: 'Room name (optional)', value: newRoom.name, placeholder: 'review', onChange: function (v) { setNewRoom({ branch: b, name: v }); } }),
                h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'room:' + b, onClick: function () { run('room:' + b, '/api/room/create', { branch: b, name: newRoom.name.trim() }, function () { setNewRoom(null); }); } }, 'Add room'),
                h(A.Button, { variant: 'quiet', onClick: function () { setNewRoom(null); } }, 'Cancel')) : null),
            h('div', { className: 'past-actions' },
              newRoom && newRoom.branch === b ? null : h(A.Button, { variant: 'quiet', icon: 'add', onClick: function () { setErr(''); setNewRoom({ branch: b, name: '' }); } }, 'Add room'),
              hasMain ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'floor', branch: b }); } }, 'Delete floor')));
        })),
        form ? null : h('div', { className: 'inline-actions' },
          h(A.AddButton, { label: 'Add a floor', onClick: function () { setErr(''); setForm({ branch: '', from: main ? main.branch : '', name: '' }); } }),
          h(A.Button, { variant: 'quiet', icon: 'remove', loading: busy === 'stale', onClick: function () { setBusy('stale'); setErr(''); api('/api/floor/stale', { repo: p.repo }).then(function (j) { setBusy(''); setClean({ floors: j.floors }); }, function (x) { setBusy(''); setErr(x.message); }); } }, 'Clean up unused floors')),
        h(FloorsWithoutRooms, { repo: p.repo, busy: busy, run: run, shown: repo.worktrees.map(function (w) { return w.branch; }) })));
  }
  // Branches with no worktree: a room brings the floor into the building.
  function FloorsWithoutRooms(p) {
    var l = useState(null), list = l[0], setList = l[1];
    useEffect(function () { api('/api/branches', { repo: p.repo }).then(function (j) { setList(j.branches); }, function () { setList([]); }); }, [p.repo, p.shown.join('|')]);
    var rest = (list || []).filter(function (b) { return p.shown.indexOf(b) < 0; });
    if (!rest.length) return null;
    return h('div', { className: 'form' },
      h('p', { className: 'note' }, 'Branches with no room. Add a room to show the floor.'),
      h('ul', { className: 'past' }, rest.slice(0, 30).map(function (b) {
        return h('li', { key: b, className: 'past-row' },
          h('div', { className: 'past-title' }, h(A.Icon, { name: 'floor', size: 16 }), h('span', { className: 'mono' }, b)),
          h(A.Button, { variant: 'quiet', icon: 'add', loading: p.busy === 'room:' + b, onClick: function () { p.run('room:' + b, '/api/room/create', { branch: b }); } }, 'Add room'));
      })));
  }

  // ---------- extensions: connectors (MCP servers) and plugins ----------
  var MCP_WORD = { connected: ['finished', 'Connected'], pending: ['working', 'Connecting'], failed: ['error', 'Failed'], 'needs-auth': ['waiting', 'Needs sign-in'], disabled: ['resting', 'Off'] };
  // Connectors in the order a person looks for them: this folder first, then the account.
  var MCP_GROUPS = [{ id: 'folder', label: 'This folder' }, { id: 'plugin', label: 'From plugins' }, { id: 'user', label: 'Your Claude Code' }, { id: 'claudeai', label: 'claude.ai connectors' }, { id: 'other', label: 'Other' }];
  function groupOf(m) {
    if (m.source === 'plugin') return 'plugin';
    if (m.scope === 'local' || m.scope === 'project') return 'folder';
    if (m.scope === 'user') return 'user';
    if (m.scope === 'claudeai' || m.source === 'claudeai') return 'claudeai';
    return 'other';
  }
  var SCOPES = [{ value: 'local', label: 'This folder only (local)' }, { value: 'project', label: 'Shared in the repository (project)' }];
  function ExtensionsDialog(p) {
    var tb = useState('connectors'), tab = tb[0], setTab = tb[1];
    var dt = useState(null), data = dt[0], setData = dt[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var nt = useState(''), note = nt[0], setNote = nt[1];
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var ad = useState(null), add = ad[0], setAdd = ad[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var qq = useState(''), q = qq[0], setQ = qq[1];
    var pq = useState(''), pfind = pq[0], setPfind = pq[1];
    function load() { setErr(''); api('/api/ext/list', { uid: p.uid }).then(setData, function (x) { setErr(x.message); setData({ servers: null, plugins: [] }); }); }
    useEffect(load, [p.uid]);
    function act(key, body, done) {
      setBusy(key); setErr(''); setNote('');
      api('/api/ext', Object.assign({ uid: p.uid }, body)).then(function (r) {
        setBusy(''); if (r.restart) setNote('Saved. New sessions in this folder get the change. Close and reopen this session to use it now.');
        var said = { 'mcp-add': ['success', 'Connector added', body.name], 'mcp-remove': ['info', 'Connector removed', body.name], 'plugin-install': ['success', 'Plugin installed', body.id],
          'plugin-uninstall': ['info', 'Plugin removed', body.id], 'plugin-enable': ['success', 'Plugin on', body.id], 'plugin-disable': ['info', 'Plugin off', body.id],
          toggle: [body.enabled ? 'success' : 'info', body.enabled ? 'Connector on' : 'Connector off', body.name] }[body.action];
        if (said && p.toast) p.toast({ tone: said[0], title: said[1], text: String(said[2]) });
        if (done) done(); load();
      }, function (x) { setBusy(''); setErr(x.message); });
    }
    if (confirm) {
      return h(A.Dialog, { open: true, title: confirm.title, onClose: function () { setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'confirm', onClick: function () { act('confirm', confirm.body, function () { setConfirm(null); }); } }, confirm.button)] },
        h('div', { className: 'form' }, h('p', { className: 'note' }, confirm.text), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    var servers = data && data.servers, seenPl = {};
    var allPlugins = ((data && data.plugins) || []).filter(function (pl) { if (seenPl[pl.id]) return false; seenPl[pl.id] = true; return true; });
    var pt = pfind.trim().toLowerCase();
    var plugins = allPlugins.filter(function (pl) { return !pt || (pl.id + ' ' + (pl.scope || '')).toLowerCase().indexOf(pt) >= 0; });
    var persistent = function (scope) { return scope === 'local' || scope === 'project'; };
    var match = function (m) { var t = q.trim().toLowerCase(); return !t || (m.name + ' ' + m.status + ' ' + m.source + ' ' + m.scope).toLowerCase().indexOf(t) >= 0; };
    var shownServers = (servers || []).filter(match);

    var connectors = h('div', { className: 'form' },
      data && !data.live ? h('p', { className: 'note' }, 'This session runs in a terminal. Turn connectors on and off there with /mcp. You can still add and remove them for this folder.') : null,
      add && add.kind === 'mcp' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-name', label: 'Name', value: add.name, placeholder: 'sentry', onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } }),
          h(A.Select, { id: 'x-scope', label: 'Save for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h(A.TextInput, { id: 'x-target', label: 'URL or command', value: add.target, placeholder: 'https://mcp.sentry.dev/mcp  or  npx -y @scope/server', hint: 'A URL adds an HTTP connector. A command adds a local one that the session starts.', onChange: function (v) { setAdd(Object.assign({}, add, { target: v })); } }),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.name.trim() || !add.target.trim(), onClick: function () { act('add', { action: 'mcp-add', name: add.name.trim(), target: add.target.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Add connector'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      data && !add ? h(A.AddButton, { label: 'Add a connector', onClick: function () { setErr(''); setAdd({ kind: 'mcp', name: '', target: '', scope: 'local' }); } }) : null,
      !data ? h('p', { className: 'note', role: 'status' }, 'Asking the session for its connectors. A session that just opened can take half a minute while they start.') : null,
      h(Busy, { on: !data }),
      servers && !servers.length ? h(A.EmptyState, { icon: 'connector', compact: true, title: 'No connectors', text: 'Add one to give the session more tools.' }) : null,
      servers && servers.length > 6 ? h(A.TextInput, { id: 'x-filter', label: 'Find', value: q, placeholder: 'Name, status or source', onChange: setQ }) : null,
      MCP_GROUPS.map(function (g) {
        var rows = shownServers.filter(function (m) { return groupOf(m) === g.id; });
        if (!rows.length) return null;
        return h('section', { key: g.id, className: 'ext-group' },
          h('h3', { className: 'ext-h' }, g.label, h('span', { className: 'ext-n' }, rows.length)),
          h('ul', { className: 'ext-list' }, rows.map(function (m) {
            var w = MCP_WORD[m.status] || ['resting', m.status], off = m.status === 'disabled', own = m.name === 'office';
            return h('li', { key: m.name, className: 'ext-row' },
              h(A.StatusDot, { status: w[0] }),
              h('div', { className: 'ext-main' },
                h('div', { className: 'ext-name' }, m.name.replace(/^claude\.ai /, '').replace(/^plugin:([^:]+):.*/, '$1')),
                h('div', { className: 'ext-sub' }, w[1] + (m.tools != null && m.status === 'connected' ? ' · ' + plural(m.tools, 'tool', 'tools') : '') + (own ? ' · the office uses it' : '')),
                m.error ? h('div', { className: 'ext-err', title: m.error }, clip(m.error, 110)) : null),
              h('div', { className: 'ext-actions' },
                m.status === 'failed' ? h(A.Button, { variant: 'quiet', icon: 'retry', loading: busy === 'r:' + m.name, onClick: function () { act('r:' + m.name, { action: 'reconnect', name: m.name }); } }, 'Reconnect') : null,
                own ? null : h(A.Button, { variant: 'quiet', icon: off ? 'resume' : 'pause', disabled: !data.live, loading: busy === 't:' + m.name, onClick: function () { act('t:' + m.name, { action: 'toggle', name: m.name, enabled: off }); } }, off ? 'Turn on' : 'Turn off'),
                persistent(m.scope) && !own ? h(A.Button, { variant: 'ghost', icon: 'remove', title: 'Remove ' + m.name, onClick: function () { setConfirm({ title: 'Remove the connector ' + m.name, text: 'Removes ' + m.name + ' from the ' + m.scope + ' settings of this folder. Other folders keep their own settings.', button: 'Remove connector', body: { action: 'mcp-remove', name: m.name, scope: m.scope } }); } }, 'Remove') : null));
          })));
      }),
      servers && q && !shownServers.length ? h('p', { className: 'note' }, 'No connector matches.') : null,
      servers && servers.length ? h('p', { className: 'note' }, 'Turn off and Turn on change this session only. To change account and claude.ai connectors for good, use /mcp in Claude Code or claude.ai settings.') : null);

    var pluginList = h('div', { className: 'form' },
      add && add.kind === 'plugin' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-pid', label: 'Plugin', value: add.id, placeholder: 'name@marketplace', onChange: function (v) { setAdd(Object.assign({}, add, { id: v })); } }),
          h(A.Select, { id: 'x-pscope', label: 'Install for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.id.trim(), onClick: function () { act('add', { action: 'plugin-install', id: add.id.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Install plugin'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      data && !add ? h(A.AddButton, { label: 'Install a plugin', onClick: function () { setErr(''); setAdd({ kind: 'plugin', id: '', scope: 'local' }); } }) : null,
      h(Busy, { on: !data }),
      data && !allPlugins.length ? h(A.EmptyState, { icon: 'skill', compact: true, title: 'No plugins', text: 'Install one from a marketplace.' }) : null,
      allPlugins.length > 6 ? h(A.TextInput, { id: 'x-pfilter', label: 'Find', value: pfind, placeholder: 'Plugin name or marketplace', onChange: setPfind }) : null,
      allPlugins.length && pt && !plugins.length ? h('p', { className: 'note' }, 'No plugin matches.') : null,
      [{ on: true, label: 'On in this folder' }, { on: false, label: 'Off in this folder' }].map(function (g) {
        var rows = plugins.filter(function (pl) { return pl.enabled === g.on; });
        if (!rows.length) return null;
        return h('section', { key: String(g.on), className: 'ext-group' },
          h('h3', { className: 'ext-h' }, g.label, h('span', { className: 'ext-n' }, rows.length)),
          h('ul', { className: 'ext-list' }, rows.map(function (pl) {
            var name = pl.id.split('@')[0], from = pl.id.split('@')[1] || '';
            return h('li', { key: pl.id + pl.scope, className: 'ext-row' },
              h(A.StatusDot, { status: pl.enabled ? 'finished' : 'resting' }),
              h('div', { className: 'ext-main' },
                h('div', { className: 'ext-name' }, name),
                h('div', { className: 'ext-sub' }, (from ? from + ' · ' : '') + 'installed for ' + (pl.scope === 'user' ? 'you' : 'this folder') + ' · ' + pl.version)),
              h('div', { className: 'ext-actions' },
                h(A.Button, { variant: 'quiet', icon: pl.enabled ? 'pause' : 'resume', loading: busy === 'p:' + pl.id, onClick: function () { act('p:' + pl.id, { action: pl.enabled ? 'plugin-disable' : 'plugin-enable', id: pl.id, scope: 'local' }); } }, pl.enabled ? 'Turn off' : 'Turn on'),
                persistent(pl.scope) ? h(A.Button, { variant: 'ghost', icon: 'remove', title: 'Remove ' + name, onClick: function () { setConfirm({ title: 'Remove the plugin ' + name, text: 'Uninstalls ' + pl.id + ' from the ' + pl.scope + ' scope of this folder.', button: 'Remove plugin', body: { action: 'plugin-uninstall', id: pl.id, scope: pl.scope } }); } }, 'Remove') : null));
          })));
      }),
      h('p', { className: 'note' }, 'Turn on and Turn off save a setting for this folder only. The session reloads its plugins at once.'));

    return h(A.Dialog, { open: true, title: 'Extensions for ' + p.name, onClose: p.onClose, actions: [
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: load }, 'Refresh'),
      h(A.Button, { key: 'd', variant: add ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        data && data.folder ? h('p', { className: 'note mono', title: data.folder }, F.shortPath(data.folder)) : null,
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        note ? h('p', { className: 'note', role: 'status' }, note) : null,
        h(A.Tabs, { value: tab, onChange: function (v) { setTab(v); setAdd(null); }, label: 'Extension types',
          tabs: [{ id: 'connectors', label: 'Connectors', icon: 'connector', count: servers ? servers.length : undefined }, { id: 'plugins', label: 'Plugins', icon: 'skill', count: allPlugins.length }],
          render: function (id) { return id === 'plugins' ? pluginList : connectors; } })));
  }
  // ---------- all sessions: registry and subagents ----------
  function accessOf(s) { return s.mode === 'bypassPermissions' || s.mode === 'acceptEdits' || s.mode === 'auto' ? 'broad' : 'scoped'; }
  function SessionsDialog(p) {
    var snap = useSnapshot();
    var live = snap ? snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    var agents = live;
    var teams = live.filter(function (s) { return (s.agents || []).some(function (a) { return !a.done; }); });
    return h(A.Dialog, { open: true, title: 'All sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'Every open session in every building. Broad access means the session can edit files without asking (Accept edits or a bypass mode).'),
        !agents.length ? h(A.EmptyState, { icon: 'session', compact: true, title: 'No open sessions', text: 'Open a session to see it here.' }) : h('div', { className: 'table-wrap ao-panel' }, h('table', { className: 'ao-tbl sess-tbl' },
          h('thead', null, h('tr', null, ['Agent', 'Kind', 'Folder', 'State', 'Model', 'Access', 'Last event', ''].map(function (x, i) { return h('th', { key: i, scope: 'col' }, x); }))),
          h('tbody', null, agents.map(function (s) {
            var st = window.OfficeVocab.status(s);
            return h('tr', { key: s.uid },
              h('td', null, h('span', { className: 'sess-who' }, h(A.BotAvatar, { shape: window.officeAdapter.shapeOf(s.uid), color: colorOf(s.uid), status: statusOf(s), size: 20 }), h('b', null, sceneName(s)))),
              h('td', null, window.officeAdapter.kindWord(s)),
              h('td', { className: 'mono', title: s.cwd }, (s.git && s.git.branch ? s.git.branch + ' · ' : '') + F.folderName(s.cwd)),
              h('td', null, h('span', { className: 'sess-state' }, h(A.StatusDot, { status: st.key }), st.word)),
              h('td', null, h(A.ModelBadge, { model: s.model || 'default' })),
              h('td', null, h('span', { className: 'ao-badge' + (accessOf(s) === 'broad' ? ' ao-badge-warn' : '') }, accessOf(s))),
              h('td', { className: 'mono' }, ago(s.lastEvent)),
              h('td', null, h(A.Button, { variant: 'quiet', icon: 'chevron-right', title: 'Go to ' + sceneName(s), onClick: function () { p.onGo(s); } }, 'Go to')));
          })))),
        teams.length ? h('h3', { className: 'ext-h' }, 'Subagents at work', h('span', { className: 'ext-n' }, teams.length)) : null,
        teams.map(function (s) {
          var kids = s.agents.filter(function (a) { return !a.done; }).map(function (a) { return { name: a.type, shape: 'blob', status: 'working', task: a.task, ephemeral: true }; });
          return h(A.DelegationTree, { key: s.uid, max: Math.max(3, kids.length), tree: { name: s.name, shape: window.officeAdapter.shapeOf(s.uid), status: statusOf(s), task: s.prompt ? clip(s.prompt, 80) : '', children: kids }, onSelect: function () { p.onGo(s); } });
        })));
  }

  // ---------- the city: every repository as a building ----------
  function cityData(snap) {
    var out = window.officeAdapter.buildings(snap).map(function (b) {
      var def = window.officeAdapter.preview(b.key, snap), bots = [];
      def.floors.forEach(function (f) { f.rooms.forEach(function (r) { (r.bots || []).forEach(function (x) { bots.push({ uid: x.uid, name: x.name, status: x.status, word: x.word, shape: x.shape, floor: f.name }); }); }); });
      return { key: b.key, name: b.name, sessions: b.sessions, waiting: b.waiting, state: b.state, floors: def.floors.map(function (f) { return { name: f.name, key: f.key }; }), bots: bots };
    });
    var hq = hqBuilding(snap);
    return hq ? [hq].concat(out) : out;
  }
  // Paperclip HQ (#76): its company as the first building, once the office has read it. A pip per Paperclip agent, in the
  // state Paperclip reports (hq.status: never waiting, a Paperclip approval is not an office request). It is not a repository:
  // a click opens the HQ dialog, not a scene. Its sign carries the company's budget for its runs.
  var HQ_KEY = 'paperclip:hq';
  function hqBuilding(snap) {
    var q = snap && snap.hq, H = window.OfficeVocab.hq;
    if (!q || !q.company) return null;
    var bots = q.agents.map(function (a) { var st = H.status(a); return { uid: 'hq:' + a.id, name: a.name, status: st.key, word: st.word, floor: 'HQ' }; });
    var money = q.budget ? (q.budget.limit > 0 ? F.money(q.budget.spent) + ' of ' + F.money(q.budget.limit) : F.money(q.budget.spent)) : '';
    return { key: HQ_KEY, hq: true, name: q.company.name, sub: 'HQ · ' + plural(q.agents.length, 'agent', 'agents') + (money ? ' · ' + money : ''),
      line: (q.state === 'on' ? 'Paperclip HQ' : 'Paperclip HQ, not live') + ' · ' + plural(q.agents.length, 'agent', 'agents') + (q.budget ? ' · ' + H.budget(q.budget) : ''),
      sessions: 0, waiting: 0, live: q.state === 'on', floors: [{ name: 'HQ', key: 'hq' }], bots: bots };
  }
  // The themes come from the DS (AgentOffice.MODES: Day, Night, Sublevel, Fluent, Fluent Dark); the page keeps no copy of the list.
  var CITY_MODES = A.MODES;
  function themeMode() {
    var t = document.documentElement.getAttribute('data-theme');
    for (var i = 0; i < CITY_MODES.length; i++) if (CITY_MODES[i].theme === t) return CITY_MODES[i].id;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
  }
  // How many bots are in each state across all buildings (DS StatusCounts keys; a finished bot is at rest).
  function cityCounts(list) {
    var c = { working: 0, waiting: 0, error: 0, resting: 0 };
    list.forEach(function (b) { if (!b.hq) b.bots.forEach(function (x) { c[c[x.status] != null ? x.status : 'resting']++; }); });   // sessions only: HQ pips are Paperclip agents
    return c;
  }
  function CityView(p) {
    var snap = useSnapshot();
    var pal = useState(false), palOpen = pal[0], setPalOpen = pal[1];
    var md = useState(themeMode), mode = md[0], setMode = md[1];
    useEffect(function () {
      var mo = new MutationObserver(function () { setMode(themeMode()); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return function () { mo.disconnect(); };
    }, []);
    var ref = React.useRef(null), city = React.useRef(null), fitted = React.useRef(false);
    var hv = useState(null), hov = hv[0], setHov = hv[1];
    var list = snap ? cityData(snap) : [];
    useEffect(function () {
      if (!window.OfficeCity) return undefined;
      city.current = window.OfficeCity.mount(ref.current, { root: document.documentElement, onHover: setHov, onPick: function (d) { if (d.hq) p.onHq(); else p.onEnter(d.key, city.current); } });
      return function () { if (city.current) city.current.dispose(); city.current = null; };
    }, []);
    useEffect(function () {
      if (!city.current || !snap) return;
      city.current.update(list);
      if (!fitted.current) { fitted.current = true; city.current.fit(true); }
    }, [snap]);
    var waiting = list.reduce(function (n, b) { return n + b.waiting; }, 0);
    var counts = cityCounts(list), total = counts.working + counts.waiting + counts.error + counts.resting;
    // Palette bots: the name the palette shows and returns must be unique over all buildings, and it maps back to a building and a session uid.
    var palBots = [], palPick = {};
    list.forEach(function (b) { if (!b.hq) b.bots.forEach(function (x) {   // HQ pips are Paperclip agents, not sessions to go to
      var nm = x.name, i = 2;
      while (palPick[nm]) nm = x.name + ' ' + i++;
      palPick[nm] = { key: b.key, uid: x.uid };
      palBots.push({ name: nm, status: x.status, shape: x.shape, room: b.name });
    }); });
    function enterBot(name) { var t = palPick[name]; if (t) p.onEnter(t.key, city.current, t.uid); }
    // Ctrl+K in the city: the page's own actions (they include Go to each building), the theme, and the city view.
    var palActions = A.CommandPalette.actions({ setMode: function (m) { if (city.current) city.current.setMode(m); } })
      .filter(function (a) { return a.id.indexOf('page-b-') !== 0 && a.id.indexOf('page-s-go-') !== 0 && a.id !== 'page-city'; })   // the page's Go to only picks the building, and the bot rows already go to a session
      .concat(list.map(function (b) { return b.hq ? { id: 'city-hq', label: 'Open Paperclip HQ', icon: 'hq', group: 'Buildings', keywords: 'paperclip hq company agents budget heartbeats routines ' + b.name, run: p.onHq }
        : { id: 'city-go-' + b.key, label: 'Go to ' + b.name, icon: 'building', group: 'Buildings', keywords: 'building repository ' + b.name, run: function () { p.onEnter(b.key, city.current); } }; }))
      .concat([{ id: 'city-fit', label: 'Show all buildings', icon: 'building', group: 'City', run: function () { if (city.current) city.current.fit(false); } }]);
    return h('div', { className: 'city' },
      h('div', { ref: ref, className: 'city-scene' }),
      h('div', { className: 'city-hud' },
        h(A.Panel, { title: 'City', count: plural(list.length, 'building', 'buildings') },
          h('div', { className: 'city-tools' },
            h(A.ModeToggle, { value: mode, options: CITY_MODES, label: 'Theme', onChange: function (id) { if (city.current) city.current.setMode(id); } }),
            total ? h('div', { className: 'city-counts', title: 'Sessions in every building, by state' }, h(A.StatusCounts, { counts: counts })) : null,
            p.needs > 0 ? h(A.Button, { variant: 'emphasis', icon: 'waiting', className: 'city-needs', label: 'Needs you: ' + plural(p.needs, 'decision', 'decisions') + '. Go to the oldest.', title: 'Go to the oldest request', onClick: p.onNeeds }, 'Needs you · ' + p.needs) : null,
            h(A.Button, { variant: 'quiet', icon: 'search', onClick: function () { setPalOpen(true); } }, 'Search actions', h('kbd', { className: 'ao-kbd city-kbd', 'aria-hidden': 'true' }, 'Ctrl+K'))),
          !list.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a git repository to add its building.' }) : null,
          h('ul', { className: 'city-list' }, list.map(function (b) {
            return h('li', { key: b.key },
              h('button', { type: 'button', className: 'city-row' + (b.key === p.shown ? ' is-shown' : '') + (hov && hov.key === b.key ? ' is-hover' : '') + (b.hq ? ' is-hq' : ''), onClick: function () { if (b.hq) p.onHq(); else p.onEnter(b.key, city.current); } },
                h('span', { className: 'city-main' },
                  h('span', { className: 'city-name' }, b.hq ? h(A.Icon, { name: 'hq', size: 14, label: 'Paperclip HQ' }) : null, b.name),
                  h('span', { className: 'city-sub mono' }, b.hq ? b.line : plural(b.floors.length, 'floor', 'floors') + ' · ' + plural(b.sessions, 'session', 'sessions')),
                  b.waiting ? h('span', { className: 'city-wait' }, plural(b.waiting, 'request', 'requests')) : null),
                b.bots.length ? h('span', { className: 'city-dots', role: 'img', 'aria-label': b.bots.map(function (x) { return x.name + ' ' + x.word; }).join(', ') },
                  b.bots.slice(0, 12).map(function (x, i) { return h('span', { key: i, className: 'city-dot', title: x.name + ' · ' + x.word }, h(A.StatusDot, { status: x.status })); }),
                  b.bots.length > 12 ? h('span', { className: 'city-sub mono' }, '+' + (b.bots.length - 12)) : null) : null));
          })),
          h('p', { className: 'note' }, 'Each building is a repository. Each floor is a function, from Engineering to Records. Click a building, or zoom in on it, to go inside. In a building, zoom out to come back.'),
          waiting ? h('p', { className: 'note' }, plural(waiting, 'request waits', 'requests wait') + '. Buildings with a request show a beacon and lit windows.') : null)),
      hov ? h('div', { className: 'city-tag', role: 'status' }, h('b', null, hov.name), hov.hq ? ' · ' + hov.line : ' · ' + plural(hov.floors.length, 'floor', 'floors') + ' · ' + plural(hov.sessions, 'session', 'sessions') + (hov.waiting ? ' · ' + plural(hov.waiting, 'request', 'requests') : '')) : null,
      h('div', { className: 'city-zoom', role: 'toolbar', 'aria-label': 'City zoom' },
        h(A.Button, { variant: 'quiet', icon: 'zoom-in', title: 'Zoom in', onClick: function () { if (city.current) city.current.zoomBy(1.35); } }, 'Zoom in'),
        h(A.Button, { variant: 'quiet', icon: 'zoom-out', title: 'Zoom out', onClick: function () { if (city.current) city.current.zoomBy(1 / 1.35); } }, 'Zoom out'),
        h(A.Button, { variant: 'quiet', icon: 'building', onClick: function () { if (city.current) city.current.fit(false); } }, 'Show all')),
      h(A.CommandPalette, { open: palOpen, onClose: function () { setPalOpen(false); }, onOpen: function () { setPalOpen(true); }, bots: palBots, floors: [], actions: palActions, onBot: enterBot }));
  }

  // ---------- the room board, read up close ----------
  function BoardPanel(p) {
    var d = p.data;
    if (!d) return null;
    var word = window.OfficeVocab.toolShort;
    var call = function (c, kind) { return h(A.ToolCall, { key: c.id, call: { id: c.id, tool: word(c.name), kind: kind || 'api', ok: c.ok === null ? undefined : c.ok, ms: c.ms == null ? undefined : c.ms, args: c.detail ? { target: c.detail } : undefined, summary: c.err || (c.who ? 'by ' + c.who : undefined) } }); };
    return h('aside', { className: 'board-panel', 'aria-label': 'Board of ' + d.room },
      h(A.Panel, { title: d.room + (d.branch ? ' · ' + d.branch : ''), count: plural(d.sessions.length, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h(NeedsButton, { count: askCount(p.sessions), onGo: p.onGo }),
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
          d.pin ? h('p', { className: 'note board-pin' }, 'Note from ' + d.pin.by + ': ' + d.pin.text) : null,
          d.todos.length ? h(A.PlanCard, { title: 'To do', goal: d.goal ? clip(d.goal, 120) : undefined, steps: d.todos.map(function (t, i) { return { id: 't' + i, text: t.text, status: window.OfficeVocab.todoStatus(t) }; }) })
            : h(A.EmptyState, { icon: 'plan', compact: true, title: 'No to-do list', text: 'A session shows its plan here when it writes one.' }),
          h('h3', { className: 'ext-h' }, 'Browser', h('span', { className: 'ext-n' }, d.browser.length)),
          d.browser.length ? h('div', { className: 'board-calls' }, d.browser.slice().reverse().map(function (c) { return call(c, 'browser'); }))
            : h('p', { className: 'note' }, 'No browser steps yet. Playwright clicks, page loads and key presses show here.'),
          h('h3', { className: 'ext-h' }, 'Last steps', h('span', { className: 'ext-n' }, d.recent.length)),
          d.recent.length ? h('div', { className: 'board-calls' }, d.recent.slice().reverse().map(function (c) { return call(c, window.OfficeVocab.toolKind(c.name)); }))
            : h('p', { className: 'note' }, 'No tool calls yet.'),
          h('h3', { className: 'ext-h' }, 'Repository', d.tree && !d.tree.note ? h('span', { className: 'ext-n' }, plural(d.tree.total, 'file', 'files')) : null),
          d.tree && d.tree.note ? h('p', { className: 'note' }, d.tree.note + '.')   // board.js: a room outside git, or no file list
          : d.tree ? h('ul', { className: 'board-tree mono' }, d.tree.entries.map(function (e) {
            var hot = d.touched[e.name];
            return h('li', { key: e.name, className: hot ? 'is-hot' : '' }, h(A.Icon, { name: e.dir ? 'floor' : 'knowledge', size: 13 }), h('span', null, e.name + (e.dir ? '/' : '')), h('span', { className: 'ext-sub' }, (e.dir ? plural(e.files, 'file', 'files') : '') + (hot ? ' · ' + hot + ' touched' : '')));
          })) : h(A.Skeleton, { lines: 3, label: 'Loading' }))));
  }

  // The room's numbers, read beside the room when the camera faces the stats display.
  function StatsPanel(p) {
    var snap = useSnapshot();
    var info = p.mount.roomInfo(p.roomId, snap || undefined);
    var v = p.mount.figures(p.roomId, snap || undefined);
    var row = function (k, val) { return h('li', { key: k }, h('span', null, k), h('b', { className: 'mono' }, val)); };
    return h('aside', { className: 'board-panel', 'aria-label': 'Stats of ' + ((info.place && info.place.roomName) || 'this room') },
      h(A.Panel, { title: ((info.place && info.place.roomName) || 'Room') + ' · stats', count: plural(v.sessions, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h(NeedsButton, { count: askCount((info.sessions || []).concat(p.extra || [])), onGo: p.onGo }),
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
          h('ul', { className: 'stats-list' },
            row('Working', String(v.working)), row('Needs you', String(v.waiting)), row('Tool calls', String(v.toolCalls)),
            row('Tokens', v.tokens ? F.tokens(v.tokens) : 'none reported'), row('Cost', F.cost(v.cost, v.unknown)), row('To do done', v.todosDone + ' of ' + v.todosTotal),
            row('Last event', v.lastEvent ? ago(v.lastEvent) : 'none')))));
  }

  // Where a caret at pos in text a goes when the text becomes b: the same place in the part both share.
  // Text kept before the caret keeps it in place; text added before it moves it on; a caret inside a changed part
  // goes to the end of that part.
  function mapCaret(a, b, pos) {
    var p = 0, s = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    if (pos <= p) return pos;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return pos >= a.length - s ? b.length - (a.length - pos) : b.length - s;
  }

  // The notes board, written on in place: a text box laid exactly over the board on screen.
  function NotesEditor(p) {
    var tx = useState(p.text || ''), text = tx[0], setText = tx[1];
    var rc = useState(null), rect = rc[0], setRect = rc[1];
    var sv = useState('saved'), state = sv[0], setState = sv[1];
    var ref = React.useRef(null), timer = React.useRef(0);
    var base = React.useRef(p.version || 0), latest = React.useRef(p.text || ''), fromSent = React.useRef(false);
    var edits = React.useRef(0), inflight = React.useRef(false), queued = React.useRef(null), caret = React.useRef(null);
    // Text from outside (an agent's line, a merged save) replaces the box's value. The browser then puts the caret
    // at the end, so the user's next keys would land after the agent's line. Keep the caret where the user was.
    function showText(next) {
      var el = ref.current;
      if (el && document.activeElement === el && el.value !== next) caret.current = [mapCaret(el.value, next, el.selectionStart), mapCaret(el.value, next, el.selectionEnd)];
      latest.current = next; setText(next);
    }
    React.useLayoutEffect(function () {
      var c = caret.current, el = ref.current;
      caret.current = null;
      if (c && el && document.activeElement === el) el.setSelectionRange(c[0], c[1]);
    }, [text]);
    useEffect(function () {
      var raf = 0;
      function follow() { var r = p.rect(); if (r) setRect(function (o) { return o && Math.abs(o.left - r.left) < 0.5 && Math.abs(o.top - r.top) < 0.5 && Math.abs(o.width - r.width) < 0.5 ? o : r; }); raf = requestAnimationFrame(follow); }
      follow();
      return function () { cancelAnimationFrame(raf); };
    }, []);
    // Closing the editor sends the last edit at once, not drops it.
    useEffect(function () { return function () { if (timer.current) { clearTimeout(timer.current); timer.current = 0; save(latest.current); } }; }, []);
    // The box takes focus when it shows, and again when the camera lands, so the keys typed right after the flight go to the notes.
    // A dialog or the palette on top keeps its focus.
    useEffect(function () {
      var raf = 0, shown = false, landed = false;
      function tick() {
        raf = requestAnimationFrame(tick);
        var el = ref.current;
        if (!el || (window.OfficeBoard && window.OfficeBoard.layerOpen())) return;   // a layer keeps its focus
        if (!shown) { shown = true; el.focus({ preventScroll: true }); }
        if (!landed && !p.flying()) { landed = true; if (document.activeElement !== el) el.focus({ preventScroll: true }); }
      }
      tick();
      return function () { cancelAnimationFrame(raf); };
    }, []);
    // An idle editor takes a change that came from outside (an agent added a line).
    useEffect(function () {
      var ver = p.version || 0;
      if (state !== 'saved' || ver <= base.current) return;   // a save is pending, or this is our own save or an older snapshot
      base.current = ver; fromSent.current = false;
      if ((p.text || '') !== latest.current) showText(p.text || '');
    }, [p.version, state]);
    // The server keeps the merge rules (notes.mjs). The editor sends its text and the version it started from.
    function done() {
      inflight.current = false;
      var q = queued.current; queued.current = null;
      if (q !== null) save(latest.current);
    }
    function save(v) {
      if (inflight.current) { queued.current = v; return; }   // one save at a time
      inflight.current = true;
      var mark = edits.current;
      latest.current = v;
      var wasSent = fromSent.current;
      return api('/api/notes/save', { key: p.noteKey, text: v, base: base.current, sent: wasSent }).then(function (res) {
        var typedMore = edits.current !== mark;
        if (res.merged && res.text !== v) {
          // An agent changed the notes. The new base is the merged version. When the user typed on, the server keeps the
          // text we sent as the merge base of the next save (sent), so nothing is merged twice.
          base.current = res.version;
          if (typedMore) fromSent.current = true;
          else { fromSent.current = false; showText(res.text); }
          if (!wasSent) p.toast({ tone: 'info', title: 'Notes', text: 'An agent changed the notes. Your text is merged.' });
        } else { base.current = res.version; fromSent.current = false; }
        if (!typedMore) setState('saved');
        done();
      }, function (x) {
        setState('error'); p.toast({ tone: 'error', title: 'Notes', text: x.message });
        done();
      });
    }
    function change(v) {
      setText(v); setState('saving'); latest.current = v; edits.current++;
      clearTimeout(timer.current);
      timer.current = setTimeout(function () { timer.current = 0; save(v); }, 500);
    }
    if (!rect || rect.width < 40) return null;
    var fs = Math.max(16, rect.height / 14);   // never under 16 px
    return h('div', { className: 'notes-edit', style: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } },
      h('textarea', { ref: ref, className: 'notes-text', 'aria-label': 'Notes for this room', value: text, maxLength: 4000, placeholder: 'Write a reminder for this room. Agents in this room can read it.', style: { fontSize: fs + 'px' }, onChange: function (e) { change(e.target.value); },
        onKeyDown: function (e) { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } } }),
      h('div', { className: 'notes-bar' },
        h('span', { className: 'notes-state', role: 'status' }, state === 'saving' ? 'Saving' : state === 'error' ? 'Not saved' : 'Saved. Agents in this room can read the notes.'),
        h(A.Button, { variant: 'quiet', icon: 'approve', onClick: p.onClose }, 'Done')));
  }

  // ---------- room helpers ----------
  // The word for a session's model, from the models of its own kind (#101); an unknown id shows as itself.
  function modelWord(kinds, s) { return KV.modelWord(kindOf(kinds, s.provider), s.model, MODELS); }

  // ---------- the agents in one room ----------
  function RoomDialog(p) {
    var snap = useSnapshot();
    var info = p.mount.roomInfo(p.roomId, snap || undefined);
    var list = info.sessions, place = info.place;
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var ad = useState(null), add = ad[0], setAdd = ad[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var sk = useState(null), skills = sk[0], setSkills = sk[1];   // { kind, agent }: the Skills dialog of an agent kind (#72)
    var cur = confirm ? list.filter(function (s) { return s.uid === confirm; })[0] : null;
    // The agent kinds in this room that write skills (they declare the feature): one Skills button each, nothing for the others.
    var skillKinds = [];
    list.forEach(function (s) { if (window.OfficeVocab.hasFeature(s, 'skills') && s.provider && !skillKinds.some(function (k) { return k.kind === s.provider; })) skillKinds.push({ kind: s.provider, agent: window.officeAdapter.kindWord(s) }); });
    useEffect(function () { if (confirm && !cur) setConfirm(null); }, [confirm, !!cur]);
    // An ungated kind (ADR 0001) opens only in a room of its own, so a room's Add agent does not offer it.
    var KA = useKinds(true), K = Object.assign({}, KA, { list: KA.list.filter(function (x) { return x.gated !== false; }) });
    var addKind = add ? kindOf(K.list, add.provider) : null;
    var cq = useState(null), costQ = cq[0], setCostQ = cq[1];   // the cost question of an agent that reports no cost, or null
    useFirstModel(addKind, add || {}, function (fn) { setAdd(function (a) { return a ? fn(a) : a; }); });
    function closeSession() {
      setBusy(true);
      api('/api/close', { uid: cur.uid }).then(function () { setBusy(false); setConfirm(null); p.toast({ tone: 'success', title: cur.name, text: 'Session closed' }); }, function (x) { setBusy(false); setErr(x.message); });
    }
    function addAgent(confirmed) {
      var cwd = list.length && list[0].cwd ? list[0].cwd : place && place.path;
      if (!cwd) { setErr('This room has no folder yet.'); return; }
      setBusy(true); setErr('');
      api('/api/open', { cwd: cwd, name: add.name.trim(), provider: add.provider, where: 'office', isolation: 'same', model: add.model, prompt: add.prompt, confirmCost: confirmed === true })
        .then(function () { setBusy(false); setCostQ(null); setAdd(null); p.toast({ tone: 'success', title: 'Office', text: 'Agent added' }); }, function (x) {
          setBusy(false);
          if (costAsked(x) && confirmed !== true) { setCostQ(x.message); return; }
          setErr(x.message);
        });
    }
    var title = 'Agents in ' + ((place && place.roomName) || 'this room');
    if (costQ) return h(CostDialog, { title: 'Run ' + (addKind ? addKind.label : 'the agent'), text: costQ, busy: busy, err: err, onCancel: function () { setCostQ(null); setErr(''); }, onRun: function () { addAgent(true); } });
    if (skills) return h(SkillsDialog, { kind: skills.kind, agent: skills.agent, toast: p.toast, onClose: function () { setSkills(null); } });
    if (cur) {
      return h(A.Dialog, { key: 'confirm', open: true, title: 'Close ' + cur.name, onClose: function () { setConfirm(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); setErr(''); } }, 'Keep session'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy, onClick: closeSession }, 'Close session')] },
        h('div', { className: 'form' },
          h('p', null, 'This ends the session ' + cur.name + '. Its work in the folder stays.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    return h(A.Dialog, { key: add ? 'add' : 'list', open: true, title: title, onClose: p.onClose, actions: add
      ? [h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAdd(null); setErr(''); } }, 'Cancel'), h(A.Button, { key: 'a', variant: 'primary', icon: 'add', loading: busy, disabled: KV.noModelFor(addKind) || KV.notConfigured(addKind), onClick: addAgent }, 'Add agent')]
      : [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form' },
        add ? h(React.Fragment, null,
          h('p', { className: 'note' }, 'The agent runs in the office, in the folder of this room.'),
          h(KindFields, { id: 'ra', kinds: K, kind: add.provider, model: add.model, onKind: function (id) { setAdd(KV.withKind(add, kindOf(K.list, id), id)); }, onModel: function (v) { setAdd(Object.assign({}, add, { model: v })); } }),
          h(A.TextInput, { id: 'ra-name', label: 'Name (optional)', value: add.name, placeholder: 'Defaults to the folder name', onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } }),
          h(Area, { id: 'ra-prompt', label: 'First instruction (optional)', value: add.prompt, rows: 4, placeholder: 'Review the open PRs and list what blocks merge.', onChange: function (v) { setAdd(Object.assign({}, add, { prompt: v })); } }),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null)
        : h(React.Fragment, null,
          list.length ? h('ul', { className: 'agent-list' }, list.map(function (s) {
            return h('li', { key: s.uid, className: 'agent-row' },
              h(A.BotAvatar, { shape: window.officeAdapter.shapeOf(s.uid), color: colorOf(s.uid), status: statusOf(s), size: 28 }),
              h('span', { className: 'agent-who' }, h('b', null, s.name), h('span', { className: 'agent-sub' }, window.OfficeVocab.status(s).word + ' · ' + window.officeAdapter.kindWord(s) + ' · ' + modelWord(KA.list, s)), h(FeatureTags, { session: s })),
              h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { setErr(''); setConfirm(s.uid); } }, 'Close session'));
          })) : h(A.EmptyState, { icon: 'identity', compact: true, title: 'No agents here', text: 'Add an agent to start work in this room.' }),
          skillKinds.map(function (k) { return h(A.Button, { key: k.kind, variant: 'quiet', icon: 'skill', onClick: function () { setSkills(k); } }, 'Skills of ' + k.agent); }),
          h(A.AddButton, { label: 'Add an agent', onClick: function () { setErr(''); setAdd({ name: '', provider: DEFAULT_KIND, model: '', prompt: '' }); } }))));
  }

  // ---------- requests: the paper and the note on the desk (#90, desk.js) ----------
  // A request is answered on the desk, in the scene: a permission request is a paper with Approve and Decline stamps, a question is a
  // note with a text field. The panels and the look bar carry one button, which goes to the oldest request.
  function askCount(list) { var n = 0; (list || []).forEach(function (x) { n += window.OfficeVocab.requests(x).length; }); return n; }
  function NeedsButton(p) {
    if (!(p.count > 0)) return null;
    return h('div', { className: 'needs-go' }, h(A.Button, { variant: 'emphasis', icon: 'waiting', onClick: p.onGo }, 'Needs you · ' + p.count + '. Go to the request'));
  }

  // ---------- a screen in the room, looked at up close (scene-host.js focus) ----------
  // The page's boxes over the 3D scene. The scene host frames a screen in the part of the view they leave free.
  var COVERS = '.ao-hud-top, .ao-hud-left, .ao-hud-right, .ao-hud-zoom, .ao-hud-use, .ao-hud-syl, .ao-hud-scrub, .ao-hud-cast, .ao-hud-log, .tour-card, .board-panel, .look-bar';
  function sceneCovers(skip) {
    return [].slice.call(document.querySelectorAll(COVERS)).filter(function (el) {
      if (el === skip) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    }).map(function (el) { return el.getBoundingClientRect(); });
  }
  // The remembered layer per place (ADR 0006, #145): a count per layer, kept in this browser. A place used at Inspect opens
  // there on the first tap. A place with no history opens at Glance and shows its Look card first.
  var layerMem = (function () { try { return window.OfficeVocab.layers.parse(localStorage.getItem('ao-layers')); } catch (x) { return {}; } })();
  function noteLayer(place, layer) {
    if (!place) return;
    layerMem = window.OfficeVocab.layers.remember(layerMem, place, layer);
    try { localStorage.setItem('ao-layers', JSON.stringify(layerMem)); } catch (x) { /* private window */ }
  }
  // The Look layer of a room: one sentence, steps and cost for the room, then one row per agent. A row opens that agent (Inspect).
  function LookCard(p) {
    var L = window.OfficeVocab.layers, r = L.lookRoom(p.agents), list = p.agents || [];
    if (!list.length) return null;
    return h('div', { className: 'look-card' },
      h('p', { className: 'look-intent' }, r.intent),
      h('p', { className: 'look-facts mono' }, [list.length + (list.length === 1 ? ' agent' : ' agents'), r.progress, r.cost].filter(Boolean).join(' · ')),
      list.length > 1 ? h('ul', { className: 'look-agents' }, list.map(function (s) {
        var l = L.look(s);
        return h('li', { key: s.uid }, h('button', { type: 'button', className: 'look-agent', onClick: function () { p.onInspect(s); } },
          h('b', null, s.name || 'Agent'), h('span', null, [clip(l.intent, 60), l.progress, l.cost].filter(Boolean).join(' · '))));
      })) : null);
  }
  var LOOK_ICON = { board: 'plan', notes: 'memory', stats: 'cost', terminal: 'terminal', desk: 'add', lobby: 'building' };
  // While the camera looks at a screen: back to the room, or the screen's second step (the same as a second click).
  // It sits at the bottom of the free part of the view, and the screen is framed above it.
  // asks: sessions with open requests, shown in the bar while the page hides the HUD columns for the look (a Security screen
  // at 820 px and below, review M6), so an approval never hides. The bar is placed again when they change.
  function LookBar(p) {
    var ref = React.useRef(null);
    var ps = useState(null), pos = ps[0], setPos = ps[1];
    var asks = p.asks || [], askKey = String(askCount(asks));
    var placeRef = React.useRef(null);
    React.useLayoutEffect(function () {
      function place() {
        var el = ref.current, f = el && p.free(el);
        if (!f) return;
        var n = { left: Math.round(Math.max(f.left, (f.left + f.right - el.offsetWidth) / 2)), top: Math.round(f.bottom - el.offsetHeight) };
        setPos(function (o) { return o && o.left === n.left && o.top === n.top ? o : n; });
      }
      placeRef.current = place;
      place();
      window.addEventListener('resize', place);
      return function () { window.removeEventListener('resize', place); };
    }, [askKey]);
    // layout: the page hides HUD columns for this look (sec-look) in a layout effect of the same commit, which runs after this
    // bar's own. A passive effect runs after every layout effect, so the bar is placed again in the view the screen gets.
    useEffect(function () { if (placeRef.current) placeRef.current(); }, [p.layout]);
    useEffect(function () { if (pos) p.onPlaced(); }, [pos]);
    // A screen with no second step (a Security room screen: its cells take the clicks) has the Back button only.
    return h('div', { ref: ref, className: 'look-bar', role: 'group', 'aria-label': 'Screen in view', style: pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' } },
      p.agents ? h(LookCard, { agents: p.agents, onInspect: p.onInspect }) : null,
      h(NeedsButton, { count: askCount(asks), onGo: p.onGo }),
      h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back to the room'),
      p.verb ? h(A.Button, { variant: 'quiet', icon: p.icon, onClick: p.onOpen }, p.verb) : null);
  }

  // ---------- pinned screens (#89): a real DOM layer exactly over the screen in focus ----------
  // The scene host gives the screen's box (host.layer, host.onLayer) every frame it moves, and hides the layer while the
  // camera flies. The page puts the box on its element with setProperty, never a style attribute (the CSP), and renders
  // again only when the screen or its state changes, not on every move.
  var WANT_MS = 5000;   // a wait for a screen to settle (a flight, another building): a deadline in time, not a count of frames
  function px(v) { return Math.round(v * 10) / 10 + 'px'; }
  function putBox(el, r) {
    el.style.setProperty('--pin-x', px(r.left)); el.style.setProperty('--pin-y', px(r.top));
    el.style.setProperty('--pin-w', px(r.width)); el.style.setProperty('--pin-h', px(r.height));
  }
  // A small screen (a phone, a desk monitor seen from afar) gets the compact layout. It is React state, not a class set
  // by hand: a render that changes className would drop a class set from outside.
  function smallBox(r) { return r.width < 520 || r.height < 300; }
  function usePinBox(host, ref, put) {
    var sm = useState(false), small = sm[0], setSmall = sm[1];
    React.useLayoutEffect(function () {
      if (!host) return undefined;
      function at(l) { var el = ref.current; if (el && l && l.rect) { put(el, l.rect); setSmall(smallBox(l.rect)); } }
      at(host.layer());
      return host.onLayer(at);
    }, [host]);
    return small;
  }
  // The count of waiting requests on the bezel of the screen in focus. One tap goes to the oldest request (the page decides
  // where that is). inline: in the head of a pinned screen; else on the top right corner of the screen's frame.
  // compact (a small pinned screen): the icon and the count, with the whole name as the label, so the head keeps one row.
  function Bezel(p) {
    var ref = React.useRef(null);
    // the corner of the screen, kept inside the free part of the view (host.free), compact on a small screen
    var small = usePinBox(p.inline ? null : p.host, ref, function (el, r) {
      var b = window.OfficeSceneHost.pure.bezelAt(r, p.host.free(), 18);
      el.style.setProperty('--pin-x', px(b.x)); el.style.setProperty('--pin-y', px(b.y));
    });
    if (!(p.count > 0)) return null;
    var compact = p.compact || (!p.inline && small);
    return h('div', { ref: ref, className: 'bezel' + (p.inline ? ' is-inline' : ''), hidden: !p.inline && !p.shown },
      h(A.Button, { variant: 'emphasis', icon: 'waiting', label: compact ? 'Needs you · ' + p.count + '. Go to the oldest request' : null, title: 'Go to the oldest request', onClick: p.onGo }, compact ? String(p.count) : 'Needs you · ' + p.count));
  }
  // Focus moves into a pinned screen when it shows, and back to where it was when it goes (the DS Definition of done).
  function usePinFocus(shown, find) {
    var opener = React.useRef(null), entered = React.useRef(false);
    useEffect(function () {
      opener.current = document.activeElement;
      return function () { var o = opener.current; if (o && o.isConnected && o.focus) o.focus({ preventScroll: true }); };
    }, []);
    useEffect(function () {
      if (!shown || entered.current || (window.OfficeBoard && window.OfficeBoard.layerOpen())) return;
      var el = find();
      if (el && el.focus) { entered.current = true; el.focus({ preventScroll: true }); }
    });
  }

  // The chat of the bot at the desk: the DS chat messages (office.chatOf, the same mirror as the HUD chat) and the DS composer.
  var CHAT_QUICK = [['Status', 'What is your status?', 'info'], ['Summarize', 'Summarize your work today.', 'chat']];
  function ChatTab(p) {
    var ms = useState(function () { return p.office && p.office.chatOf ? p.office.chatOf(p.bot) : []; }), msgs = ms[0], setMsgs = ms[1];
    var log = React.useRef(null), stick = React.useRef(true);
    useEffect(function () {
      function read() {
        var l = p.office && p.office.chatOf ? p.office.chatOf(p.bot) : [];
        setMsgs(function (o) { return o.length === l.length && o[o.length - 1] === l[l.length - 1] ? o : l; });
      }
      read();
      var iv = setInterval(read, 400);
      return function () { clearInterval(iv); };
    }, [p.office, p.bot]);
    useEffect(function () { var v = log.current; if (v && stick.current) v.scrollTop = v.scrollHeight; }, [msgs.length]);
    function onScroll() { var v = log.current; if (v) stick.current = v.scrollHeight - v.scrollTop - v.clientHeight < 24; }
    function act(t) { var o = p.office; if (!o) return; if (t === 'approve') o.approve(p.bot); else if (t === 'decline') o.decline(p.bot); else o.send({ type: t, bot: p.bot }); }
    function send(t, att) { if (p.office) { stick.current = true; p.office.message(p.bot, t, att); } }
    return h('div', { className: 'pin-chat' },
      h('div', { className: 'pin-log', ref: log, onScroll: onScroll, role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', tabIndex: 0 },
        msgs.length ? msgs.map(function (m, i) { return h(A.ChatMessage, { key: i, message: m, onAction: act }); })
          : h(A.EmptyState, { compact: true, icon: 'chat', title: 'No messages yet', text: 'Send a message to ' + p.name + '. Try: what is your status?' })),
      h('div', { className: 'pin-input' },
        h('div', { className: 'pin-chips' }, CHAT_QUICK.map(function (q) { return h(A.Button, { key: q[0], variant: 'quiet', icon: q[2], onClick: function () { send(q[1]); } }, q[0]); })),
        h(A.Composer, { id: 'pin-chat-input', placeholder: 'Message ' + p.name, label: 'Message ' + p.name, onSend: send, attach: true })));
  }

  // The desk monitor of one session, pinned (#89): its chat, its terminal and the timeline of its tool calls, Export, Stop turn
  // and Back. The requests are on the desk (the paper and the note, desk.js); the bezel count in the head goes to the oldest one.
  // On a small screen the head takes one row (the bezel shows its icon and count, Stop turn and Export their icon).
  var DESK_TABS = [{ id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'terminal', label: 'Terminal', icon: 'terminal' }, { id: 'timeline', label: 'Timeline', icon: 'trace' }];
  function DeskScreen(p) {
    var snap = useSnapshot(), kinds = useKinds();
    var s = snap ? snap.sessions.filter(function (x) { return x.uid === p.uid; })[0] : null;
    var ref = React.useRef(null);
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && (el.querySelector('#pin-chat-input, .term-field') || el.querySelector('.ao-tab[aria-selected="true"]')); });
    var working = s && (s.status === 'working' || s.status === 'waiting');
    function stop() { api('/api/interrupt', { uid: s.uid }).catch(function (x) { p.toast({ tone: 'error', title: s.name, text: x.message }); }); }
    var tab = p.tab || 'chat';
    // small: the button shows its icon, and its name is its label (and its tooltip)
    function act(icon, text, title, onClick) { return h(A.Button, { variant: 'quiet', icon: icon, label: small ? text : null, title: small ? (title || text) : title, onClick: onClick }, small ? null : text); }
    return h('section', { ref: ref, className: 'pin pin-desk' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Desk screen of ' + p.name },
      h('div', { className: 'pin-head' },
        h(A.StatusDot, { status: s ? statusOf(s) : 'resting' }),
        h('b', { className: 'pin-name' }, p.name),   // the scene's name of the bot (unique in the building), as on its desk
        h('span', { className: 'pin-sub mono' }, s ? window.officeAdapter.kindWord(s) + ' · ' + modelWord(kinds.list, s) : ''),
        h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
        s && s.headless && working ? act('pause', 'Stop turn', null, stop) : null,
        s ? act('copy', 'Export', 'Save this session as a Markdown file', function () { exportSession(s.uid, p.toast); }) : null,
        p.onRules ? act('security', 'Rules', 'Open the Security room: the rules behind this agent', p.onRules) : null,
        h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
      h(A.Tabs, { label: 'Desk screen', tabs: DESK_TABS, value: tab, onChange: p.onTab, render: function (id) {
        if (id === 'chat') return h(ChatTab, { office: p.office, bot: p.bot, name: p.name });
        return h(TermTab, { s: s, name: p.name, toast: p.toast, timeline: id === 'timeline' });
      } }));
  }

  // The changes of a room on its wall screen, pinned (#89). Pull request and worktree removal keep their confirm dialog.
  function ChangesScreen(p) {
    var c = useChanges(p.uid, p.toast);
    var ref = React.useRef(null);
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && el.querySelector('.diff, .pin-body'); });
    return h(React.Fragment, null,
      h('section', { ref: ref, className: 'pin pin-changes' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Changes in ' + (p.name || 'this session') },
        h('div', { className: 'pin-head' },
          h('b', { className: 'pin-name' }, 'Changes in ' + (p.name || 'this session')),
          h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
          changesActions(c, p.ended),
          h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
        h('div', { className: 'pin-body', tabIndex: -1 }, h(ChangesBody, { c: c }))),
      h(ChangesConfirm, { c: c }));
  }

  // The question note of a desk, pinned (#90): the question and a text field over the note in the scene. The answer goes to the
  // agent as its next message (the server gives a pending question the next message, /api/message).
  function NoteScreen(p) {
    var ref = React.useRef(null), tx = useState(''), text = tx[0], setText = tx[1], bz = useState(false), busy = bz[0], setBusy = bz[1];
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && el.querySelector('#pin-note-input'); });
    function send(t) {
      var v = String(t == null ? text : t).trim();
      if (!v || busy) return;
      setBusy(true);
      api('/api/message', { uid: p.note.uid, text: v }).then(function () { setBusy(false); setText(''); p.onBack(); }, function (x) { setBusy(false); p.toast({ tone: 'error', title: p.note.bot, text: x.message }); });
    }
    return h('section', { ref: ref, className: 'pin pin-note' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Question from ' + p.note.bot },
      h('div', { className: 'pin-head' },
        h('b', { className: 'pin-name' }, p.note.bot + ' asks'),
        h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
        h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
      h('div', { className: 'pin-body note-body', tabIndex: -1 },
        h('p', { className: 'note-q' }, p.note.text),
        h('div', { className: 'note-field' }, h(A.Composer, { id: 'pin-note-input', placeholder: 'Type your answer', label: 'Answer to ' + p.note.bot, onSend: send })),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { send('Yes.'); } }, 'Answer yes'),
          h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { send('No.'); } }, 'Answer no'))));
  }

  // ---------- one session as a full terminal (the Terminal and Timeline tabs of the desk screen) ----------
  function TermTab(p) {
    var s = p.s;
    var vw = React.useRef(null), stick = React.useRef(true), probe = React.useRef(null);
    var cl = useState(60), cols = cl[0], setCols = cl[1];
    var tx = useState(''), text = tx[0], setText = tx[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    useEffect(function () {
      function measure() {
        var v = vw.current, pr = probe.current;
        if (!v || !pr) return;
        var pw = pr.getBoundingClientRect().width;
        if (!pw) return;
        var cs = getComputedStyle(v), cw = pw / 10, inner = v.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        if (cw > 0 && inner > 0) setCols(function (c) { var n = Math.max(20, Math.floor(inner / cw)); return n === c ? c : n; });
      }
      measure();
      var ro = window.ResizeObserver ? new ResizeObserver(measure) : null;
      if (ro && vw.current) ro.observe(vw.current);
      window.addEventListener('resize', measure);
      // a theme change or a font swap changes the character width but not the box
      var mo = new MutationObserver(measure);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      var fonts = document.fonts;
      if (fonts && fonts.addEventListener) fonts.addEventListener('loadingdone', measure);
      return function () {
        if (ro) ro.disconnect(); mo.disconnect();
        window.removeEventListener('resize', measure);
        if (fonts && fonts.removeEventListener) fonts.removeEventListener('loadingdone', measure);
      };
    }, []);
    // The Timeline tab lists the tool calls with their times (#72); Export (in the head) saves the whole session as Markdown.
    var showTimeline = !!p.timeline;
    var OT = window.OfficeTerminal;
    var rows = OT ? (showTimeline ? OT.timeline(s, cols) : OT.lines(s, cols)) : [{ text: 'The terminal view is not loaded.', tone: 'muted' }];
    if (!showTimeline && s && s.headless && rows.length && rows[rows.length - 1].text === '> ') rows = rows.slice(0, -1);
    useEffect(function () { var v = vw.current; if (v && stick.current) v.scrollTop = v.scrollHeight; });
    function onScroll() { var v = vw.current; if (v) stick.current = v.scrollHeight - v.scrollTop - v.clientHeight < 24; }
    function send() {
      var t = text.trim();
      if (!t || !s || busy) return;
      setBusy(true);
      api('/api/message', { uid: s.uid, text: t }).then(function () { setBusy(false); setText(''); stick.current = true; }, function (x) { setBusy(false); p.toast({ tone: 'error', title: s.name, text: x.message }); });
    }
    var ended = !s || s.status === 'ended';
    return h('div', { className: 'pin-term' },
      h('div', { className: 'term-view', ref: vw, onScroll: onScroll, role: 'log', 'aria-live': 'off', 'aria-label': showTimeline ? 'Timeline' : 'Terminal', tabIndex: 0 },
        h('span', { className: 'term-probe', ref: probe, 'aria-hidden': 'true' }, 'MMMMMMMMMM'),
        rows.map(function (r, i) { return h('div', { key: i, className: 'term-line tone-' + r.tone + (r.ask ? ' is-ask' : '') }, r.text || '\u00a0'); })),
      showTimeline ? null : s && s.headless && !ended
        ? h('div', { className: 'term-input pin-input' },
            h('span', { className: 'term-caret mono', 'aria-hidden': 'true' }, '>'),
            h('input', { className: 'term-field', type: 'text', value: text, placeholder: 'Message ' + s.name, 'aria-label': 'Message ' + s.name, autoComplete: 'off', spellCheck: false,
              onChange: function (e) { setText(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } } }))
        : s && !s.headless && !ended ? h('p', { className: 'term-note' }, 'This session runs in its own terminal window. Type there, or use the Chat tab.') : null);
  }

  // ---------- page commands in the DS command palette (Ctrl+K) ----------
  // The HUD builds its palette list with AgentOffice.CommandPalette.actions(); the page adds its own.
  var pageActions = [];   // set by App in an effect: a function that builds the list when the palette draws it
  (function () {
    var base = A.CommandPalette && A.CommandPalette.actions;
    if (!base || base.__page) return;
    var wrapped = function (o) { return base(o).concat(typeof pageActions === 'function' ? pageActions() : pageActions); };
    wrapped.__page = true;
    A.CommandPalette.actions = wrapped;
  })();

  // The scene's own name of a session (unique per building), else its plain name.
  function sceneName(s) { return window.officeAdapter.botName(s.uid) || s.name; }

  // ---------- paper flow (#93): Ready to merge, the pipeline board and the PR cards ----------
  // The server reads `gh` (read-only); building.js changes() turns it into folders. Merge is the one write and asks first: the first
  // call is 409 with confirm: 'merge' and the question, and the Merge dialog sends the same call again with confirmed: true.
  function useMerge(toast) {
    var st = useState(null), ask = st[0], setAsk = st[1], bz = useState(''), busy = bz[0], setBusy = bz[1], er = useState(''), err = er[0], setErr = er[1];
    function send(r, confirmed) {
      setBusy(r.id || ('pr:' + r.number)); setErr('');
      return api('/api/merge', { repo: r.repo, number: r.number, confirmed: confirmed === true }).then(function () {
        setBusy(''); setAsk(null); toast({ tone: 'success', title: 'Merged #' + r.number, text: r.title || '' });
      }, function (x) {
        setBusy('');
        if (x.body && x.body.confirm === 'merge' && !confirmed) { setAsk({ r: r, text: x.message }); return; }
        if (confirmed) setErr(x.message); else { setAsk(null); toast({ tone: 'error', title: 'Merge #' + r.number, text: x.message }); }
      });
    }
    var node = ask ? h(A.Dialog, { open: true, title: 'Merge #' + ask.r.number, onClose: function () { setAsk(null); setErr(''); }, actions: [
      h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); setErr(''); } }, 'Cancel'),
      h(A.Button, { key: 'm', variant: 'primary', icon: 'merge', loading: !!busy, onClick: function () { send(ask.r, true); } }, 'Merge it')] },
      h('div', { className: 'form' }, h('p', { className: 'note' }, ask.text), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null)) : null;
    return { start: function (r) { send(r, false); }, busy: busy, node: node };
  }
  // A decision summary: the key point first, the recommendation, the reason, a link to the review finding (the change page).
  function MergeRow(p) {
    var r = p.r;
    return h('li', { className: 'past-row' },
      h('div', { className: 'past-main' },
        h('div', { className: 'past-title' }, h(A.Icon, { name: 'merge', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName)),
        h('div', { className: 'past-snip' }, h('em', null, 'Recommended: '), r.recommendation + '. ' + r.reason),
        r.url ? h('div', { className: 'past-sub mono' }, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Review finding on #' + r.number)) : null),
      h('div', { className: 'past-actions' },
        h(A.Button, { variant: 'emphasis', icon: 'merge', disabled: !!p.busy, onClick: function () { p.onMerge(r); } }, 'Merge')));
  }
  // The pipeline board: every change by stage (Intake, Build, Check, Review, Gate, Merge, Release, Record); a stage with no data says unknown.
  // Each change is a PR card: glyph, number and title, branch to base, the state in words, checks, reviewer, diff size, Merge when ready.
  function FlowDialog(p) {
    var snap = useSnapshot(), M = useMerge(p.toast), now = Date.now();
    var repos = snap ? snap.repos || [] : [];
    return h(A.Dialog, { open: true, title: 'Changes', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide flow' },
        !repos.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a repository to see its changes.' }) : null,
        repos.map(function (r) {
          var c = window.OfficeBuilding.changes(snap, r.key, now), open = c.folders.filter(function (f) { return f.state !== 'merged' && f.state !== 'closed'; });
          return h('section', { key: r.key, className: 'flow-b', 'aria-label': r.name },
            h('div', { className: 'past-title' }, h(A.Icon, { name: 'building', size: 16 }), h('b', null, r.name), c.unknown ? h(Tag, null, c.line) : h(Tag, null, c.mergedToday + ' merged today')),
            h('ol', { className: 'flow-stages', 'aria-label': 'Pipeline of ' + r.name }, c.pipeline.map(function (st) {
              return h('li', { key: st.id, className: 'flow-stage' + (st.unknown ? ' is-unknown' : ''), 'aria-label': st.name + ': ' + (st.unknown ? 'unknown' : plural(st.count, 'change', 'changes')) },
                h('span', { className: 'flow-n mono' }, st.unknown ? 'unknown' : String(st.count)), h('span', { className: 'flow-w' }, st.name));
            })),
            !c.unknown && !open.length ? h('p', { className: 'note' }, 'No open changes.') : null,
            h('ul', { className: 'past' }, open.map(function (f) {
              var ck = f.checks || { total: 0, passed: 0 };
              return h('li', { key: f.number, className: 'past-row flow-card' },
                h('div', { className: 'past-main' },
                  h('div', { className: 'past-title' }, h(A.Icon, { name: f.glyph, size: 16 }), h('b', null, '#' + f.number + ' ' + f.title)),
                  h('div', { className: 'past-sub mono' }, f.head + ' to ' + (f.base || 'main')),
                  h('div', { className: 'past-meta mono' }, [f.word, ck.total ? ck.passed + ' of ' + plural(ck.total, 'check', 'checks') + ' passed' : 'no checks', f.reviewer ? 'reviewer ' + f.reviewer : 'no reviewer', '+' + f.diff.additions + ' -' + f.diff.deletions + ' in ' + plural(f.diff.files, 'file', 'files')].join(' · '))),
                f.state === 'ready' ? h('div', { className: 'past-actions' }, h(A.Button, { variant: 'emphasis', icon: 'merge', disabled: !!M.busy, onClick: function () { M.start({ repo: r.key, number: f.number, title: f.title }); } }, 'Merge')) : null);
            })));
        }),
        M.node));
  }

  // ---------- Needs you: every open request and question of every building ----------
  function NeedsDialog(p) {
    var snap = useSnapshot();
    var list = snap ? window.officeAdapter.requests(snap) : [];
    var bz = useState(''), busy = bz[0], setBusy = bz[1], box = React.useRef(null), lastIdx = React.useRef(0), M = useMerge(p.toast);
    // After an answer the row goes. Keep the focus inside the dialog, on the row that took its place.
    useEffect(function () { refocusRow(box.current, lastIdx.current); }, [list.map(function (r) { return r.id; }).join('|')]);
    function answer(r, allow) {
      lastIdx.current = list.indexOf(r);
      setBusy(r.id);
      api('/api/answer', { id: r.id, allow: allow }).then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: r.bot, text: x.message }); });
    }
    return h(A.Dialog, { open: true, title: 'Needs you', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        list.length ? h('p', { className: 'note' }, plural(list.length, 'request waits', 'requests wait') + ' for you, oldest first. This is every building.') : null,
        !list.length ? h(A.EmptyState, { icon: 'finished', compact: true, title: 'Nothing needs you', text: 'New requests show here when an agent asks.' }) : null,
        h('div', { ref: box }, h('ul', { className: 'past' }, list.map(function (r) {
          if (r.kind === 'merge') return h(MergeRow, { key: r.id, r: r, busy: M.busy, onMerge: function (x) { M.start(x); } });
          var q = r.kind === 'question';
          return h('li', { key: r.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, sceneName({ uid: r.uid, name: r.bot })), h(Tag, null, r.buildingName), q ? null : h(A.RiskBadge, { risk: r.risk })),
              h('div', { className: 'past-snip' }, r.text),
              r.reason ? h('div', { className: 'past-snip' }, h('em', null, 'reason: '), r.reason) : null,
              !q && r.preview && r.preview !== r.detail ? h('div', { className: 'past-sub mono', title: r.preview }, clip(String(r.preview).replace(/\s+/g, ' '), 140)) : null,
              h('div', { className: 'past-meta mono' }, r.roomName + ' · ' + ago(r.t))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'emphasis', icon: 'approve', disabled: busy === r.id, onClick: function () { answer(r, true); } }, q ? 'Yes' : 'Approve'),
              h(A.Button, { variant: 'quiet', icon: 'decline', disabled: busy === r.id, onClick: function () { answer(r, false); } }, q ? 'No' : 'Decline'),
              h(A.Button, { variant: 'ghost', icon: 'chevron-right', onClick: function () { p.onGo(r); } }, 'Go to')));
        }))), M.node));
  }

  // the DS palette listens for Ctrl+K on the document, so a button sends the same key
  function openPalette() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); }

  // ---------- the Reception (#92): the archetype memo, the floors, the office's actions, the tour ----------
  // The reception memo and the directory board in the lobby open it, and so does Ctrl+K. Each floor change is one call
  // (POST /api/layout). A rename shows in place; a switch, an added, hidden or moved floor builds the scene again.
  function aName(n) { return (/^[AEIOU]/.test(String(n)) ? 'an ' : 'a ') + n; }
  function ReceptionDialog(p) {
    var snap = useSnapshot();
    var lay = snap && snap.layouts && snap.layouts[p.repo], cat = (snap && snap.catalog) || { functions: [], archetypes: [] };
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var nm = useState({}), names = nm[0], setNames = nm[1];
    var ar = useState(''), arch = ar[0], setArch = ar[1];
    var ad = useState(''), add = ad[0], setAdd = ad[1];
    function change(body, done) {
      var key = body.action + ':' + (body.floor || body.archetype || '');
      setBusy(key); setErr('');
      api('/api/layout', Object.assign({ building: p.repo }, body)).then(function () { setBusy(''); if (done) done(); }, function (x) { setBusy(''); setErr(x.message); });
    }
    if (!lay) return h(A.Dialog, { open: true, title: 'Reception', onClose: p.onClose, actions: [h(A.Button, { key: 'c', variant: 'quiet', onClick: p.onClose }, 'Close')] },
      h(A.EmptyState, { icon: 'building', compact: true, title: 'No floors yet', text: 'The office has not read this building yet. Open a session in it first.' }));
    var shown = lay.floors.filter(function (f) { return !f.hidden; });
    var archOpts = cat.archetypes.map(function (a) { return { value: a.id, label: a.name }; });
    var pick = arch || lay.archetype;
    var addOpts = [{ value: '', label: 'Choose a floor' }].concat(cat.functions.filter(function (f) { return !shown.some(function (x) { return x.id === f.id; }); })
      .map(function (f) { return { value: f.id, label: f.name + ' · ' + f.wingName }; }));
    var fnFloors = lay.floors.filter(function (f) { return !f.fixed; });
    return h(A.Dialog, {
      open: true, title: 'Reception', onClose: p.onClose,
      actions: [h(A.Button, { key: 't', variant: 'quiet', icon: 'chevron-right', onClick: function () { p.onClose(); p.onTour(); } }, 'Replay the tour'),
        h(A.Button, { key: 'c', variant: 'primary', onClick: p.onClose }, 'Close')]
    }, h('div', { className: 'form reception' },
      h('h3', { className: 'reception-h' }, 'Memo'),
      lay.confirmed
        ? h('p', { className: 'note' }, 'This building is ' + aName(lay.archetypeName) + '. Its floors: ' + shown.map(function (f) { return f.name; }).join(', ') + '.')
        : h('p', { className: 'note' }, 'The office thinks this building is ' + aName(lay.proposedName) + '. ' + lay.why + ' Confirm it once, or pick another kind.'),
      lay.confirmed ? null : h('div', { className: 'inline-actions' },
        h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === 'confirm:', onClick: function () { change({ action: 'confirm' }); } }, 'Confirm ' + lay.proposedName)),
      h('div', { className: 'reception-floor' },
        h(A.Select, { id: 'r-arch', label: 'Kind of building', options: archOpts, value: pick, onChange: setArch }),
        h(A.Button, { variant: 'quiet', disabled: pick === lay.archetype && lay.confirmed, loading: busy === 'switch:' + pick, onClick: function () { change({ action: 'switch', archetype: pick }); } }, 'Use these floors')),
      h('p', { className: 'note' }, 'A new kind of building sets its floors. Rooms and notes stay. The scene is built again.'),
      h('h3', { className: 'reception-h' }, 'Floors'),
      err ? h('p', { className: 'note reception-err', role: 'alert' }, err) : null,
      h('ul', { className: 'reception-floors' }, lay.floors.slice().reverse().map(function (f) {
        var v = names[f.id] != null ? names[f.id] : f.name, i = fnFloors.indexOf(f);
        return h('li', { key: f.id, className: 'reception-floor' + (f.hidden ? ' is-hidden' : '') },
          h(A.TextInput, { id: 'r-n-' + f.id, label: (f.wingName ? f.wingName + ' wing' : 'Ground floor') + (f.hidden ? ' · hidden' : ''), value: v, onChange: function (t) { var n = Object.assign({}, names); n[f.id] = t; setNames(n); } }),
          h('div', { className: 'inline-actions' },
            h(A.Button, { variant: 'quiet', disabled: v.trim() === f.name, loading: busy === 'rename:' + f.id, onClick: function () { change({ action: 'rename', floor: f.id, name: v }, function () { var n = Object.assign({}, names); delete n[f.id]; setNames(n); }); } }, 'Rename'),
            f.fixed ? null : h(A.Button, { variant: 'quiet', disabled: i >= fnFloors.length - 1, onClick: function () { change({ action: 'move', floor: f.id, by: 1 }); } }, 'Move up'),
            f.fixed ? null : h(A.Button, { variant: 'quiet', disabled: i <= 0, onClick: function () { change({ action: 'move', floor: f.id, by: -1 }); } }, 'Move down'),
            f.id === 'lobby' ? null : h(A.Button, { variant: 'quiet', onClick: function () { change({ action: f.hidden ? 'show' : 'hide', floor: f.id }); } }, f.hidden ? 'Show' : 'Hide')));
      })),
      h('div', { className: 'reception-floor' },
        h(A.Select, { id: 'r-add', label: 'Add a floor', options: addOpts, value: add, onChange: setAdd }),
        h(A.Button, { variant: 'quiet', icon: 'add', disabled: !add, loading: busy === 'add:' + add, onClick: function () { change({ action: 'add', floor: add }, function () { setAdd(''); }); } }, 'Add floor')),
      h('h3', { className: 'reception-h' }, 'Office'),
      h('div', { className: 'reception-actions' }, p.actions.map(function (x) {
        return h(A.Button, { key: x.id, variant: 'quiet', icon: x.icon, onClick: function () { p.onClose(); x.run(); } }, x.label);
      }))));
  }

  // The lobby tour: four stops (lobby.js tourSteps). It shows once per browser and replays from the Reception. Each stop flies
  // the camera (lobby.js tour) where it can; the elevator stop marks the elevator panel. One button ends it: Skip the tour on the
  // first stops, Done on the last (#92 review: the last stop had Close and Done, two buttons for one result).
  function TourCard(p) {
    var steps = window.OfficeLobby ? window.OfficeLobby.pure.tourSteps() : [];
    var ix = useState(0), i = ix[0], setI = ix[1];
    var step = steps[i];
    useEffect(function () { if (step) p.onStep(step.key); }, [i]);
    if (!step) return null;
    var last = i === steps.length - 1;
    return h('div', { className: 'tour-card', role: 'dialog', 'aria-label': 'Lobby tour', 'aria-live': 'polite' },
      h('div', { className: 'tour-h' }, h('b', null, step.title), h('span', { className: 'mono tour-n' }, (i + 1) + ' of ' + steps.length)),
      h('p', { className: 'note' }, step.text),
      h('div', { className: 'inline-actions' },
        last ? null : h(A.Button, { variant: 'quiet', onClick: p.onDone }, 'Skip the tour'),
        i > 0 ? h(A.Button, { variant: 'quiet', onClick: function () { setI(i - 1); } }, 'Back') : null,
        last ? h(A.Button, { variant: 'primary', onClick: p.onDone }, 'Done') : h(A.Button, { variant: 'primary', icon: 'chevron-right', onClick: function () { setI(i + 1); } }, 'Next')));
  }
  function tourSeen() { try { return localStorage.getItem('ao-tour') === '1'; } catch (x) { return false; } }
  function setTourSeen() { try { localStorage.setItem('ao-tour', '1'); } catch (x) { /* private window */ } }

  // ---------- app ----------
  function winSize() { return { w: window.innerWidth, h: window.innerHeight }; }
  function App() {
    var sel = useChatBot();
    // The Decisions inbox: open or closed. The page owns the state (OfficeScene inbox, onInbox), so it can close it.
    // The state is kept with the key of its scene (ibKey, set where sceneKey is known), so a new scene starts
    // with the inbox closed in its first render, as the DS does when it keeps the state itself.
    var ib = useState({ key: null, open: false }), ibKey = React.useRef(null);
    var setInbox = React.useCallback(function (v) { ib[1]({ key: ibKey.current, open: !!v }); }, []);
    var s2 = useState(null), dlg = s2[0], setDlg = s2[1];
    var s3 = useState({ recent: [], templates: [], schedules: [] }), info = s3[0], setInfo = s3[1];
    var ws = useState(winSize), win = ws[0], setWin = ws[1];   // the window size: the scene height follows it (#55)
    // The DS Since you left card shows (OfficeScene onSinceYouLeft, #66).
    var sy = useState(false), syl = sy[0], setSyl = sy[1];
    // Toasts (toasts.js): an error or a toast with an action stays until closed; the others close after 8 s, and wait while the pointer or focus is on them, or while the stack has no room (is-off).
    var tt = useState([]), toasts = tt[0], setToasts = tt[1], tid = React.useRef(0), toastBox = React.useRef(null);
    function toast(t) {
      var id = ++tid.current;
      if (t.action) {   // a click on the action closes its toast
        var act = t.action;
        t = Object.assign({}, t, { action: { label: act.label, onClick: function () { setToasts(function (l) { return window.OfficeToasts.remove(l, id); }); act.onClick(); } } });
      }
      setToasts(function (l) { return window.OfficeToasts.add(l, t, id, Date.now()); });
      return id;
    }
    // No access (no launch code, a used one, or a server restart): one error toast that stays until access is back.
    useEffect(function () {
      var shown = null;
      return window.officeAdapter.onAuth(function (a) {
        var old = shown;
        if (old) setToasts(function (l) { return window.OfficeToasts.remove(l, old); });
        shown = a.ok ? null : toast({ tone: 'error', title: 'No access to the office', text: a.reason });
      });
    }, []);
    // Older replies that did not load (#80): the chat of that bot shows the newest ones. An error toast stays until closed.
    useEffect(function () {
      return window.officeAdapter.onProblem(function (text) { toast({ tone: 'error', title: 'Older replies', text: text }); });
    }, []);
    var timed = window.OfficeToasts.hasTimed(toasts);
    useEffect(function () {
      if (!timed) return undefined;
      // While the pointer or focus is on the stack, state does not change: the time held is added when it ends.
      var last = Date.now(), held = 0;
      var iv = setInterval(function () {
        var now = Date.now(), dt = now - last; last = now;
        var el = toastBox.current, paused = !!el && (el.matches(':hover') || el.contains(document.activeElement) || el.classList.contains('is-off'));
        if (paused) { held += dt; return; }
        var h0 = held; held = 0;
        setToasts(function (l) { if (h0) l = window.OfficeToasts.tick(l, now, now - h0, true); return window.OfficeToasts.tick(l, now, now, false); });
      }, 250);
      return function () { clearInterval(iv); };
    }, [timed]);
    // Where the stack stands, at every width and window height (#79): toasts.js place decides from the boxes measured here.
    // KEEP: never covered: the top controls, the elevator panel, the zoom column, the lobby tour, every request
    // bar (Approve, Decline), message box and Back button of a panel, a pinned screen or the chat, the bezel count, the
    // decisions inbox, the city controls.
    // AVOID: covered only when no band is free of them: the DS HUD boxes (chat, roster, room card, Since you left), the
    // pinned screens, the board, stats and notes panels, the welcome card. A new box goes in one of the two lists.
    // It measures again when a box appears, goes or changes size (ResizeObserver), when a toast comes or goes, when
    // --strip-clear changes, on resize, and when a box scrolls. With no free band the stack waits out of sight (is-off) and its clocks wait.
    var KEEP = '.ao-hud-top, .ao-hud-left, .ao-hud-zoom, .ao-hud-inbox, .ao-hud-cast, .tour-card, .needs-go, .pin-head, .pin .ao-tablist, .pin-input, .term-input, .term-note, .bezel, .board-b > .inline-actions, .look-bar, .city-hud, .city-zoom, .ao-hud-chat .ao-chat-h, .ao-hud-chat .ao-tablist, .ao-hud-chat .ao-act, .ao-hud-chat .ao-chips, .ao-hud-chat .ao-composer';
    var AVOID = '.ao-hud > *, .board-panel, .pin, .notes-edit, .welcome';
    var placeRef = React.useRef(null);
    useEffect(function () {
      var wait = 0, trail = 0, ro = null, watched = new Set();
      function seen(b) {   // the part of a box the user can see: not display none, not visibility hidden (a panel hides the DS column that way), cut by every scrolling or clipping parent
        var cs = getComputedStyle(b);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        var r = b.getBoundingClientRect(), o = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (var p = b.parentElement; p && p !== document.body; p = p.parentElement) {
          var ps = getComputedStyle(p);
          if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
          var q = p.getBoundingClientRect();
          o = { left: Math.max(o.left, q.left), top: Math.max(o.top, q.top), right: Math.min(o.right, q.right), bottom: Math.min(o.bottom, q.bottom) };
        }
        return o.right > o.left && o.bottom > o.top ? o : null;
      }
      function rects(sel, els) {
        var out = [];
        document.querySelectorAll(sel).forEach(function (b) { var r = seen(b); if (r) { out.push(r); els.push(b); } });
        return out;
      }
      function watch(els) {   // the observer follows the measured boxes and the stack
        if (!ro) return;
        var now = new Set(els);
        now.forEach(function (e) { if (!watched.has(e)) ro.observe(e); });
        watched.forEach(function (e) { if (!now.has(e)) ro.unobserve(e); });
        watched = now;
      }
      function set(el, k, v) { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); }   // the same value writes nothing: no loop with the observers
      function place() {
        wait = 0;
        var el = toastBox.current;
        if (!el) return;
        var cs = getComputedStyle(el), strip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--strip-clear'));
        var vw = document.documentElement.clientWidth, vh = window.innerHeight, els = [el];
        var keep = rects(KEEP, els), avoid = rects(AVOID, els);
        watch(els);
        var home = { x: parseFloat(cs.getPropertyValue('--toast-home')) || 16, y: isFinite(strip) ? vh - strip : vh };
        var p = window.OfficeToasts.place({ w: vw, h: vh }, { w: el.getBoundingClientRect().width }, home, keep, avoid);
        el.classList.toggle('is-off', !!p.hidden);
        if (p.hidden) return;
        set(el, '--toast-x', p.x + 'px'); set(el, '--toast-bottom', p.bottom + 'px'); set(el, '--toast-room', p.maxH + 'px');
      }
      function soon() {   // at most every 120 ms, and once more after a panel animation has ended
        if (!wait) wait = setTimeout(place, 120);
        clearTimeout(trail); trail = setTimeout(place, 500);
      }
      placeRef.current = place;
      if (window.ResizeObserver) ro = new ResizeObserver(soon);
      var mo = new MutationObserver(soon);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });   // --strip-clear
      window.addEventListener('resize', soon);
      document.addEventListener('scroll', soon, true);   // a scrolled chat log or panel moves its request bars
      place();
      return function () { placeRef.current = null; mo.disconnect(); if (ro) ro.disconnect(); window.removeEventListener('resize', soon); document.removeEventListener('scroll', soon, true); clearTimeout(wait); clearTimeout(trail); };
    }, []);
    // a new or closed toast is placed before it paints, not up to 120 ms later
    React.useLayoutEffect(function () { if (placeRef.current) placeRef.current(); }, [toasts]);
    function refresh() { return getInfo(shownPath).then(function (i) { setInfo(i); return i; }, function () { return info; }); }
    function show(name) { refresh().then(function () { setDlg({ name: name }); }); }
    // The changes of a session with no room in the scene on screen (a past session, another building): the dialog.
    function changesDialog(uid, name) {
      var s = window.officeAdapter.sessionByUid(uid);
      setDlg({ name: 'changes', uid: uid, label: name, ended: !s || s.status === 'ended' });
    }
    // The changes of a session: on the wall screen of its room (#89), the room's floor first. The board flies there when the
    // floor shows its decor; until then this tries again each frame (at most 5 s), and the dialog takes over after that.
    var chgWant = React.useRef(null);
    function changes(uid, name) {
      var s = window.officeAdapter.sessionByUid(uid), o = officeRef.current, host = hostRef.current, b = boardRef.current;
      var roomId = s && s.place && s.place.roomId;
      var here = !!(s && roomId && o && host && b && mount && cur2.view === 'office' && window.officeAdapter.buildingOf(s) === mount.repo);
      var fl = here && o.getBuilding ? (o.getBuilding().floors || []).filter(function (f) { return (f.rooms || []).some(function (r) { return r.id === roomId; }); })[0] : null;
      if (!fl) { changesDialog(uid, name); return; }
      setDlg(null);
      if (host.floorId() !== fl.id) { host.blur(); o.setFloor(fl.id); }
      setChg({ uid: uid, name: name, roomId: roomId, ended: s.status === 'ended' });   // after the blur: its focus event clears chg
      chgWant.current = { roomId: roomId, uid: uid, name: name, until: Date.now() + WANT_MS, host: host };
      requestAnimationFrame(wantChanges);
    }
    function wantChanges() {
      var w = chgWant.current, host = hostRef.current, b = boardRef.current;
      if (!w) return;
      if (host !== w.host) { chgWant.current = null; return; }   // the scene went: nothing to fly to
      if (host && b && host.settled() && b.open(w.roomId, 'changes')) { chgWant.current = null; return; }
      if (Date.now() > w.until) { chgWant.current = null; setChg(null); changesDialog(w.uid, w.name); return; }
      requestAnimationFrame(wantChanges);
    }
    // Which building (repository) the scene shows. The choice is kept in the browser.
    var snap = useSnapshot();
    var cs = useState(function () { try { return localStorage.getItem('ao-building'); } catch (x) { return null; } }), cur = cs[0], setCur = cs[1];
    function pick(key) { setCur(key); try { localStorage.setItem('ao-building', key); } catch (x) { /* private window */ } }
    var list = snap ? window.officeAdapter.buildings(snap) : [];
    var needs = snap ? window.officeAdapter.requests(snap) : [];   // every open request of every building (Needs you)
    var hasCur = list.some(function (b) { return b.key === cur; });
    // Show the chosen building while it has sessions; when it empties, go where the work is.
    var shown = hasCur || (!list.length && cur != null) ? cur : (list.length ? list[0].key : '');
    // Compact view: the DS ambient bar, for a second screen. ?ambient=1 starts in it.
    var am = useState(function () { return /[?&]ambient=1\b/.test(location.search); }), ambient = am[0], setAmbient = am[1];
    var wantKey = shown + (ambient ? ':ambient' : '');
    // City or office. The office is the default; the choice is kept in the browser.
    var vw = useState(function () { try { return localStorage.getItem('ao-view') === 'city' ? 'city' : 'office'; } catch (x) { return 'office'; } }), view = vw[0], setView = vw[1];
    // Smooth changes: the shown scene fades out, then the next one mounts and fades in.
    // cur2.mount is the building adapter of the scene on screen (null in the city, or before the first snapshot).
    // A scene gets a new one when the building changes, and when the adapter says it is stale: the DS has no
    // event that removes a floor or a room, so a removal mounts the building again.
    var fd = useState({ key: wantKey, repo: shown, view: view, mount: null, floor: null }), cur2 = fd[0], setCur2 = fd[1];
    var floorMem = React.useRef(null), offFloor = React.useRef(null);
    var visitRef = React.useRef(null);   // the place and deepest layer of the screen visit in progress (noteLayer)
    if (!floorMem.current) floorMem.current = window.OfficeBuilding.floorMemory();   // the floors of the page: which one a scene opens on, and the user's last pick, per building (#111)
    var stale = !!snap && !!cur2.mount && cur2.mount.stale();
    var needsMount = !!snap && view === 'office' && !cur2.mount && cur2.view === 'office';
    var mount = cur2.mount, def = mount ? mount.def : null;
    var sceneKey = mount ? 'm' + mount.id : cur2.key;
    ibKey.current = sceneKey;
    var inbox = ib[0].open && ib[0].key === sceneKey;
    var fading = cur2.key !== wantKey || cur2.view !== view || stale || needsMount;
    useEffect(function () {
      if (!fading) return undefined;
      var t = setTimeout(function () {
        var snapNow = window.officeAdapter.latest();
        var next = view === 'office' && snapNow ? window.officeAdapter.mount(shown) : null;
        // The floor on screen in the scene we leave (a rebuild, another building, the city). Floor ids are new for each
        // mount, so every match is by floor key. All rules of the choice are in OfficeBuilding.floorMemory (#85, #111).
        var was = null;
        if (cur2.mount && cur2.view === 'office' && hostRef.current) {
          try { was = cur2.mount.floorKey(hostRef.current.floorId()); } catch (x) { was = null; }
          floorMem.current.see(cur2.repo, was);
        }
        if (offFloor.current) { offFloor.current(); offFloor.current = null; }
        // The new scene opens on the floor the memory names, always: the page never lets the DS pick its default floor.
        var start = null;
        if (next) { try { start = floorMem.current.start(next, snapNow, cur2.repo === shown ? was : null); } catch (x) { start = null; } }
        var floor = start ? start.id : null;
        setCur2({ key: wantKey, repo: shown, view: view, mount: next, floor: floor });
      }, reduced() ? 0 : cssMs('duration-base', 240));
      return function () { clearTimeout(t); };
    }, [wantKey, view, stale, needsMount, sceneKey]);
    var introNext = React.useRef(true);
    var intro = useMemo(function () { var i = introNext.current; if (def) introNext.current = false; return i && !ambient; }, [def]);
    function go(v) { setView(v); try { localStorage.setItem('ao-view', v); } catch (x) { /* private window */ } }
    // From the city: fly to the building, then enter it with the DS intro flythrough.
    function enter(key, city, uid) {   // uid: the session to select once inside (no intro then, as in goTo)
      var inside = function () { if (uid) pendingSel.current = uid; introNext.current = !uid; pick(key); go('office'); };
      if (city) city.focus(key, inside); else inside();
    }
    var week = snap && snap.plan && snap.plan.week;
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-plan', !!week); }, [!!week]);
    var officeRef = React.useRef(null);
    // the room board the camera faces, if any (board.js)
    var boardRef = React.useRef(null);
    var bs = useState(null), board = bs[0], setBoard = bs[1];
    var latestSnap = React.useRef(null); latestSnap.current = snap;
    // the desk monitors (terminal.js): each is a pinned screen with the chat and the terminal of its session
    var terminalRef = React.useRef(null);
    // the scene host (scene-host.js): the one reader of the DS stage; board, terminal, streets and birds are its adapters
    var hostRef = React.useRef(null);
    // the Security room's wall screens (security.js): the user picks the permission rules on them
    var securityRef = React.useRef(null);
    useEffect(function () { if (securityRef.current) securityRef.current.refresh(); }, [snap]);
    // the lobby and the desks (lobby.js): open desks, the reception memo, the directory board, the nameplates (#92)
    var lobbyRef = React.useRef(null);
    useEffect(function () { if (lobbyRef.current) lobbyRef.current.refresh(); }, [snap]);
    var deskRef = React.useRef(null);   // the desk objects: approval papers, question notes, pause keys (desk.js, #90)
    useEffect(function () { if (deskRef.current) deskRef.current.refresh(); }, [snap]);
    // the screen the camera looks at (step 1 of a screen: scene-host.js focus), or null
    var lk = useState(null), look = lk[0], setLook = lk[1];
    // The pinned layer of the screen in focus (scene-host.js layer, #89): its screen, state and waiting count, not its box
    // (the screens put the box on themselves). deskTab: the tab of the desk screen. chg: the session whose changes the wall shows.
    var ly = useState(null), layer = ly[0], setLayer = ly[1];
    var dt = useState('chat'), deskTab = dt[0], setDeskTab = dt[1];
    var cg = useState(null), chg = cg[0], setChg = cg[1];
    var needsRef = React.useRef(0); needsRef.current = needs.length;
    function blurScene() { if (hostRef.current) hostRef.current.blur(); }   // fly back from a screen; nothing when none is in focus
    function closeBoard() { blurScene(); setBoard(null); }
    // The desk screen of a session (the dock, Ctrl+K, the bezel count): the scene goes to its building and floor, then
    // the camera flies to its monitor. It tries again each frame (at most 5 s) until the desk is on screen.
    var deskWant = React.useRef(null);
    function openDesk(uid, tab) {
      var s = window.officeAdapter.sessionByUid(uid);
      if (!s) return;
      setDeskTab(tab || 'chat'); setBoard(null);
      var nm = window.officeAdapter.botName(uid), o = officeRef.current;
      if (cur2.view !== 'office' || window.officeAdapter.buildingOf(s) !== shown || !o || !nm) goTo(s);
      else o.select(nm);   // its floor, and the dock's actions for it
      deskWant.current = { uid: uid, until: Date.now() + WANT_MS };
      requestAnimationFrame(wantDesk);
    }
    function wantDesk() {
      var w = deskWant.current, t = terminalRef.current, host = hostRef.current;
      if (!w) return;
      var f = host && host.focused();
      if (f && f.kind === 'terminal' && f.item && f.item.uid === w.uid) { deskWant.current = null; return; }
      if (t && host && host.settled() && t.open(w.uid)) { deskWant.current = null; return; }
      if (Date.now() > w.until) {
        deskWant.current = null;
        var s = window.officeAdapter.sessionByUid(w.uid);
        toast({ tone: 'info', title: s ? s.name : 'Desk', text: 'The desk of this session is not on screen.' });
        return;
      }
      requestAnimationFrame(wantDesk);
    }
    // Needs you (the scene's top bar, the city panel, the bezel count of a screen in focus): one tap goes to the oldest open request
    // of every building (needs is officeAdapter.requests, oldest first, the count of the one Notifier), at the desk screen of its
    // session (#89), where the request shows with Approve and Decline.
    // The oldest request: the camera looks at its paper or note on the desk. When that desk is not on screen yet, the scene goes
    // there (its monitor) and the next press finds the paper.
    function goOldest() {
      var r = needs[0];
      if (!r) return;
      if (!r.uid) { setDlg({ name: 'needs' }); return; }   // a Ready to merge decision has no desk (#93)
      if (deskRef.current && r.id && cur2.view === 'office' && deskRef.current.show(r.id, false)) return;
      openDesk(r.uid, 'chat');
    }
    function noteKey(roomId) { return mount ? mount.noteKey(roomId) : ''; }   // the server's key for the room (place.mjs)
    useEffect(function () { return function () {
      if (boardRef.current) { boardRef.current.dispose(); boardRef.current = null; }
      if (terminalRef.current) { terminalRef.current.dispose(); terminalRef.current = null; }
      if (securityRef.current) { securityRef.current.dispose(); securityRef.current = null; }
      if (lobbyRef.current) { lobbyRef.current.dispose(); lobbyRef.current = null; }
      if (deskRef.current) { deskRef.current.dispose(); deskRef.current = null; }
      if (hostRef.current) { hostRef.current.dispose(); hostRef.current = null; }
      setBoard(null); setLook(null); setLayer(null); setChg(null);
    }; }, [sceneKey, cur2.view]);
    // doors: a session that comes into a room or leaves it of the shown building.
    // Room ids come from the board's rooms; the adapter says who sits in each.
    var doorsRef = React.useRef(null);
    // every room of the shown building, from the scene itself (DS room ids, all floors)
    function roomIds() {
      var o = officeRef.current, bl = o && o.getBuilding && o.getBuilding(), out = [];
      ((bl && bl.floors) || []).forEach(function (f) { (f.rooms || []).forEach(function (r) { out.push(r.id); }); });
      return out;
    }
    function roomsNow2(sn) {
      var b = boardRef.current, out = {};
      if (!b || !mount || mount.repo !== shown) return null;
      roomIds().forEach(function (id) {
        var inf = mount.roomInfo(id, sn);
        var rn = (inf.place && inf.place.roomName) || 'Room';
        inf.sessions.forEach(function (x) { if (x.status !== 'ended' && x.place) out[x.uid] = { room: id, name: x.name, roomName: rn }; });
      });
      return out;
    }
    useEffect(function () {
      if (!snap || cur2.view !== 'office') { doorsRef.current = null; return; }
      var now = roomsNow2(snap);
      if (!now) { doorsRef.current = null; return; }
      var prev = doorsRef.current;
      doorsRef.current = { shown: shown, sessions: now };
      if (!prev || prev.shown !== shown) return;
      var b = boardRef.current;
      Object.keys(now).forEach(function (u) {
        if (prev.sessions[u] && prev.sessions[u].room === now[u].room) return;
        if (b && b.doorPulse) b.doorPulse(now[u].room, 'in');
      });
      Object.keys(prev.sessions).forEach(function (u) {
        if (now[u] && now[u].room === prev.sessions[u].room) return;
        if (b && b.doorPulse) b.doorPulse(prev.sessions[u].room, 'out');
      });
    }, [snap]);
    // One panel at a time: while a pinned screen (the desk chat and terminal, the room's changes), the board or the stats panel
    // is open, the DS right column (chat or roster) is hidden. The pinned screens show the open requests as the bezel count.
    var pinned = !!(layer && layer.pin);
    var deskUid = pinned && layer.kind === 'terminal' && layer.item ? layer.item.uid : null;
    var panelOpen = pinned || !!(board && (board.kind === 'board' || board.kind === 'stats'));
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-panel', panelOpen); }, [panelOpen]);
    // The spare room of an empty building takes no bots and no message: the DS broadcast bar is hidden then (office.css).
    var spareNow = !!(mount && mount.spare && mount.spare());
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('no-rooms', spareNow); }, [spareNow]);
    // A side panel changes the free part of the view: the screen in focus is framed again beside it. The window too.
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [panelOpen]);
    // A Security room screen in focus (review M6): at 820 px and below office.css hides the floor list and the room card (the
    // Decisions inbox stays), so the screen gets the height of the view; it is framed again when that changes. The look bar
    // then shows the open requests (LookBar asks).
    var secLook = !!(look && look.kind === 'security');
    // A pinned desk or changes screen needs the height too (review 89: at 400x640 a request needs 140-170 px): the same columns go.
    var hideHud = secLook || pinned;
    React.useLayoutEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('sec-look', hideHud); }, [hideHud]);
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [hideHud]);
    // The scene is as tall as the window. The DS sets its height inline from the height prop, so a resize renders
    // the page again with the new size (once per frame), and then frames the screen in focus again (#55).
    useEffect(function () {
      var raf = 0;
      function onResize() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; setWin(winSize()); }); }
      window.addEventListener('resize', onResize);
      return function () { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
    }, []);
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [win]);
    // Esc flies back from a screen (a look or an open panel). Esc closes the top layer only: a dialog or the palette
    // on top takes it (board.js escTaken), and so does an open panel's own handler that ran first.
    useEffect(function () {
      function onKey(e) {
        var host = hostRef.current, B = window.OfficeBoard;
        if (e.key !== 'Escape' || !host || !host.focused() || (B && B.escTaken ? B.escTaken(e) : e.defaultPrevented)) return;
        e.preventDefault(); host.blur();
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, []);
    // When the office opens something new in the right column (the Decisions inbox, or the chat of another bot),
    // the page panel steps aside. The bot of the desk in focus is not new: the desk selects it. A desk the page is
    // flying to (openDesk) is not new either. The desk in focus is read from the host now, not from the last render.
    var lastSel = React.useRef(sel);
    var selSess = sel ? window.officeAdapter.session(sel) : null;
    useEffect(function () {
      var prev = lastSel.current; lastSel.current = sel;
      if (!panelOpen) return;
      var f = hostRef.current && hostRef.current.focused(), fu = f && f.kind === 'terminal' && f.item ? f.item.uid : null;
      var mine = selSess && (selSess.uid === fu || (deskWant.current && deskWant.current.uid === selSess.uid));
      if (inbox || (sel && sel !== prev && !mine)) {
        blurScene();
        setBoard(null);
      }
    }, [sel, inbox]);
    // The newest surface wins: a page panel that opens while the Decisions inbox is open closes the inbox.
    var wasPanel = React.useRef(false);
    useEffect(function () {
      var was = wasPanel.current; wasPanel.current = panelOpen;
      if (panelOpen && !was && inbox) setInbox(false);
    }, [panelOpen]);
    // zoom out to leave: scrolling out at the widest zoom goes floor -> building -> city
    useEffect(function () {
      if (cur2.view !== 'office') return undefined;
      // One gesture leaves one level (wheel-gate.js): a pause after each change, three pushes at the building level.
      var gate = window.OfficeWheelGate.create();
      function onWheel(e) {
        var o = officeRef.current, st = o && o.inspect && o.inspect().stage;
        var host = hostRef.current, level = host && host.inBuilding() ? 'building' : 'floor';
        // a screen in focus (or a flight to it or back) holds the floor: Esc or Back leaves it first
        var held = !!(host && (host.focused() || host.flying()));
        var now = Date.now(), inScene = !!(e.target.closest && e.target.closest('.ao-scene'));
        var ok = !!(st && st.ctl && e.deltaY > 0 && inScene && !held && st.cam.zoom <= st.ctl.minZoom * 1.03);
        var leave = gate.push(level, now, ok);
        // keep the DS camera feel from clearing the framing the level change started
        if (inScene && (leave || gate.holding(now))) { e.preventDefault(); e.stopPropagation(); }
        if (!leave) return;
        if (level === 'building') go('city'); else o.setView('building');
      }
      window.addEventListener('wheel', onWheel, { passive: false, capture: true });
      return function () { window.removeEventListener('wheel', onWheel, true); };
    }, [cur2.view]);
    // notifier: false: the page runs the one Notifier (alerts and the tab title for every building, below).
    // Since you left shows on every scene: the adapter seeds the state it sends again, so the card counts only news.
    var scene = cur2.view === 'city' ? h(CityView, { key: 'city', shown: shown, onEnter: enter, needs: needs.length, onNeeds: goOldest, onHq: function () { setDlg({ name: 'hq' }); } }) : def ? h(A.OfficeScene, { key: sceneKey, building: def, adapter: mount.adapter, floor: cur2.floor == null ? undefined : cur2.floor, height: win.h, quality: 'auto', intro: intro, editable: false, simulate: false, toasts: false,
      inbox: inbox, onInbox: setInbox, notifier: false, onSinceYouLeft: setSyl, floorsTitle: 'Elevator',
      // Needs you in the top bar, at every width (#92 review: with no dock, a request in another building showed only in the tab title)
      waitingCount: needs.length, onWaiting: goOldest,
      // The scene's live request and error toasts go to the page stack, where they stay until closed. Seeded events
      // (a scene mounted again) send none: an open request stays in Needs you, the inbox and the tab title.
      onNotify: function (n) {
        if (n.kind !== 'request' && n.kind !== 'error') return;
        var ns = mount ? mount.session(n.bot) : null;   // the session, so the toast and its Open outlive a scene change
        toast({ tone: n.kind === 'error' ? 'error' : 'warning', title: n.bot, text: n.text, bot: n.bot, req: n.kind === 'request', uid: ns ? ns.uid : '', action: { label: 'Open', onClick: function () { if (ns && n.kind === 'request') openDesk(ns.uid, 'chat'); else if (ns) goTo(ns); else if (officeRef.current) officeRef.current.select(n.bot); } } });
      },
      ambient: ambient, onAmbientOpen: function () { setAmbient(false); }, onReady: function (o) {
        officeRef.current = o; readyKey.current = sceneKey;
        selectPending(o);
        window.officeScene = o;   // the mounted office API, for the console and tests
        var st = o.inspect && o.inspect().stage;
        if (boardRef.current) boardRef.current.dispose();
        if (terminalRef.current) terminalRef.current.dispose();
        if (securityRef.current) { securityRef.current.dispose(); securityRef.current = null; }
        if (hostRef.current) hostRef.current.dispose();
        // waiting: the bezel of the screen in focus counts every request of every building (Needs you)
        var host = hostRef.current = window.OfficeSceneHost && st ? window.OfficeSceneHost.attach(o, { covers: sceneCovers, waiting: function () { return needsRef.current; } }) : null;
        window.officeHost = host;   // the scene host (focus, flights), for the console and tests
        // The pinned layer: the page renders again when its screen, state or count changes; the box moves without a render.
        if (host) host.onLayer(function (l) {
          setLayer(function (p) { return p && l && p.key === l.key && p.shown === l.shown && p.pin === l.pin && p.waiting === l.waiting && p.item === l.item ? p : l; });
        });
        // The floor the user looks at, for the memory of floors: a floor other than the one the page opened is a move (#111).
        if (offFloor.current) { offFloor.current(); offFloor.current = null; }
        if (host && mount) {
          var seenRepo = cur2.repo, seenMount = mount;
          offFloor.current = host.frame(function () { floorMem.current.see(seenRepo, seenMount.floorKey(host.floorId())); });
        }
        // A screen in focus: a look shows the look bar; a look, a look at another screen or a way back closes the panels.
        // The second step opens a panel through the board's onOpen. A pinned screen (a desk monitor, the room's changes) has
        // no look bar: its layer is the screen, with its own Back. A desk in focus selects its bot (the dock's actions for it).
        // A Security room screen keeps the look bar in focus: every click on it is a click on a cell, never a panel.
        if (host) host.onFocus(function (f) {
          // The layer used here is remembered per place; a place used at Inspect or deeper opens on the first tap.
          var Ly = window.OfficeVocab.layers, rid = f && f.item && f.item.roomId, fs = f && f.kind === 'terminal' && f.item && f.item.uid ? window.officeAdapter.sessionByUid(f.item.uid) : null;
          var place = rid || (fs && fs.place && fs.place.roomId);
          // Only the deepest layer a visit reached counts, when the visit ends: a look that went on to Inspect is not also a Look.
          var at = f && place ? (f.kind === 'security' ? 'deep' : f.open || f.pin ? 'inspect' : 'look') : '';
          if (at) { var v = visitRef.current; if (v && v.place !== place) noteLayer(v.place, v.at); visitRef.current = v && v.place === place && Ly.order.indexOf(v.at) >= Ly.order.indexOf(at) ? v : { place: place, at: at }; }
          else if (!f && visitRef.current) { noteLayer(visitRef.current.place, visitRef.current.at); visitRef.current = null; }
          if (f && !f.open && !f.pin && rid && f.kind !== 'security' && Ly.opensAt(Ly.layerFor(layerMem, rid))) setTimeout(function () { if (hostRef.current && hostRef.current.focused()) hostRef.current.open(); }, 0);
          setLook(f && !f.pin && (!f.open || f.kind === 'security') ? f : null);
          if (!f || !f.open) setBoard(null);
          if (!f || f.kind !== 'changes') setChg(null);
          if (f && f.pin && f.kind === 'terminal' && f.item && f.item.name) o.select(f.item.name);
        });
        if (st && host && window.OfficeBoard) {
          boardRef.current = window.OfficeBoard.attach(o, {
            host: host,
            room: function (id) { return mount.roomInfo(id); },
            usable: function (id) { return mount.usable(id); },
            note: function (id) { var n = latestSnap.current && latestSnap.current.notes && latestSnap.current.notes[noteKey(id)]; return n ? n.text : ''; },
            tree: function (root) { return api('/api/tree', { root: root }); },
            stats: function (id) { return mount.figures(id); },
            pin: function (id) { var n = latestSnap.current && latestSnap.current.pins && latestSnap.current.pins[noteKey(id)]; return n && n.text ? { text: n.text, by: n.by } : null; },
            onDoor: function (id) { setDlg({ name: 'room', roomId: id }); },
            state: function (id) { return mount.rollup().rooms[id] || null; },
            onOpen: function (id, kind) { if (kind !== 'changes') setBoard({ id: id, kind: kind }); }
          });
        }
        if (st && host && window.OfficeSecurity) {
          var secMount = mount;
          securityRef.current = window.OfficeSecurity.attach(o, {
            host: host,
            roomId: function () { return secMount.securityRoom(); },
            // the rules, what each agent kind enforces and the Spend figures (snap.security), for this building
            data: function () { var sn = latestSnap.current; return sn && sn.security ? { sec: sn.security, building: secMount.repo, buildingName: (def && def.name) || '', hq: sn.hq || null } : null; },
            post: function (route, body) { return api(route, body); },
            onError: function (text) { toast({ tone: 'error', title: 'Security', text: text }); }
          });
          window.officeSecurity = securityRef.current;   // the Security room screens (open a screen), for the console and tests
        }
        if (st && host && window.OfficeLobby) {
          var lobMount = mount;
          if (lobbyRef.current) lobbyRef.current.dispose();
          lobbyRef.current = window.OfficeLobby.attach(o, {
            host: host,
            layout: function () { var sn = latestSnap.current; return (sn && sn.layouts && sn.layouts[lobMount.repo]) || null; },
            since: function () { try { var sm = o.summary ? o.summary() : null; return ((sm && sm.top) || []).map(function (x) { return typeof x === 'string' ? x : String(x && x.text || ''); }); } catch (x) { return []; } },
            floors: function () { return lobMount.floors(); },
            states: function () { return lobMount.rollup().floors; },
            agents: function () { return lobMount.agentsByFloor(); },
            session: function (botName) { return lobMount.session(botName); },
            onDesk: function (roomId) { deskStart(roomId); },
            // the tour's monitor stop: an agent's monitor on the floor first (terminal.js look), else an open desk's
            monitor: function () { return !!(terminalRef.current && terminalRef.current.look && terminalRef.current.look()); },
            onReception: function (part) { if (part === 'directory') openPalette(); else setDlg({ name: 'reception' }); }
          });
          window.officeLobby = lobbyRef.current;   // the lobby (open desks, memo, directory, nameplates), for the console and tests
        }
        if (st && host && window.OfficeTerminal) {
          terminalRef.current = window.OfficeTerminal.attach(o, {
            host: host,
            session: function (botName) { return mount.session(botName); },
            // a click on the monitor in focus outside its layer: the desk screen shows its chat
            onOpen: function () { setDeskTab('chat'); }
          });
        }
        if (st && host && window.OfficeDesk) {
          var deskMount = mount;
          if (deskRef.current) deskRef.current.dispose();
          deskRef.current = window.OfficeDesk.attach(o, {
            host: host,
            targets: function () { return deskMount.deskTargets(latestSnap.current); },
            sessions: function () { return ((latestSnap.current && latestSnap.current.sessions) || []).filter(function (x) { return deskMount.botName(x.uid); }).map(function (x) { return Object.assign({}, x, { botName: deskMount.botName(x.uid) }); }); },
            onAnswer: function (paper, act) {
              api('/api/answer', { id: paper.id, allow: act.allow, always: !!act.always }).then(function () {
                if (act.always) toast({ tone: 'success', title: paper.bot, text: 'Allowed from now on: ' + paper.always });
              }, function (x) { toast({ tone: 'error', title: paper.bot, text: x.message }); });
            },
            onPause: function (uid) { api('/api/interrupt', { uid: uid }).catch(function (x) { toast({ tone: 'error', title: 'Pause', text: x.message }); }); }
          });
          window.officeDesk = deskRef.current;   // the desk objects, for the console and tests
        }
        if (!st || !host || !window.OfficeCity) return;
        window.OfficeCity.cameraFeel(st);
        // birds over the tower in the building view; none inside a floor
        // the host knows the view from the floor groups, not from the page markup
        var outside = function () { return host.inBuilding(); };
        window.OfficeCity.streetsAround(st, { visible: outside, host: host });
        window.OfficeCity.birds(st, { count: 6, radius: 13, size: 0.6, visible: outside, host: host,
          center: function () { var fl = (o.getBuilding && o.getBuilding().floors.length) || 1; return [0, fl * 4.2 + 4, 0]; } });
      },
      reset: week ? resetText(week.resetsAt) : undefined }) : null;

    // A session opened from this page that sits in another building: offer the way there.
    var seen = React.useRef(null);
    useEffect(function () {
      if (!snap) return;
      if (!seen.current) { seen.current = {}; snap.sessions.forEach(function (s) { seen.current[s.uid] = true; }); return; }
      snap.sessions.forEach(function (s) {
        if (seen.current[s.uid] || !s.place) return;
        seen.current[s.uid] = true;
        var key = window.officeAdapter.buildingOf(s);
        if (s.status !== 'ended' && key !== shown) toast({ tone: 'info', title: s.name, text: 'Opened in ' + s.place.building + '.', action: { label: 'Go there', onClick: function () { pick(key); } } });
      });
    }, [snap]);

    // the folder of the shown building, for Open session to start in
    var shownRepo = snap && (snap.repos || []).filter(function (r) { return r.key === shown; })[0];
    var shownPath = shownRepo ? shownRepo.path : '';
    // An open desk (#92): the Open dialog starts the agent with the desk's floor as its role, in the room's folder
    // (the building's folder for a room of open desks). Phase 2 (#90) starts it at the desk with no dialog.
    // The second click on an open desk (#90): an agent of the default kind starts at once, in that room's workspace, with the role
    // of the floor. There is no form: Open session in Ctrl+K keeps the form for another kind, model or folder. A kind that asks
    // the cost question (not the default one) is not started from a desk.
    function deskStart(roomId) {
      var fn = mount ? mount.roomFloor(roomId) : null, pl = mount ? mount.roomInfo(roomId).place : null;
      var cwd = (pl && pl.path) || shownPath || ((info && info.recent) || [])[0] || '';
      api('/api/open', { cwd: cwd, provider: DEFAULT_KIND, where: 'office', isolation: 'same', role: fn || undefined }).then(function () {}, function (x) {
        toast({ tone: 'error', title: 'Start agent', text: x.message });
      });
    }
    // The lobby tour: once per browser, on the Lobby of the first building shown; Replay from the Reception or Ctrl+K.
    var tr = useState(false), touring = tr[0], setTouring = tr[1];
    function startTour() {
      var o = officeRef.current;
      if (o && mount && o.setFloor) { var lid = mount.floorId('lobby'); if (lid != null) o.setFloor(lid); }
      setTouring(true);
    }
    function endTour() {
      setTourSeen(); setTouring(false);
      var el = document.getElementById('office'); if (el) el.classList.remove('tour-elevator');
      if (hostRef.current) hostRef.current.blur();
    }
    function tourStep(key) {
      var el = document.getElementById('office'); if (el) el.classList.toggle('tour-elevator', key === 'elevator');
      if (lobbyRef.current) lobbyRef.current.tour(key);
    }
    var readyFor = mount ? mount.id : null;
    useEffect(function () {
      if (!readyFor || ambient || touring || !window.OfficeLobby || !window.OfficeLobby.pure.tourDue(tourSeen(), cur2.view === 'office')) return undefined;
      // after the intro flight, once the scene and its lobby are ready (at most 10 s)
      var n = 0, t = setInterval(function () { if (lobbyRef.current && lobbyRef.current.idle()) { clearInterval(t); startTour(); } else if (++n > 40) clearInterval(t); }, reduced() ? 50 : 250);
      return function () { clearInterval(t); };
    }, [readyFor]);

    // A request toast goes once its request is answered.
    var needIds = needs.map(function (r) { return r.uid; }).join('|');
    useEffect(function () {
      setToasts(function (l) {
        // by session uid, against the requests of every building (not the scene on screen); a toast with no uid goes when nothing waits
        var keep = l.filter(function (t) { if (!t.req) return true; return needs.some(function (r) { return !t.uid || r.uid === t.uid; }); });
        return keep.length === l.length ? l : keep;
      });
    }, [needIds]);
    function close() { setDlg(null); }
    function alertsOn() { try { return localStorage.getItem('ao-alerts') === '1'; } catch (x) { return false; } }
    function extensions(uid, name) { setDlg({ name: 'ext', uid: uid, label: name }); }
    // Go to a session: show its building (inside, from the city), then select its bot once that scene is ready.
    var pendingSel = React.useRef(null);
    function goTo(s) {
      var key = window.officeAdapter.buildingOf(s);
      pendingSel.current = s.uid; pick(key); setDlg(null);
      if (view !== 'office') { introNext.current = false; go('office'); }   // a bot is the target: the intro would end by clearing its selection
      else if (key === shown && officeRef.current) selectPending(officeRef.current);   // the scene is already up
    }
    // The bot is seated a moment after the scene is ready, so this runs again on each snapshot until it is found.
    // It stops when the session is gone.
    var readyKey = React.useRef(null);
    function selectPending(o, tries) {
      var uid = pendingSel.current;
      if (!uid) return;
      var n = window.officeAdapter.botName(uid);
      if (n) { pendingSel.current = null; o.select(n); return; }
      var s = window.officeAdapter.sessionByUid(uid);
      if (!s || s.status === 'ended') { pendingSel.current = null; return; }
      // not seated yet: look again next frame (at most 120 frames), unless the scene went away
      if ((tries || 0) < 120) requestAnimationFrame(function () { if (officeRef.current === o) selectPending(o, (tries || 0) + 1); });
    }
    useEffect(function () { if (pendingSel.current && officeRef.current && readyKey.current === sceneKey) selectPending(officeRef.current); }, [snap, sceneKey]);
    // The sessions of a room, plus the bot whose chat is open when it sits in another room: its requests stay in view.
    function roomAndSel(roomId, onlyExtra) {
      var inRoom = mount ? mount.roomInfo(roomId, snap || undefined).sessions : [];
      var extra = selSess && !inRoom.some(function (x) { return x.uid === selSess.uid; }) ? [selSess] : [];
      return onlyExtra ? extra : inRoom.concat(extra);
    }
    var d = dlg && dlg.name;

    // the page's own commands in Ctrl+K, built from this render's state and handed to the palette after the render
    var actions = [];
    [['open', 'Open a session', 'add', function () { show('open'); }], ['sessions', 'All sessions', 'identity', function () { setDlg({ name: 'sessions' }); }],
     ['city', 'City view', 'building', function () { go('city'); }], ['office', 'Office view', 'floor', function () { go('office'); }], ['floors', 'Branches and worktrees', 'floor', function () { setDlg({ name: 'floors' }); }],
     ['past', 'Past sessions', 'session', function () { show('past'); }], ['schedules', 'Schedules', 'schedule', function () { show('schedules'); }],
     ['hooks', 'Attach sessions', 'terminal', function () { show('hooks'); }], ['kinds', 'Agent kinds', 'bot', function () { setDlg({ name: 'kinds' }); }], ['compact', 'Compact view', 'zoom-out', function () { setAmbient(true); }],
     ['reception', 'Reception: floors and the kind of building', 'building', function () { setDlg({ name: 'reception' }); }], ['tour', 'Replay the lobby tour', 'chevron-right', function () { startTour(); }]]
      .forEach(function (a) { actions.push({ id: 'page-' + a[0], label: a[1], icon: a[2], group: 'Office', run: a[3] }); });
    var selKind = selSess ? kindOf(window.officeAdapter.kinds(), selSess.provider) : null;
    if (selSess && (!selKind || selKind.control)) actions.push({ id: 'page-ext', label: 'Extensions of ' + selSess.name, icon: 'connector', group: 'Office', run: function () { extensions(selSess.uid, selSess.name); } });
    actions.push({ id: 'page-needs', label: needs.length ? 'Needs you (' + needs.length + ')' : 'Needs you', icon: 'waiting', group: 'Office', keywords: 'requests approve decline questions decisions', run: function () { setDlg({ name: 'needs' }); } });
    actions.push({ id: 'page-flow', label: 'Changes: pipeline and Ready to merge', icon: 'pull-request', group: 'Office', keywords: 'pull request pr merge pipeline folder review checks tray', run: function () { setDlg({ name: 'flow' }); } });
    if (snap && snap.hq) actions.push({ id: 'page-hq', label: 'Paperclip HQ', icon: 'hq', group: 'Office', keywords: 'paperclip company agents budget heartbeats routines supervise', run: function () { setDlg({ name: 'hq' }); } });
    list.forEach(function (b) { if (b.key !== shown) actions.push({ id: 'page-b-' + b.key, label: 'Go to ' + b.name, icon: 'building', group: 'Buildings', keywords: 'building repository ' + b.name, run: function () { pick(b.key); } }); });
    // The Reception lists the office's own actions (the dock had them before #92), so a touch screen reaches them with no keyboard.
    var officeActions = actions.filter(function (a) { return ['page-open', 'page-needs', 'page-flow', 'page-sessions', 'page-past', 'page-schedules', 'page-hooks', 'page-kinds', 'page-floors', 'page-city', 'page-compact'].indexOf(a.id) >= 0; })
      .concat([{ id: 'page-search', label: 'Search actions', icon: 'search', run: openPalette }]);

    // Room tools and sessions are built when the palette draws, so the rooms of the floor on screen are current.
    function liveActions() {
      var out = [], b = boardRef.current, sn = latestSnap.current, sec = securityRef.current;
      // Permissions: fly to the Security room of the building on screen (its floor first), at its Files screen
      if (sec && mount && cur2.view === 'office' && mount.repo === shown && mount.securityRoom()) {
        out.push({ id: 'page-permissions', label: 'Permissions', icon: 'security', group: 'Office', keywords: 'security room rules ask allow deny agents spend limit',
          run: function () { if (!sec.open('files')) toast({ tone: 'info', title: 'Permissions', text: 'This building shows no Security room yet.' }); } });
      }
      if (b && mount && cur2.view === 'office' && mount.repo === shown) {
        var tools = [['board', 'Board of ', 'plan', 'blackboard overview plan steps'], ['notes', 'Notes of ', 'memory', 'whiteboard notes reminder'],
          ['stats', 'Stats of ', 'cost', 'numbers tokens cost calls'], ['door', 'Agents in ', 'team', 'door add remove agents']];
        b.rooms().forEach(function (id) {
          var rn = (mount.roomInfo(id).place || {}).roomName || 'Room';
          tools.forEach(function (k) { out.push({ id: 'page-room-' + id + '-' + k[0], label: k[1] + rn, icon: k[2], group: 'Rooms', keywords: 'room ' + k[3], run: function () { b.open(id, k[0]); } }); });
        });
      }
      // The desk objects of the building on screen (#90, desk.js ACTIONS): an open desk on each floor, the approval papers, the
      // question notes and the pause keys. Each is the keyboard path of the same click, through the same rules (high risk: Approve,
      // then Confirm).
      if (mount && cur2.view === 'office' && mount.repo === shown && window.OfficeDesk && sn) {
        var dt = mount.deskTargets(sn), dk = deskRef.current;
        dt.empty.forEach(function (e) { var f = mount.floors().filter(function (x) { return x.key === e.floorKey; })[0]; e.name = f ? f.name : e.floorKey; e.wing = f ? f.wingName : ''; });
        var dsess = (sn.sessions || []).filter(function (x) { return x.status !== 'ended' && mount.botName(x.uid); }).map(function (x) { return Object.assign({}, x, { botName: mount.botName(x.uid) }); });
        window.OfficeDesk.pure.paletteActions(dt, dk ? dk.stages() : {}, dsess).forEach(function (a) {
          var icon = a.action === 'desk-start' ? 'add' : a.action === 'paper-decline' ? 'decline' : a.action === 'pause' ? 'pause' : a.action === 'note-answer' ? 'chat' : 'approve';
          out.push({ id: 'page-desk-' + a.id, label: a.label, icon: icon, group: a.action === 'desk-start' ? 'Floors' : 'Needs you', keywords: 'desk paper stamp question note pause agent start role floor ' + (a.ref && a.ref.wing || ''),
            run: function () {
              if (a.action === 'desk-start') return deskStart(a.ref.roomId);
              if (!dk || !dk.act(a.action, a.ref.id || a.ref.uid)) toast({ tone: 'info', title: 'Desk', text: 'That request is not on this floor. Use Needs you to go there.' });
            } });
        });
      }
      ((sn && sn.sessions) || []).filter(function (s) { return s.status !== 'ended'; }).forEach(function (s) {
        var where = ((s.place && s.place.building) || '') + (s.place && s.place.room ? ' · ' + s.place.room : ''), kw = 'session ' + where, nm = sceneName(s);
        // the dock's per-agent actions (#92): Always allow, the model and the permission mode
        var ask = window.OfficeVocab.alwaysOffer(s), skd = kindOf(window.officeAdapter.kinds(), s.provider), steer = s.headless && (!skd || skd.control);
        if (ask) out.push({ id: 'page-s-always-' + s.uid, label: 'Always allow ' + clip(ask.always, 40) + ' for ' + nm, icon: 'approve', group: 'Sessions', hint: where, keywords: kw + ' permission rule approve',
          run: function () { api('/api/answer', { id: ask.id, allow: true, always: true }).then(function () { toast({ tone: 'success', title: s.name, text: 'Allowed from now on: ' + ask.always }); }, function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } });
        if (steer) MODELS.slice(1).forEach(function (mo) { if (mo.value !== s.model) out.push({ id: 'page-s-model-' + mo.value + '-' + s.uid, label: 'Model of ' + nm + ': ' + mo.label, icon: 'bot', group: 'Sessions', hint: where, keywords: kw + ' model lane',
          run: function () { api('/api/control', { uid: s.uid, action: 'model', value: mo.value }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } }); });
        if (steer) MODES.forEach(function (md) { if (md.value && md.value !== s.mode) out.push({ id: 'page-s-mode-' + md.value + '-' + s.uid, label: 'Permissions of ' + nm + ': ' + md.label, icon: 'security', group: 'Sessions', hint: where, keywords: kw + ' permission mode',
          run: function () { api('/api/control', { uid: s.uid, action: 'mode', value: md.value }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } }); });
        out.push({ id: 'page-s-go-' + s.uid, label: 'Go to session ' + nm, icon: 'chevron-right', group: 'Sessions', hint: where, keywords: kw, run: function () { goTo(s); } });
        out.push({ id: 'page-s-term-' + s.uid, label: 'Terminal of ' + nm, icon: 'terminal', group: 'Sessions', hint: where, keywords: kw + ' output', run: function () { openDesk(s.uid, 'terminal'); } });
        out.push({ id: 'page-s-chg-' + s.uid, label: 'Changes of ' + nm, icon: 'trace', group: 'Sessions', hint: where, keywords: kw + ' diff files', run: function () { changes(s.uid, nm); } });
        if (s.headless && (s.status === 'working' || s.status === 'waiting')) out.push({ id: 'page-s-stop-' + s.uid, label: 'Stop turn of ' + nm, icon: 'pause', group: 'Sessions', hint: where, keywords: kw + ' interrupt', run: function () { api('/api/interrupt', { uid: s.uid }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } });
      });
      return out;
    }
    useEffect(function () { pageActions = function () { return actions.concat(liveActions()); }; return function () { pageActions = []; }; });

    return h(React.Fragment, null,
      h('div', { className: 'view' + (fading ? ' is-fading' : '') }, scene),
      !ambient && touring && cur2.view === 'office' ? h(TourCard, { onStep: tourStep, onDone: endTour }) : null,
      d === 'reception' ? h(ReceptionDialog, { repo: shown, actions: officeActions, onTour: startTour, onClose: close }) : null,
      d === 'open' ? h(OpenDialog, { shownPath: shownPath, kind: dlg.kind, role: dlg.role, roleName: dlg.roleName, folder: dlg.folder, spendLimit: info.spendLimit, recent: info.recent || [], templates: info.templates || [], onTemplates: refresh, onClose: close }) : null,
      d === 'kinds' ? h(KindsDialog, { onOpen: function (kind) { refresh().then(function () { setDlg({ name: 'open', kind: kind }); }); }, onClose: close }) : null,
      d === 'flow' ? h(FlowDialog, { toast: toast, onClose: close }) : null,
      d === 'past' ? h(PastDialog, { onClose: close, onChanges: changes, toast: toast }) : null,
      d === 'schedules' ? h(SchedulesDialog, { recent: info.recent, spendLimit: info.spendLimit, onInfo: setInfo, toast: toast, onClose: close }) : null,
      d === 'changes' ? h(ChangesDialog, { uid: dlg.uid, name: dlg.label, ended: dlg.ended, toast: toast, onClose: close }) : null,
      d === 'hooks' ? h(HooksDialog, { info: info, snap: snap, onSaved: refresh, toast: toast, onClose: close }) : null,
      d === 'floors' ? h(FloorsDialog, { repo: shown, toast: toast, onClose: close }) : null,
      d === 'room' && mount ? h(RoomDialog, { mount: mount, roomId: dlg.roomId, toast: toast, onClose: close }) : null,
      d === 'ext' ? h(ExtensionsDialog, { uid: dlg.uid, name: dlg.label, toast: toast, onClose: close }) : null,
      // The pinned screens (#89): the desk monitor in focus shows the chat and terminal of its session, the room's wall
      // screen its changes. They mount with the look (hidden while the camera flies) and show once it lands.
      deskUid && hostRef.current ? h(DeskScreen, { key: 'desk-' + deskUid, uid: deskUid, bot: layer.item.name, name: sceneName({ uid: deskUid, name: layer.item.name }), host: hostRef.current, office: officeRef.current,
        shown: layer.shown, tab: deskTab, onTab: setDeskTab, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene,
        onRules: function () { var d2 = window.officeAdapter.sessionByUid(deskUid); if (d2 && d2.place) noteLayer(d2.place.roomId, 'deep'); blurScene(); setTimeout(function () { if (securityRef.current && !securityRef.current.open('files')) toast({ tone: 'info', title: 'Permissions', text: 'This building shows no Security room yet.' }); }, 0); } }) : null,
      pinned && layer.kind === 'changes' && chg && hostRef.current ? h(ChangesScreen, { key: 'chg-' + chg.uid, uid: chg.uid, name: chg.name, ended: chg.ended, host: hostRef.current,
        shown: layer.shown, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene }) : null,
      pinned && layer.kind === 'note' && layer.item && layer.item.data && hostRef.current ? h(NoteScreen, { key: 'note-' + layer.item.id, note: layer.item.data, host: hostRef.current,
        shown: layer.shown, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene }) : null,
      // The bezel count of a screen in focus that is not pinned (a board, the notes, the stats, a Security screen).
      layer && !pinned && hostRef.current ? h(Bezel, { host: hostRef.current, shown: layer.shown, count: layer.waiting, onGo: goOldest }) : null,
      board && boardRef.current && board.kind === 'board' ? h(BoardPanel, { data: boardRef.current.dataOf(board.id), sessions: roomAndSel(board.id), onGo: goOldest, toast: toast, onClose: closeBoard }) : null,
      board && boardRef.current && board.kind === 'stats' && mount ? h(StatsPanel, { mount: mount, extra: roomAndSel(board.id, true), onGo: goOldest, toast: toast, roomId: board.id, onClose: closeBoard }) : null,
      board && boardRef.current && board.kind === 'notes' ? h(NotesEditor, { key: board.id, noteKey: noteKey(board.id), text: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).text || '', version: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).v || 0, toast: toast,
        rect: function () { return hostRef.current ? hostRef.current.rect() : null; }, flying: function () { return hostRef.current ? hostRef.current.flying() : false; },
        onClose: function () { if (boardRef.current) boardRef.current.refresh(); blurScene(); } }) : null,
      look && !board && hostRef.current ? h(LookBar, { key: look.key, verb: look.verb, agents: look.item && look.item.roomId && look.kind !== 'security' && mount ? roomAndSel(look.item.roomId) : null, onInspect: goTo, icon: LOOK_ICON[look.kind] || 'zoom-in', toast: toast, layout: secLook,
        onGo: goOldest, asks: secLook && snap ? (snap.sessions || []).filter(function (s) { return window.OfficeVocab.requests(s).length > 0; }) : [],
        free: function (el) { return hostRef.current ? hostRef.current.free(sceneCovers(el)) : null; },
        onPlaced: function () { if (hostRef.current) hostRef.current.refit(); },
        onBack: blurScene, onOpen: function () { if (hostRef.current) hostRef.current.open(); } }) : null,
      d === 'sessions' ? h(SessionsDialog, { onClose: close, onGo: goTo }) : null,
      d === 'hq' ? h(HqDialog, { snap: snap, onAttach: function () { show('hooks'); }, onClose: close }) : null,
      d === 'needs' ? h(NeedsDialog, { toast: toast, onClose: close, onGo: function (r) { var s = snap && snap.sessions.filter(function (x) { return x.uid === r.uid; })[0]; if (s) goTo(s); else close(); } }) : null,
      // The one Notifier (the scene has notifier: false). The tab title counts every request of every building, in the
      // city too. Browser alerts for the requests and errors of every building; the DS alert toggle decides, and they
      // show only while the page is hidden. A click goes to the session.
      snap ? h(A.Notifier, { enabled: alertsOn(), count: needs.length, notifications: window.officeAdapter.alerts(snap),
        onClick: function (n) { var s = n.uid ? window.officeAdapter.sessionByUid(n.uid) : null; if (s) goTo(s); } }) : null,
      h('div', { className: 'page-toasts', ref: toastBox },
        h(A.ToastStack, { toasts: toasts, onClose: function (id) { setToasts(function (l) { return window.OfficeToasts.remove(l, id); }); } })));
  }

  ReactDOM.createRoot(document.getElementById('office')).render(h(App));
})();
