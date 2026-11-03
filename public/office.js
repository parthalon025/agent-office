/* Agent Office for Claude Code x0.1: page script.
   Mounts the DS office, the control strip, and the dialogs (open, past sessions, schedules, changes, hooks). */
(function () {
  'use strict';
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo;
  var TOKEN = document.querySelector('meta[name="office-token"]').content;
  A.strict = true;

  var building = {
    name: 'Claude Code Office', sessions: 'agent',
    // The adapter adds one room per project folder as sessions arrive.
    floors: [{ id: 1, key: 'ops', name: 'Sessions', rooms: [] }]
  };

  var MODELS = [
    { value: '', label: 'Default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' }, { value: 'claude-fable-5-1', label: 'Fable' }
  ];
  var MODES = [{ value: '', label: 'Default' }, { value: 'plan', label: 'Plan only' }, { value: 'acceptEdits', label: 'Accept edits' }];
  var WHERE = [{ value: 'office', label: 'In the office (no terminal)' }, { value: 'terminal', label: 'In a terminal window' }];
  var ISOLATION = [{ value: 'same', label: 'Same folder' }, { value: 'worktree', label: 'New git worktree' }];
  var KIND = [{ value: 'every', label: 'Every N minutes' }, { value: 'daily', label: 'Every day at' }];

  // ---------- helpers ----------
  function api(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': TOKEN }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'The office could not do that (' + r.status + ').'); return j; }); });
  }
  function getInfo() { return fetch('/api/info', { headers: { 'x-office-token': TOKEN } }).then(function (r) { return r.json(); }); }
  function ago(t) {
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function money(n) { return typeof n === 'number' ? '$' + n.toFixed(n < 1 ? 3 : 2) : '–'; }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function cadence(s) { return s.kind === 'daily' ? 'Every day at ' + s.at : 'Every ' + s.every + ' min'; }
  function useSnapshot() {
    var st = useState(null);
    useEffect(function () { return window.officeAdapter.onSnapshot(st[1]); }, []);
    return st[0];
  }
  // The bot whose chat is open. The office draws that panel itself, so read the name from its message box.
  function useChatBot() {
    var st = useState(null);
    useEffect(function () {
      var raf = 0;
      function read() {
        raf = 0;
        var input = document.querySelector('.ao-hud-chat .ao-input');
        var name = input ? (input.placeholder || '').replace(/^Message\s+/, '') : null;
        st[1](function (prev) { return prev === name ? prev : name; });
      }
      var mo = new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(read); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder'] });
      read();
      return function () { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, []);
    return st[0];
  }
  function statusOf(s) {
    if (s.status === 'working' || s.status === 'waiting') return s.status;
    if (s.status === 'idle') return s.turns > 0 ? 'finished' : 'resting';
    return 'resting';
  }

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
  function Busy(p) { return p.on ? h(A.Skeleton, { lines: p.lines || 3, label: 'Loading' }) : null; }

  // ---------- open a session ----------
  function OpenDialog(p) {
    var f = useState({ cwd: p.recent[0] || '', name: '', where: 'office', isolation: 'same', model: '', permissionMode: '', maxBudget: '', prompt: '', template: '' }), form = f[0], setForm = f[1];
    var b = useState(false), busy = b[0], setBusy = b[1];
    var e = useState(''), err = e[0], setErr = e[1];
    var sv = useState(null), saving = sv[0], setSaving = sv[1];
    function set(k) { return function (v) { var n = Object.assign({}, form); n[k] = v; setForm(n); }; }
    function pickTemplate(id) {
      var t = p.templates.filter(function (x) { return x.id === id; })[0];
      setForm(Object.assign({}, form, { template: id, prompt: t ? t.text : form.prompt }));
    }
    function submit() {
      setBusy(true); setErr('');
      api('/api/open', Object.assign({}, form, { maxBudget: Number(form.maxBudget) || 0 })).then(function () { setBusy(false); p.onClose(); }, function (x) { setBusy(false); setErr(x.message); });
    }
    function saveTemplate() {
      api('/api/template/save', { name: saving, text: form.prompt }).then(function (t) { setSaving(null); p.onTemplates(); setForm(Object.assign({}, form, { template: t.id })); }, function (x) { setErr(x.message); });
    }
    function delTemplate() { api('/api/template/delete', { id: form.template }).then(function () { setForm(Object.assign({}, form, { template: '' })); p.onTemplates(); }, function (x) { setErr(x.message); }); }
    var terminal = form.where === 'terminal';
    var tpl = [{ value: '', label: 'No template' }].concat(p.templates.map(function (t) { return { value: t.id, label: t.name }; }));
    return h(A.Dialog, {
      open: true, title: 'Open a session', onClose: p.onClose,
      actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: p.onClose }, 'Cancel'),
        h(A.Button, { key: 'o', variant: 'primary', icon: 'add', loading: busy, onClick: submit }, 'Open session')
      ]
    }, h('div', { className: 'form' },
      h('p', { className: 'note' }, terminal ? 'Starts Claude Code in a new terminal window with the office hooks attached.' : 'Runs Claude Code inside the office. You talk to it in the chat and approve its steps here. It has no terminal window.'),
      h(A.TextInput, { id: 'f-cwd', label: 'Folder', value: form.cwd, placeholder: 'E:\\pensiv', onChange: set('cwd'), error: err || undefined, hint: p.recent.length ? 'Last used: ' + p.recent.slice(0, 3).join(', ') : undefined }),
      Pair(
        h(A.TextInput, { id: 'f-name', label: 'Bot name (optional)', value: form.name, placeholder: 'Defaults to the folder name', onChange: set('name') }),
        h(A.Select, { id: 'f-where', label: 'Runs', options: WHERE, value: form.where, onChange: set('where') })),
      Pair(
        h(A.Select, { id: 'f-isolation', label: 'Work in', options: ISOLATION, value: terminal ? 'same' : form.isolation, disabled: terminal, onChange: set('isolation'), hint: form.isolation === 'worktree' && !terminal ? 'A new branch in its own folder. Your main branch stays untouched.' : undefined }),
        h(A.TextInput, { id: 'f-budget', label: 'Spend limit in USD (optional)', value: form.maxBudget, placeholder: 'No limit', disabled: terminal, onChange: set('maxBudget') })),
      Pair(
        h(A.Select, { id: 'f-model', label: 'Model', options: MODELS, value: form.model, onChange: set('model') }),
        h(A.Select, { id: 'f-mode', label: 'Permissions', options: MODES, value: form.permissionMode, onChange: set('permissionMode') })),
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

  // ---------- past sessions and search ----------
  function PastDialog(p) {
    var l = useState(null), list = l[0], setList = l[1];
    var qs = useState(''), q = qs[0], setQ = qs[1];
    var rs = useState(null), results = rs[0], setResults = rs[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    function load() { api('/api/history').then(function (j) { setList(j.sessions); }, function (x) { setErr(x.message); }); }
    useEffect(load, []);
    useEffect(function () {
      if (q.trim().length < 2) { setResults(null); return undefined; }
      var t = setTimeout(function () { api('/api/search', { q: q }).then(function (j) { setResults(j.results); }, function (x) { setErr(x.message); }); }, 250);
      return function () { clearTimeout(t); };
    }, [q]);
    function act(uid, fn) { setBusy(uid); setErr(''); fn().then(function () { setBusy(''); }, function (x) { setBusy(''); setErr(x.message); }); }
    function reopen(uid) { act(uid, function () { return api('/api/reopen', { uid: uid }).then(function () { p.onClose(); }); }); }
    function forget(uid) { act(uid, function () { return api('/api/history/forget', { uid: uid }).then(load); }); }
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
              h('div', { className: 'past-title' }, h('b', null, s.name), s.branch ? h(Tag, null, s.branch) : null, s.model ? h(A.ModelBadge, { model: s.model }) : null),
              h('div', { className: 'past-sub mono' }, s.cwd),
              hit[s.uid] ? h('div', { className: 'past-snip' }, h('em', null, hit[s.uid].kind + ': '), hit[s.uid].snippet) : (s.last ? h('div', { className: 'past-snip' }, s.last) : null),
              h('div', { className: 'past-meta mono' }, ago(s.endedAt) + ' · ' + s.turns + ' turns · ' + money(s.cost))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'primary', icon: 'rollback', loading: busy === s.uid, onClick: function () { reopen(s.uid); } }, 'Reopen'),
              h(A.Button, { variant: 'quiet', icon: 'trace', onClick: function () { p.onChanges(s.uid, s.name); } }, 'Changes'),
              h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { forget(s.uid); } }, 'Forget')));
        }))));
  }

  // ---------- schedules ----------
  var BLANK = { id: '', name: '', cwd: '', prompt: '', kind: 'every', every: '60', at: '09:00', model: '', permissionMode: '', isolation: 'same', maxBudget: '', enabled: true };
  function SchedulesDialog(p) {
    var l = useState(null), list = l[0], setList = l[1];
    var ed = useState(null), edit = ed[0], setEdit = ed[1];
    var er = useState(''), err = er[0], setErr = er[1];
    function load() { getInfo().then(function (i) { setList(i.schedules || []); p.onInfo(i); }, function (x) { setErr(x.message); }); }
    useEffect(load, []);
    function set(k) { return function (v) { var n = Object.assign({}, edit); n[k] = v; setEdit(n); }; }
    function save() {
      api('/api/schedule/save', Object.assign({}, edit, { every: Number(edit.every) || 60, maxBudget: Number(edit.maxBudget) || 0 })).then(function () { setEdit(null); setErr(''); load(); }, function (x) { setErr(x.message); });
    }
    function run(id) { api('/api/schedule/run', { id: id }).then(function () { setErr(''); }, function (x) { setErr(x.message); }); }
    function del(id) { api('/api/schedule/delete', { id: id }).then(load, function (x) { setErr(x.message); }); }
    function toggle(s) { api('/api/schedule/save', Object.assign({}, s, { enabled: !s.enabled })).then(load, function (x) { setErr(x.message); }); }
    if (edit) {
      return h(A.Dialog, { open: true, title: edit.id ? 'Edit schedule' : 'New schedule', onClose: function () { setEdit(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setEdit(null); } }, 'Cancel'),
        h(A.Button, { key: 's', variant: 'primary', onClick: save }, 'Save schedule')] },
        h('div', { className: 'form' },
          h(A.TextInput, { id: 's-name', label: 'Name', value: edit.name, placeholder: 'Nightly dependency check', onChange: set('name') }),
          h(A.TextInput, { id: 's-cwd', label: 'Folder', value: edit.cwd, placeholder: 'E:\\pensiv', onChange: set('cwd'), error: err || undefined }),
          Pair(
            h(A.Select, { id: 's-kind', label: 'Runs', options: KIND, value: edit.kind, onChange: set('kind') }),
            edit.kind === 'daily'
              ? h(A.TextInput, { id: 's-at', label: 'Time (24 hours)', value: edit.at, placeholder: '09:00', onChange: set('at') })
              : h(A.TextInput, { id: 's-every', label: 'Minutes (5 or more)', value: String(edit.every), onChange: set('every') })),
          Pair(
            h(A.Select, { id: 's-model', label: 'Model', options: MODELS, value: edit.model, onChange: set('model') }),
            h(A.Select, { id: 's-iso', label: 'Work in', options: ISOLATION, value: edit.isolation, onChange: set('isolation') })),
          h(A.TextInput, { id: 's-budget', label: 'Spend limit per run in USD (optional)', value: String(edit.maxBudget || ''), placeholder: 'No limit', onChange: set('maxBudget') }),
          h(Area, { id: 's-prompt', label: 'Instruction', value: edit.prompt, rows: 4, onChange: set('prompt') })));
    }
    return h(A.Dialog, { open: true, title: 'Schedules', onClose: p.onClose, actions: [
      h(A.Button, { key: 'n', variant: 'quiet', icon: 'add', onClick: function () { setEdit(Object.assign({}, BLANK, { cwd: (p.recent || [])[0] || '' })); } }, 'New schedule'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h(Busy, { on: list === null }),
        list && !list.length ? h(A.EmptyState, { icon: 'schedule', title: 'No schedules yet', text: 'A schedule opens a session on its own and runs one instruction.' }) : null,
        h('ul', { className: 'past' }, (list || []).map(function (s) {
          return h('li', { key: s.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, s.name), h(Tag, null, s.enabled ? cadence(s) : 'Paused')),
              h('div', { className: 'past-sub mono' }, s.cwd),
              h('div', { className: 'past-snip' }, clip(s.prompt, 140)),
              h('div', { className: 'past-meta mono' }, 'Last run ' + ago(s.lastRun))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'primary', icon: 'resume', onClick: function () { run(s.id); } }, 'Run now'),
              h(A.Button, { variant: 'quiet', icon: s.enabled ? 'pause' : 'resume', onClick: function () { toggle(s); } }, s.enabled ? 'Pause' : 'Turn on'),
              h(A.Button, { variant: 'quiet', icon: 'settings', onClick: function () { setEdit(Object.assign({}, s, { every: String(s.every), maxBudget: s.maxBudget ? String(s.maxBudget) : '' })); } }, 'Edit'),
              h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { del(s.id); } }, 'Delete')));
        }))));
  }

  // ---------- changes (diff, pull request, worktree) ----------
  function DiffView(p) {
    var lines = p.text.split('\n').slice(0, 1800);
    return h('pre', { className: 'diff', tabIndex: 0, 'aria-label': 'Diff' }, lines.map(function (l, i) {
      var c = l.charAt(0), cls = l.indexOf('+++') === 0 || l.indexOf('---') === 0 || l.indexOf('diff ') === 0 || l.indexOf('index ') === 0 ? 'meta' : c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : '';
      return h('span', { key: i, className: 'dl ' + cls }, l === '' ? ' ' : l);
    }));
  }
  function ChangesDialog(p) {
    var d = useState(null), data = d[0], setData = d[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var rs = useState(null), result = rs[0], setResult = rs[1];
    function load() { setErr(''); api('/api/changes', { uid: p.uid }).then(setData, function (x) { setErr(x.message); setData({ files: [], diff: '', branch: '', stat: '' }); }); }
    useEffect(load, [p.uid]);
    var wt = data && data.worktree;
    function run(fn) { setBusy(true); setErr(''); fn().then(function (r) { setBusy(false); setConfirm(null); setResult(r); load(); }, function (x) { setBusy(false); setErr(x.message); }); }
    function pr() { run(function () { return api('/api/pr', { uid: p.uid }); }); }
    function remove(force) { run(function () { return api('/api/worktree/remove', { uid: p.uid, force: force }); }); }
    if (confirm === 'pr') {
      return h(A.Dialog, { open: true, title: 'Create a pull request', onClose: function () { setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); } }, 'Cancel'),
        h(A.Button, { key: 'p', variant: 'primary', icon: 'send', loading: busy, onClick: pr }, 'Create pull request')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'This sends your changes to the remote repository. It does these steps in order:'),
          h('pre', { className: 'code' }, '1. git add -A and git commit\n2. git push -u origin ' + (wt ? wt.branch : '') + '\n3. gh pr create --fill'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (confirm === 'rm') {
      var dirty = /uncommitted/i.test(err);
      return h(A.Dialog, { open: true, title: 'Remove the worktree', onClose: function () { setConfirm(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy, onClick: function () { remove(dirty); } }, dirty ? 'Remove and discard changes' : 'Remove worktree')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'Deletes the folder ' + (wt ? wt.root : '') + '. The branch ' + (wt ? wt.branch : '') + ' stays if it has commits that are not merged.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    return h(A.Dialog, { open: true, title: 'Changes in ' + (p.name || 'this session'), onClose: p.onClose, actions: [
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: load }, 'Refresh'),
      wt ? h(A.Button, { key: 'rm', variant: 'quiet', icon: 'remove', disabled: !p.ended, title: p.ended ? '' : 'Close the session first', onClick: function () { setConfirm('rm'); } }, 'Remove worktree') : null,
      wt ? h(A.Button, { key: 'pr', variant: 'primary', icon: 'send', disabled: !data || (!data.files.length && !data.ahead), onClick: function () { setConfirm('pr'); } }, 'Create pull request') : null,
      h(A.Button, { key: 'd', variant: wt ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        result && result.url ? h('p', { className: 'note' }, 'Pull request created: ', h('a', { href: result.url, target: '_blank', rel: 'noreferrer' }, result.url)) : null,
        result && result.removed ? h('p', { className: 'note' }, 'Worktree removed.' + (result.branchKept ? ' The branch was kept.' : '')) : null,
        h(Busy, { on: !data }),
        data ? h('div', { className: 'chg-head' },
          data.branch ? h(Tag, null, data.branch) : null,
          h('span', { className: 'mono' }, data.stat || (data.files.length ? data.files.length + ' changed' : 'No changes')),
          data.ahead ? h('span', { className: 'mono' }, data.ahead + ' commit' + (data.ahead > 1 ? 's' : '') + ' ahead') : null) : null,
        data && data.files.length ? h('ul', { className: 'files' }, data.files.map(function (f, i) { return h('li', { key: i }, h('span', { className: 'fcode fc-' + f.code.charAt(0) }, f.word), h('span', { className: 'mono' }, f.path)); })) : null,
        data && data.diff ? h(DiffView, { text: data.diff }) : null,
        data && data.truncated ? h('p', { className: 'note' }, 'The diff is long, so only the start is shown.') : null,
        data && !data.diff && data.files.length ? h('p', { className: 'note' }, 'These files are new, so git has no diff for them yet.') : null,
        data && !data.files.length && !err ? h(A.EmptyState, { icon: 'checkpoint', compact: true, title: 'Nothing changed yet', text: 'Changes show here as the session edits files.' }) : null));
  }

  // ---------- hooks ----------
  function HooksDialog(p) {
    var i = p.info || {};
    return h(A.Dialog, { open: true, title: 'Attach other sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form' },
        h('p', { className: 'note' }, 'Sessions opened here are wired up for you. To seat a session you start yourself, launch it with the office settings file:'),
        h('pre', { className: 'code' }, i.launchCommand || ''),
        h('p', { className: 'note' }, 'Hooks: ' + (i.hooksMode || '') + ' on Claude Code ' + (i.claudeVersion || '') + '. Or merge these hooks into ~/.claude/settings.json to seat every session on this machine.'),
        h('pre', { className: 'code', style: { maxHeight: 200 } }, i.settingsSnippet || '')));
  }

  // ---------- the control strip ----------
  function Controls(p) {
    var snap = useSnapshot();
    var nt = useState(''), note = nt[0], setNote = nt[1];
    var sess = p.sel ? window.officeAdapter.session(p.sel) : null;
    var live = snap ? snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    var total = snap ? snap.sessions.reduce(function (n, s) { return n + (typeof s.cost === 'number' ? s.cost : 0); }, 0) : 0;
    function ctl(action, value) { setNote(''); api('/api/control', { uid: sess.uid, action: action, value: value }).catch(function (x) { setNote(x.message); }); }
    function stopTurn() { setNote(''); api('/api/interrupt', { uid: sess.uid }).catch(function (x) { setNote(x.message); }); }
    var ask = sess && (sess.pending || []).filter(function (r) { return r.always; })[0];
    function always() { setNote(''); api('/api/answer', { id: ask.id, allow: true, always: true }).catch(function (x) { setNote(x.message); }); }

    var modeOpts = [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan only' }, { value: 'acceptEdits', label: 'Accept edits' }];
    if (sess && sess.mode && !modeOpts.some(function (o) { return o.value === sess.mode; })) modeOpts.push({ value: sess.mode, label: sess.mode });
    var modelOpts = MODELS.slice(1);
    if (sess && sess.model && !modelOpts.some(function (o) { return o.value === sess.model; })) modelOpts.unshift({ value: sess.model, label: sess.model });
    var ctxPct = sess && sess.ctxTokens && sess.ctxWindow ? Math.round(100 * sess.ctxTokens / sess.ctxWindow) : null;
    var working = sess && (sess.status === 'working' || sess.status === 'waiting');
    var usage = sess && sess.usage && sess.usage.tokens ? sess.usage : null;

    return h(React.Fragment, null,
      snap && !live.length ? h('div', { className: 'welcome' }, h(A.EmptyState, { icon: 'building', title: 'No sessions yet', text: 'Open a session to seat the first bot. You can also reopen a past one.', action: { label: 'Open session', icon: 'add', onClick: p.onOpen } })) : null,
      h('div', { className: 'strip', role: 'toolbar', 'aria-label': 'Office controls' },
        h('div', { className: 'strip-group' },
          h(A.Button, { variant: 'primary', icon: 'add', onClick: p.onOpen }, 'Open session'),
          h(A.Button, { variant: 'quiet', icon: 'session', onClick: p.onPast }, 'Past'),
          h(A.Button, { variant: 'quiet', icon: 'schedule', onClick: p.onSchedules }, 'Schedules'),
          h(A.Button, { variant: 'quiet', icon: 'terminal', onClick: p.onHooks }, 'Hooks'),
          live.length ? h('span', { className: 'strip-total mono' }, live.length + ' open · ' + money(total)) : null),
        sess ? h('div', { className: 'strip-group strip-bot' },
          h('span', { className: 'strip-id' }, h(A.StatusDot, { status: statusOf(sess) }), h('b', null, sess.name), ctxPct != null ? h('span', { className: 'mono' }, 'context ' + ctxPct + '%') : null),
          sess.headless && (usage || sess.cost) ? h(A.CostMeter, { tokens: usage ? usage.tokens : 0, cost: sess.cost || 0, cached: usage && usage.input ? usage.cached / usage.input : undefined }) : null,
          sess.headless ? h(A.Select, { id: 'c-model', ariaLabel: 'Model of ' + sess.name, options: modelOpts, value: sess.model || '', onChange: function (v) { ctl('model', v); } }) : null,
          sess.headless ? h(A.Select, { id: 'c-mode', ariaLabel: 'Permissions of ' + sess.name, options: modeOpts, value: sess.mode || '', onChange: function (v) { ctl('mode', v); } }) : null,
          sess.headless ? h(A.Button, { variant: 'quiet', icon: 'pause', disabled: !working, onClick: stopTurn }, 'Stop turn') : null,
          h(A.Button, { variant: 'quiet', icon: 'trace', onClick: function () { p.onChanges(sess.uid, sess.name); } }, 'Changes'),
          ask ? h(A.Button, { variant: 'emphasis', icon: 'approve', onClick: always, title: 'Approve and allow this from now on: ' + ask.always }, 'Always allow ' + clip(ask.always, 28)) : null) : null,
        note ? h('p', { className: 'strip-note ao-err', role: 'alert' }, note) : null));
  }

  // ---------- app ----------
  function App() {
    var sel = useChatBot();
    var s2 = useState(null), dlg = s2[0], setDlg = s2[1];
    var s3 = useState({ recent: [], templates: [], schedules: [] }), info = s3[0], setInfo = s3[1];
    function refresh() { return getInfo().then(function (i) { setInfo(i); return i; }, function () { return info; }); }
    function show(name) { refresh().then(function () { setDlg({ name: name }); }); }
    function changes(uid, name) {
      var live = window.officeAdapter.session(name);
      setDlg({ name: 'changes', uid: uid, label: name, ended: !live || live.uid !== uid || live.status === 'ended' });
    }
    // The 3D office mounts once. Re-rendering the page must not rebuild it.
    var scene = useMemo(function () {
      return h(A.OfficeScene, { building: building, adapter: window.officeAdapter, height: window.innerHeight, quality: 'auto', intro: true, editable: false, simulate: false });
    }, []);
    function close() { setDlg(null); }
    var d = dlg && dlg.name;
    return h(React.Fragment, null,
      scene,
      h(Controls, { sel: sel, onOpen: function () { show('open'); }, onPast: function () { show('past'); }, onSchedules: function () { show('schedules'); }, onHooks: function () { show('hooks'); }, onChanges: changes }),
      d === 'open' ? h(OpenDialog, { recent: info.recent || [], templates: info.templates || [], onTemplates: refresh, onClose: close }) : null,
      d === 'past' ? h(PastDialog, { onClose: close, onChanges: changes }) : null,
      d === 'schedules' ? h(SchedulesDialog, { recent: info.recent, onInfo: setInfo, onClose: close }) : null,
      d === 'changes' ? h(ChangesDialog, { uid: dlg.uid, name: dlg.label, ended: dlg.ended, onClose: close }) : null,
      d === 'hooks' ? h(HooksDialog, { info: info, onClose: close }) : null);
  }

  ReactDOM.createRoot(document.getElementById('office')).render(h(App));
})();
