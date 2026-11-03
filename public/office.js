/* Agent Office for Claude Code x0.1: page script.
   Mounts the DS office, the control strip, and the dialogs (open, past sessions, schedules, changes, hooks). */
(function () {
  'use strict';
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo;
  var TOKEN = document.querySelector('meta[name="office-token"]').content;
  A.strict = true;

  // A repository is a building, a branch is a floor and a worktree is a room. The adapter builds
  // the shown building (officeAdapter.buildingFor) and adds floors and rooms as sessions arrive.

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
  function resetText(at) {
    var m = Math.max(0, Math.round((at - Date.now()) / 60000)), d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60);
    return 'Resets in ' + (d ? d + 'd ' + hr + 'h' : hr ? hr + 'h ' + (m % 60) + 'm' : (m % 60) + 'm');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
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

  // ---------- floors (branches) and rooms (worktrees) ----------
  function FloorsDialog(p) {
    var snap = useSnapshot();
    var repo = snap && (snap.repos || []).filter(function (r) { return r.key === p.repo; })[0];
    var nf = useState(null), form = nf[0], setForm = nf[1];          // new floor: { branch, from }
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];    // { kind: 'floor' | 'room', branch, root }
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    function run(key, path, body, after) {
      setBusy(key); setErr('');
      api(path, Object.assign({ repo: p.repo }, body)).then(function () { setBusy(''); if (after) after(); }, function (x) { setBusy(''); setErr(x.message); });
    }
    if (!repo) {
      return h(A.Dialog, { open: true, title: 'Floors and rooms', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
        h(A.EmptyState, { icon: 'floor', title: 'No repository here', text: 'Folders outside git have no branches. Open a session in a git repository to get floors.' }));
    }
    var floors = {}, order = [];
    repo.worktrees.forEach(function (w) { if (!floors[w.branch]) { floors[w.branch] = []; order.push(w.branch); } floors[w.branch].push(w); });
    var main = repo.worktrees.filter(function (w) { return w.main; })[0];

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
            ? 'Deletes the branch ' + confirm.branch + ' and removes its rooms (worktree folders). Git refuses when the branch has commits that are not merged.'
            : 'Deletes the folder ' + confirm.root + '. The branch ' + confirm.branch + ' and its floor stay.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }

    var branches = order.map(function (b) { return { value: b, label: b }; });
    return h(A.Dialog, { open: true, title: 'Floors and rooms in ' + repo.name, onClose: p.onClose, actions: [
      h(A.Button, { key: 'n', variant: 'quiet', icon: 'add', disabled: !!form, onClick: function () { setErr(''); setForm({ branch: '', from: main ? main.branch : '' }); } }, 'New floor'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'A floor is a branch. A room is a worktree: a folder with that branch checked out. A floor can have more than one room. Two rooms on one floor share the branch, so a commit in one moves the other.'),
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        form ? h('div', { className: 'past-row' },
          h('div', { className: 'form' },
            Pair(
              h(A.TextInput, { id: 'f-branch', label: 'Branch name', value: form.branch, placeholder: 'feature/login', onChange: function (v) { setForm(Object.assign({}, form, { branch: v })); } }),
              h(A.Select, { id: 'f-from', label: 'Start from', options: branches, value: form.from, onChange: function (v) { setForm(Object.assign({}, form, { from: v })); } })),
            h('div', { className: 'inline-actions' },
              h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'new', disabled: !form.branch.trim(), onClick: function () { run('new', '/api/floor/create', { branch: form.branch.trim(), from: form.from }, function () { setForm(null); }); } }, 'Create floor and room'),
              h(A.Button, { variant: 'quiet', onClick: function () { setForm(null); setErr(''); } }, 'Cancel')))) : null,
        h('ul', { className: 'past' }, order.map(function (b) {
          var rooms = floors[b], hasMain = rooms.some(function (w) { return w.main; });
          return h('li', { key: b, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h(A.Icon, { name: 'floor', size: 16 }), h('b', null, b), hasMain ? h(Tag, null, 'main folder') : null),
              rooms.map(function (w) {
                return h('div', { key: w.root, className: 'room-row' },
                  h(A.Icon, { name: 'room', size: 14 }), h('span', { className: 'past-sub mono' }, w.root),
                  w.main ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'room', branch: b, root: w.root }); } }, 'Remove room'));
              })),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'add', loading: busy === 'room:' + b, onClick: function () { run('room:' + b, '/api/room/create', { branch: b }); } }, 'Add room'),
              hasMain ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'floor', branch: b }); } }, 'Delete floor')));
        })),
        h(FloorsWithoutRooms, { repo: p.repo, busy: busy, run: run, shown: order })));
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
  var SCOPES = [{ value: 'local', label: 'This folder only (local)' }, { value: 'project', label: 'Shared in the repository (project)' }];
  function ExtensionsDialog(p) {
    var tb = useState('connectors'), tab = tb[0], setTab = tb[1];
    var dt = useState(null), data = dt[0], setData = dt[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var nt = useState(''), note = nt[0], setNote = nt[1];
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var ad = useState(null), add = ad[0], setAdd = ad[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    function load() { setErr(''); api('/api/ext/list', { uid: p.uid }).then(setData, function (x) { setErr(x.message); setData({ servers: null, plugins: [] }); }); }
    useEffect(load, [p.uid]);
    function act(key, body, done) {
      setBusy(key); setErr(''); setNote('');
      api('/api/ext', Object.assign({ uid: p.uid }, body)).then(function (r) {
        setBusy(''); if (r.restart) setNote('Saved. New sessions in this folder get the change. Close and reopen this session to use it now.');
        if (done) done(); load();
      }, function (x) { setBusy(''); setErr(x.message); });
    }
    if (confirm) {
      return h(A.Dialog, { open: true, title: confirm.title, onClose: function () { setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'confirm', onClick: function () { act('confirm', confirm.body, function () { setConfirm(null); }); } }, confirm.button)] },
        h('div', { className: 'form' }, h('p', { className: 'note' }, confirm.text), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    var servers = data && data.servers, plugins = (data && data.plugins) || [];
    var persistent = function (scope) { return scope === 'local' || scope === 'project'; };

    var connectors = h('div', { className: 'form' },
      data && !data.live ? h('p', { className: 'note' }, 'This session runs in a terminal. Turn connectors on and off there with /mcp. You can still add and remove them for this folder.') : null,
      add && add.kind === 'mcp' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-name', label: 'Name', value: add.name, placeholder: 'sentry', onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } }),
          h(A.Select, { id: 'x-scope', label: 'Save for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h(A.TextInput, { id: 'x-target', label: 'URL or command', value: add.target, placeholder: 'https://mcp.sentry.dev/mcp  or  npx -y @scope/server', hint: 'A URL adds an HTTP connector. A command adds a local one that the session starts.', onChange: function (v) { setAdd(Object.assign({}, add, { target: v })); } }),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.name.trim() || !add.target.trim(), onClick: function () { act('add', { action: 'mcp-add', name: add.name.trim(), target: add.target.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Add connector'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      h(Busy, { on: !data }),
      servers && !servers.length ? h(A.EmptyState, { icon: 'connector', compact: true, title: 'No connectors', text: 'Add one to give the session more tools.' }) : null,
      h('ul', { className: 'past' }, (servers || []).map(function (m) {
        var w = MCP_WORD[m.status] || ['resting', m.status], off = m.status === 'disabled';
        return h('li', { key: m.name, className: 'past-row' },
          h('div', { className: 'past-main' },
            h('div', { className: 'past-title' }, h(A.StatusDot, { status: w[0] }), h('b', null, m.name), h(Tag, null, w[1]), h(Tag, null, m.source === 'plugin' ? 'plugin' : m.scope)),
            m.error ? h('div', { className: 'past-snip' }, m.error) : null),
          h('div', { className: 'past-actions' },
            h(A.Button, { variant: off ? 'primary' : 'quiet', icon: off ? 'resume' : 'pause', loading: busy === 't:' + m.name, onClick: function () { act('t:' + m.name, { action: 'toggle', name: m.name, enabled: off }); } }, off ? 'Turn on' : 'Turn off'),
            m.status === 'failed' ? h(A.Button, { variant: 'quiet', icon: 'retry', loading: busy === 'r:' + m.name, onClick: function () { act('r:' + m.name, { action: 'reconnect', name: m.name }); } }, 'Reconnect') : null,
            persistent(m.scope) ? h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setConfirm({ title: 'Remove the connector ' + m.name, text: 'Removes ' + m.name + ' from the ' + m.scope + ' settings of this folder. Other folders keep their own settings.', button: 'Remove connector', body: { action: 'mcp-remove', name: m.name, scope: m.scope } }); } }, 'Remove') : null));
      })),
      servers && servers.length ? h('p', { className: 'note' }, 'Turn off and Turn on change this session only. User and claude.ai connectors are managed in Claude Code (/mcp) or on claude.ai.') : null);

    var pluginList = h('div', { className: 'form' },
      add && add.kind === 'plugin' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-pid', label: 'Plugin', value: add.id, placeholder: 'name@marketplace', onChange: function (v) { setAdd(Object.assign({}, add, { id: v })); } }),
          h(A.Select, { id: 'x-pscope', label: 'Install for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.id.trim(), onClick: function () { act('add', { action: 'plugin-install', id: add.id.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Install plugin'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      h(Busy, { on: !data }),
      data && !plugins.length ? h(A.EmptyState, { icon: 'skill', compact: true, title: 'No plugins', text: 'Install one from a marketplace.' }) : null,
      h('ul', { className: 'past' }, plugins.map(function (pl) {
        return h('li', { key: pl.id + pl.scope, className: 'past-row' },
          h('div', { className: 'past-main' },
            h('div', { className: 'past-title' }, h(A.StatusDot, { status: pl.enabled ? 'finished' : 'resting' }), h('b', null, pl.id), h(Tag, null, pl.enabled ? 'On' : 'Off'), h(Tag, null, pl.scope)),
            h('div', { className: 'past-meta mono' }, 'Version ' + pl.version)),
          h('div', { className: 'past-actions' },
            h(A.Button, { variant: pl.enabled ? 'quiet' : 'primary', icon: pl.enabled ? 'pause' : 'resume', loading: busy === 'p:' + pl.id, onClick: function () { act('p:' + pl.id, { action: pl.enabled ? 'plugin-disable' : 'plugin-enable', id: pl.id, scope: 'local' }); } }, pl.enabled ? 'Turn off here' : 'Turn on here'),
            persistent(pl.scope) ? h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setConfirm({ title: 'Remove the plugin ' + pl.id, text: 'Uninstalls ' + pl.id + ' from the ' + pl.scope + ' scope of this folder.', button: 'Remove plugin', body: { action: 'plugin-uninstall', id: pl.id, scope: pl.scope } }); } }, 'Remove') : null));
      })),
      h('p', { className: 'note' }, 'Turn on here and Turn off here save a local setting for this folder only. The session reloads its plugins at once.'));

    return h(A.Dialog, { open: true, title: 'Extensions for ' + p.name, onClose: p.onClose, actions: [
      h(A.Button, { key: 'a', variant: 'quiet', icon: 'add', disabled: !!add, onClick: function () { setErr(''); setAdd(tab === 'plugins' ? { kind: 'plugin', id: '', scope: 'local' } : { kind: 'mcp', name: '', target: '', scope: 'local' }); } }, tab === 'plugins' ? 'Install plugin' : 'Add connector'),
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: load }, 'Refresh'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        data && data.folder ? h('p', { className: 'note mono' }, data.folder) : null,
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        note ? h('p', { className: 'note', role: 'status' }, note) : null,
        h(A.Tabs, { value: tab, onChange: function (v) { setTab(v); setAdd(null); }, label: 'Extension types',
          tabs: [{ id: 'connectors', label: 'Connectors', icon: 'connector', count: servers ? servers.length : undefined }, { id: 'plugins', label: 'Plugins', icon: 'skill', count: plugins.length }],
          render: function (id) { return id === 'plugins' ? pluginList : connectors; } })));
  }
  // A button in the chat header of the open bot. The DS draws the chat, so the page adds it with a portal.
  function ChatHeaderButton(p) {
    var st = useState(null), host = st[0], setHost = st[1];
    useEffect(function () {
      var raf = 0;
      function find() {
        raf = 0;
        var head = document.querySelector('.ao-hud-chat .ao-chat-h');
        var slot = head && head.querySelector('.ao-chat-ext');
        if (head && !slot) { slot = document.createElement('span'); slot.className = 'ao-chat-ext'; head.appendChild(slot); }
        setHost(function (prev) { return prev === slot ? prev : slot; });
      }
      var mo = new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(find); });
      mo.observe(document.body, { childList: true, subtree: true });
      find();
      return function () { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, []);
    if (!host || !p.sess) return null;
    return ReactDOM.createPortal(h(A.Button, { variant: 'ghost', icon: 'connector', title: 'Connectors and plugins of ' + p.sess.name, onClick: p.onOpen }, 'Extensions'), host);
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
    // Requests wait in a building that is not shown: offer the way there.
    var elsewhere = p.buildings.filter(function (b) { return b.key !== p.shown && b.waiting; })[0];

    return h(React.Fragment, null,
      snap && !live.length ? h('div', { className: 'welcome' }, h(A.EmptyState, { icon: 'building', title: 'No sessions yet', text: 'Open a session to seat the first bot. You can also reopen a past one.', action: { label: 'Open session', icon: 'add', onClick: p.onOpen } })) : null,
      h('div', { className: 'strip', role: 'toolbar', 'aria-label': 'Office controls' },
        h('div', { className: 'strip-group' },
          h(A.Button, { variant: 'primary', icon: 'add', onClick: p.onOpen }, 'Open session'),
          h(A.Button, { variant: 'quiet', icon: 'session', onClick: p.onPast }, 'Past'),
          h(A.Button, { variant: 'quiet', icon: 'schedule', onClick: p.onSchedules }, 'Schedules'),
          h(A.Button, { variant: 'quiet', icon: 'terminal', onClick: p.onHooks }, 'Hooks'),
          p.shown ? h(A.Button, { variant: 'quiet', icon: 'floor', onClick: p.onFloors }, 'Floors') : null,
          p.buildings.length > 1 || (p.buildings.length && p.buildings[0].key !== p.shown)
            ? h(A.Select, { id: 'c-building', ariaLabel: 'Building (repository)', value: p.shown, onChange: p.onBuilding,
                options: p.buildings.map(function (b) { return { value: b.key, label: b.name + ' · ' + plural(b.sessions, 'session', 'sessions') + (b.waiting ? ' · ' + b.waiting + ' need you' : '') }; })
                  .concat(p.buildings.some(function (b) { return b.key === p.shown; }) ? [] : [{ value: p.shown, label: (p.shownName || 'This building') + ' · no sessions' }]) })
            : null,
          elsewhere ? h(A.Button, { variant: 'emphasis', icon: 'waiting', onClick: function () { p.onBuilding(elsewhere.key); } }, plural(elsewhere.waiting, 'request', 'requests') + ' in ' + elsewhere.name) : null,
          live.length ? h('span', { className: 'strip-total mono' }, live.length + ' open · ' + money(total)) : null),
        sess ? h('div', { className: 'strip-group strip-bot' },
          h('span', { className: 'strip-id' }, h(A.StatusDot, { status: statusOf(sess) }), h('b', null, sess.name), ctxPct != null ? h('span', { className: 'mono' }, 'context ' + ctxPct + '%') : null),
          sess.headless && (usage || sess.cost) ? h(A.CostMeter, { tokens: usage ? usage.tokens : 0, cost: sess.cost || 0, cached: usage && usage.input ? usage.cached / usage.input : undefined }) : null,
          sess.headless ? h(A.Select, { id: 'c-model', ariaLabel: 'Model of ' + sess.name, options: modelOpts, value: sess.model || '', onChange: function (v) { ctl('model', v); } }) : null,
          sess.headless ? h(A.Select, { id: 'c-mode', ariaLabel: 'Permissions of ' + sess.name, options: modeOpts, value: sess.mode || '', onChange: function (v) { ctl('mode', v); } }) : null,
          sess.headless ? h(A.Button, { variant: 'quiet', icon: 'pause', disabled: !working, onClick: stopTurn }, 'Stop turn') : null,
          h(A.Button, { variant: 'quiet', icon: 'trace', onClick: function () { p.onChanges(sess.uid, sess.name); } }, 'Changes'),
          h(A.Button, { variant: 'quiet', icon: 'connector', onClick: function () { p.onExtensions(sess.uid, sess.name); } }, 'Extensions'),
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
    // Which building (repository) the scene shows. The choice is kept in the browser.
    var snap = useSnapshot();
    var cs = useState(function () { try { return localStorage.getItem('ao-building'); } catch (x) { return null; } }), cur = cs[0], setCur = cs[1];
    function pick(key) { setCur(key); try { localStorage.setItem('ao-building', key); } catch (x) { /* private window */ } }
    var list = snap ? window.officeAdapter.buildings(snap) : [];
    var hasCur = list.some(function (b) { return b.key === cur; });
    // Show the chosen building while it has sessions; when it empties, go where the work is.
    var shown = hasCur || (!list.length && cur != null) ? cur : (list.length ? list[0].key : '');
    var now = snap ? window.officeAdapter.roomsNow(snap, shown) : {};
    var ep = useState(0), epoch = ep[0], setEpoch = ep[1];
    // The DS has no event that removes a floor or a room, so a removal rebuilds the scene.
    var gone = !!snap && window.officeAdapter.shown() === shown && window.officeAdapter.roomsShown().some(function (k) { return !now[k]; });
    useEffect(function () { if (gone) setEpoch(function (e) { return e + 1; }); }, [gone]);
    var sceneKey = shown + ':' + epoch + (Object.keys(now).length ? '' : ':empty');
    var first = React.useRef(true);
    // The scene mounts once per building. Re-rendering the page must not rebuild it.
    var def = useMemo(function () { return snap ? window.officeAdapter.buildingFor(shown) : null; }, [snap ? sceneKey : null]);
    var intro = useMemo(function () { var i = first.current; if (def) first.current = false; return i; }, [def]);
    var week = snap && snap.plan && snap.plan.week;
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-plan', !!week); }, [!!week]);
    var scene = def ? h(A.OfficeScene, { key: sceneKey, building: def, adapter: window.officeAdapter, height: window.innerHeight, quality: 'auto', intro: intro, editable: false, simulate: false, reset: week ? resetText(week.resetsAt) : undefined }) : null;
    function close() { setDlg(null); }
    function extensions(uid, name) { setDlg({ name: 'ext', uid: uid, label: name }); }
    var selSess = sel ? window.officeAdapter.session(sel) : null;
    var d = dlg && dlg.name;
    return h(React.Fragment, null,
      scene,
      h(Controls, { sel: sel, buildings: list, shown: shown, shownName: def && def.name, onBuilding: pick, onFloors: function () { setDlg({ name: 'floors' }); }, onExtensions: extensions, onOpen: function () { show('open'); }, onPast: function () { show('past'); }, onSchedules: function () { show('schedules'); }, onHooks: function () { show('hooks'); }, onChanges: changes }),
      d === 'open' ? h(OpenDialog, { recent: info.recent || [], templates: info.templates || [], onTemplates: refresh, onClose: close }) : null,
      d === 'past' ? h(PastDialog, { onClose: close, onChanges: changes }) : null,
      d === 'schedules' ? h(SchedulesDialog, { recent: info.recent, onInfo: setInfo, onClose: close }) : null,
      d === 'changes' ? h(ChangesDialog, { uid: dlg.uid, name: dlg.label, ended: dlg.ended, onClose: close }) : null,
      d === 'hooks' ? h(HooksDialog, { info: info, onClose: close }) : null,
      d === 'floors' ? h(FloorsDialog, { repo: shown, onClose: close }) : null,
      d === 'ext' ? h(ExtensionsDialog, { uid: dlg.uid, name: dlg.label, onClose: close }) : null,
      h(ChatHeaderButton, { sess: selSess, onOpen: function () { extensions(selSess.uid, selSess.name); } }));
  }

  ReactDOM.createRoot(document.getElementById('office')).render(h(App));
})();
