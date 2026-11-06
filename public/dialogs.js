/* Agent Office for Claude Code x0.2: the session dialogs (split out of office.js, #1 story 26).
   Open session, skills, past sessions and search, schedules, the changes of a session (diff, pull request, worktree), hooks,
   Paperclip connect, the agent kinds, floors, extensions, all sessions and the agents of one room. Plain functions over the
   page core (window.OfficePage); the dialogs put their names on it for office.js and panels.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, CostDialog = O.CostDialog, DEFAULT_KIND = O.DEFAULT_KIND, F = O.F,
      FeatureTags = O.FeatureTags, ISOLATION = O.ISOLATION, KIND = O.KIND, KV = O.KV, KindFields = O.KindFields,
      MODES = O.MODES, Pair = O.Pair, Pairs = O.Pairs, Tag = O.Tag, WHERE = O.WHERE, ago = O.ago, api = O.api,
      cadence = O.cadence, call = O.call, clip = O.clip, costAsked = O.costAsked, exportSession = O.exportSession,
      getInfo = O.getInfo, kindOf = O.kindOf, limitHint = O.limitHint, limitSent = O.limitSent, limitText = O.limitText,
      look = O.look, modelWord = O.modelWord, plural = O.plural, refocusRow = O.refocusRow, sceneName = O.sceneName,
      statusOf = O.statusOf, useFirstModel = O.useFirstModel, useKinds = O.useKinds, useSnapshot = O.useSnapshot;

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
    // The options of the kind (src/providers/index.mjs describe). Without kinds yet, the dialog offers what Claude Code takes.
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
    // The server owns the folder rules (recent.mjs recentChoices); until its answer comes, show the stored list.
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
        var q = window.OfficeAsk.asked(x, 'skill', confirmed);
        if (q) { setAsk({ action: action, name: name, text: text, question: q.text }); return; }
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
          var q = window.OfficeAsk.asked(x, 'fork', confirmed);
          if (q) { setForkAsk({ s: s, text: q.text }); return; }
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
    if (c.confirm === window.OfficeAsk.local('pr')) {
      return h(A.Dialog, { open: true, title: 'Create a pull request', onClose: function () { c.setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { c.setConfirm(null); } }, 'Cancel'),
        h(A.Button, { key: 'p', variant: 'primary', icon: 'send', loading: c.busy, onClick: c.pr }, 'Create pull request')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'This sends your changes to the remote repository. It does these steps in order:'),
          h('pre', { className: 'code' }, '1. git add -A and git commit\n2. git push -u origin ' + (wt ? wt.branch : '') + '\n3. gh pr create --fill'),
          c.err ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null));
    }
    if (c.confirm === window.OfficeAsk.local('rm')) {
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
      wt ? h(A.Button, { key: 'rm', variant: 'quiet', icon: 'remove', disabled: !ended, title: ended ? '' : 'Close the session first', onClick: function () { c.setConfirm(window.OfficeAsk.local('rm')); } }, 'Remove worktree') : null,
      wt ? h(A.Button, { key: 'pr', variant: 'primary', icon: 'send', disabled: !data || (!data.files.length && !data.ahead), onClick: function () { c.setConfirm(window.OfficeAsk.local('pr')); } }, 'Create pull request') : null];
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
                  here.map(function (s) { return h('span', { key: s.uid, className: 'room-bot', title: s.name }, h(A.BotAvatar, { shape: look(s).shape, color: look(s).color, status: statusOf(s), size: 20 }), s.name); }),
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
              h('td', null, h('span', { className: 'sess-who' }, h(A.BotAvatar, { shape: look(s).shape, color: look(s).color, status: statusOf(s), size: 20 }), h('b', null, sceneName(s)))),
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
          return h(A.DelegationTree, { key: s.uid, max: Math.max(3, kids.length), tree: { name: s.name, shape: look(s).shape, status: statusOf(s), task: s.prompt ? clip(s.prompt, 80) : '', children: kids }, onSelect: function () { p.onGo(s); } });
        })));
  }

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
    // The wall screen of this room (#152): what its blackboard shows. Saved at once, by the room's key; Overview clears it.
    var WV = window.OfficeVocab.wall, wallKey = p.mount.noteKey(p.roomId, snap || undefined), wallNow = WV.viewOf(snap && snap.screens, wallKey);
    function setWall(v) {
      setErr('');
      api('/api/screen/set', { key: wallKey, view: v }).then(function () { p.toast({ tone: 'success', title: 'Wall screen', text: WV.word(v) }); }, function (x) { setErr(x.message); });
    }
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
              h(A.BotAvatar, { shape: look(s).shape, color: look(s).color, status: statusOf(s), size: 28 }),
              h('span', { className: 'agent-who' }, h('b', null, s.name), h('span', { className: 'agent-sub' }, window.OfficeVocab.status(s).word + ' · ' + window.officeAdapter.kindWord(s) + ' · ' + modelWord(KA.list, s)), h(FeatureTags, { session: s })),
              h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { setErr(''); setConfirm(s.uid); } }, 'Close session'));
          })) : h(A.EmptyState, { icon: 'identity', compact: true, title: 'No agents here', text: 'Add an agent to start work in this room.' }),
          wallKey ? h(A.Select, { id: 'room-wall', label: 'Blackboard shows', options: WV.VIEWS.map(function (v) { return { value: v.id, label: v.word }; }), value: wallNow, onChange: setWall, hint: WV.note(wallNow) }) : null,
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
          skillKinds.map(function (k) { return h(A.Button, { key: k.kind, variant: 'quiet', icon: 'skill', onClick: function () { setSkills(k); } }, 'Skills of ' + k.agent); }),
          h(A.AddButton, { label: 'Add an agent', onClick: function () { setErr(''); setAdd({ name: '', provider: DEFAULT_KIND, model: '', prompt: '' }); } }))));
  }

  Object.assign(O, { ChangesBody: ChangesBody, ChangesConfirm: ChangesConfirm, ChangesDialog: ChangesDialog,
      ExtensionsDialog: ExtensionsDialog, FloorsDialog: FloorsDialog, HooksDialog: HooksDialog, KindsDialog: KindsDialog,
      OpenDialog: OpenDialog, PastDialog: PastDialog, RoomDialog: RoomDialog, SchedulesDialog: SchedulesDialog,
      SessionsDialog: SessionsDialog, changesActions: changesActions, useChanges: useChanges });
})();
