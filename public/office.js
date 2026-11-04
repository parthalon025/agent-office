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
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'The office could not do that (' + r.status + ').'); e.status = r.status; e.body = j; throw e; } return j; }); });
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
  // BotAvatar draws an SVG with a fill colour, so it needs the token's value, not var(...).
  function botColor() {
    var el = document.querySelector('.ao-office') || document.documentElement;
    return getComputedStyle(el).getPropertyValue('--type-lab').trim() || getComputedStyle(el).getPropertyValue('--muted').trim();
  }
  function cssMs(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
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
    function forget(uid) { act(uid, function () { return api('/api/history/forget', { uid: uid }).then(function () { if (p.toast) p.toast({ tone: 'info', title: 'Session forgotten', text: 'It is gone from Past sessions.' }); load(); }); }); }
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
      api('/api/schedule/save', Object.assign({}, edit, { every: Number(edit.every) || 60, maxBudget: Number(edit.maxBudget) || 0 })).then(function () { if (p.toast) p.toast({ tone: 'success', title: edit.id ? 'Schedule saved' : 'Schedule added', text: edit.name || cadence(edit) }); setEdit(null); setErr(''); load(); }, function (x) { setErr(x.message); });
    }
    function run(id) { api('/api/schedule/run', { id: id }).then(function () { setErr(''); }, function (x) { setErr(x.message); }); }
    function del(id) { api('/api/schedule/delete', { id: id }).then(function () { if (p.toast) p.toast({ tone: 'info', title: 'Schedule deleted', text: 'It will not run again.' }); load(); }, function (x) { setErr(x.message); }); }
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
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h(Busy, { on: list === null }),
        list && !list.length ? h(A.EmptyState, { icon: 'schedule', title: 'No schedules yet', text: 'A schedule opens a session on its own and runs one instruction.' }) : null,
        list ? h(A.AddButton, { label: 'Add a schedule', onClick: function () { setEdit(Object.assign({}, BLANK, { cwd: (p.recent || [])[0] || '' })); } }) : null,
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
    function run(fn) {
      setBusy(true); setErr('');
      fn().then(function (r) {
        setBusy(false); setConfirm(null); setResult(r); load();
        if (p.toast && r && r.url) p.toast({ tone: 'success', title: 'Pull request created', text: r.url });
        if (p.toast && r && r.removed) p.toast({ tone: 'info', title: 'Worktree removed', text: r.branchKept ? 'The branch was kept.' : 'The folder is gone.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
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
        data && data.commits && data.commits.length ? h('h3', { className: 'ext-h' }, 'Recent commits on ' + (data.branch || 'this branch'), h('span', { className: 'ext-n' }, data.commits.length)) : null,
        data && data.commits && data.commits.length ? h(A.CheckpointTimeline, { checkpoints: data.commits }) : null,
        data && data.truncated ? h('p', { className: 'note' }, 'The diff is long, so only the start is shown.') : null,
        data && !data.diff && data.files.length ? h('p', { className: 'note' }, 'These files are new, so git has no diff for them yet.') : null,
        data && !data.files.length && !err ? h(A.EmptyState, { icon: 'checkpoint', compact: true, title: 'Nothing changed yet', text: 'Changes show here as the session edits files.' }) : null));
  }

  // ---------- hooks ----------
  function HooksDialog(p) {
    var i = p.info || {};
    var live = p.snap ? p.snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    var channels = [
      { id: 'office', name: 'Office sessions', route: 'Opened from this page', today: live.filter(function (s) { return s.headless && !s.scheduleId; }).length },
      { id: 'schedule', name: 'Schedules', route: 'Open an office session on time', today: live.filter(function (s) { return s.scheduleId; }).length },
      { id: 'terminal', name: 'Terminal sessions', route: (i.hooksMode || 'command') + ' hooks', today: live.filter(function (s) { return !s.headless; }).length }];
    return h(A.Dialog, { open: true, title: 'Attach other sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form' },
        h('h3', { className: 'ext-h' }, 'Where sessions come from'),
        h(A.ChannelList, { channels: channels }),
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
    var DONE = { '/api/floor/create': ['success', 'Floor added', function (b) { return 'Branch ' + b.branch + ' with its first room.'; }],
      '/api/floor/delete': ['info', 'Floor deleted', function (b) { return 'Branch ' + b.branch + ' and its rooms are gone.'; }],
      '/api/room/create': ['success', 'Room added', function (b) { return 'A new worktree on ' + b.branch + '.'; }],
      '/api/room/delete': ['info', 'Room removed', function (b) { return 'The folder ' + String(b.root).split(/[\\/]/).pop() + ' is gone. Its branch stays.'; }] };
    function run(key, path, body, after) {
      setBusy(key); setErr('');
      api(path, Object.assign({ repo: p.repo }, body)).then(function () {
        setBusy(''); if (after) after();
        var t = DONE[path]; if (t && p.toast) p.toast({ tone: t[0], title: t[1], text: t[2](body) });
      }, function (x) { setBusy(''); setErr(x.message); });
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
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'A floor is a branch. A room is a worktree: a folder with the branch checked out. A floor can have more than one room. Its rooms share the branch, so a commit in one room shows in the others.'),
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
                var here = (snap ? snap.sessions : []).filter(function (s) { return s.status !== 'ended' && s.place && s.place.rootKey === w.place.rootKey; });
                return h('div', { key: w.root, className: 'room-row' },
                  h(A.OfficeTypeBadge, { type: 'lab', label: w.root.split(/[\\/]/).pop() }), h('span', { className: 'past-sub mono', title: w.root }, w.root),
                  here.map(function (s) { return h('span', { key: s.uid, className: 'room-bot', title: s.name }, h(A.BotAvatar, { shape: window.officeAdapter.shapeOf(s.uid), color: botColor(), status: statusOf(s), size: 20 }), s.name); }),
                  w.main ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'room', branch: b, root: w.root }); } }, 'Remove room'));
              })),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'add', loading: busy === 'room:' + b, onClick: function () { run('room:' + b, '/api/room/create', { branch: b }); } }, 'Add room'),
              hasMain ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'floor', branch: b }); } }, 'Delete floor')));
        })),
        form ? null : h(A.AddButton, { label: 'Add a floor', onClick: function () { setErr(''); setForm({ branch: '', from: main ? main.branch : '' }); } }),
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
    var plugins = ((data && data.plugins) || []).filter(function (pl) { if (seenPl[pl.id]) return false; seenPl[pl.id] = true; return true; });
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
                own ? null : h(A.Button, { variant: off ? 'primary' : 'quiet', icon: off ? 'resume' : 'pause', disabled: !data.live, loading: busy === 't:' + m.name, onClick: function () { act('t:' + m.name, { action: 'toggle', name: m.name, enabled: off }); } }, off ? 'Turn on' : 'Turn off'),
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
      data && !plugins.length ? h(A.EmptyState, { icon: 'skill', compact: true, title: 'No plugins', text: 'Install one from a marketplace.' }) : null,
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
                h(A.Button, { variant: pl.enabled ? 'quiet' : 'primary', icon: pl.enabled ? 'pause' : 'resume', loading: busy === 'p:' + pl.id, onClick: function () { act('p:' + pl.id, { action: pl.enabled ? 'plugin-disable' : 'plugin-enable', id: pl.id, scope: 'local' }); } }, pl.enabled ? 'Turn off' : 'Turn on'),
                persistent(pl.scope) ? h(A.Button, { variant: 'ghost', icon: 'remove', title: 'Remove ' + name, onClick: function () { setConfirm({ title: 'Remove the plugin ' + name, text: 'Uninstalls ' + pl.id + ' from the ' + pl.scope + ' scope of this folder.', button: 'Remove plugin', body: { action: 'plugin-uninstall', id: pl.id, scope: pl.scope } }); } }, 'Remove') : null));
          })));
      }),
      h('p', { className: 'note' }, 'Turn on and Turn off save a setting for this folder only. The session reloads its plugins at once.'));

    return h(A.Dialog, { open: true, title: 'Extensions for ' + p.name, onClose: p.onClose, actions: [
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

  // ---------- all sessions: registry and subagents ----------
  function accessOf(s) { return s.mode === 'bypassPermissions' || s.mode === 'acceptEdits' || s.mode === 'auto' ? 'broad' : 'scoped'; }
  function SessionsDialog(p) {
    var snap = useSnapshot();
    var live = snap ? snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    var agents = live.map(function (s) {
      var tools = {};
      (s.calls || []).forEach(function (c) { tools[c.name] = true; });
      return { name: s.name, shape: window.officeAdapter.shapeOf(s.uid), color: botColor(), status: statusOf(s), platform: s.headless ? 'Office session' : 'Terminal session',
        identity: (s.git ? s.git.branch + ' · ' : '') + (String(s.cwd || '').split(/[\/]/).pop() || ''), model: s.model || 'default', tools: Object.keys(tools), access: accessOf(s), last: ago(s.lastEvent) };
    });
    var teams = live.filter(function (s) { return (s.agents || []).some(function (a) { return !a.done; }); });
    return h(A.Dialog, { open: true, title: 'All sessions', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'Every open session in every building. Broad access means the session can edit files without asking (Accept edits or a bypass mode).'),
        !agents.length ? h(A.EmptyState, { icon: 'session', compact: true, title: 'No open sessions', text: 'Open a session to see it here.' }) : h('div', { className: 'table-wrap' }, h(A.AgentRegistry, { agents: agents })),
        teams.length ? h('h3', { className: 'ext-h' }, 'Subagents at work', h('span', { className: 'ext-n' }, teams.length)) : null,
        teams.map(function (s) {
          var kids = s.agents.filter(function (a) { return !a.done; }).map(function (a) { return { name: a.type, shape: 'blob', status: 'working', task: a.task, ephemeral: true }; });
          return h(A.DelegationTree, { key: s.uid, max: Math.max(3, kids.length), tree: { name: s.name, shape: window.officeAdapter.shapeOf(s.uid), status: statusOf(s), task: s.prompt ? clip(s.prompt, 80) : '', children: kids }, onSelect: function () { p.onGo(s); } });
        })));
  }

  // ---------- the city: every repository as a building ----------
  function cityData(snap) {
    return window.officeAdapter.buildings(snap).map(function (b) {
      var def = window.officeAdapter.preview(b.key, snap), bots = [];
      def.floors.forEach(function (f) { f.rooms.forEach(function (r) { (r.bots || []).forEach(function (x) { bots.push({ name: x.name, status: x.status, floor: f.name }); }); }); });
      return { key: b.key, name: b.name, sessions: b.sessions, waiting: b.waiting, floors: def.floors.map(function (f) { return { name: f.name, key: f.key }; }), bots: bots };
    });
  }
  function CityView(p) {
    var snap = useSnapshot();
    var ref = React.useRef(null), city = React.useRef(null), fitted = React.useRef(false);
    var hv = useState(null), hov = hv[0], setHov = hv[1];
    var list = snap ? cityData(snap) : [];
    useEffect(function () {
      if (!window.OfficeCity) return undefined;
      city.current = window.OfficeCity.mount(ref.current, { root: document.documentElement, onHover: setHov, onPick: function (d) { p.onEnter(d.key, city.current); } });
      return function () { if (city.current) city.current.dispose(); city.current = null; };
    }, []);
    useEffect(function () {
      if (!city.current || !snap) return;
      city.current.update(list);
      if (!fitted.current) { fitted.current = true; city.current.fit(true); }
    }, [snap]);
    var waiting = list.reduce(function (n, b) { return n + b.waiting; }, 0);
    return h('div', { className: 'city' },
      h('div', { ref: ref, className: 'city-scene' }),
      h('div', { className: 'city-hud' },
        h(A.Panel, { title: 'City', count: plural(list.length, 'building', 'buildings') },
          h('p', { className: 'note' }, 'Each building is a repository. Each floor is a branch. Click a building, or zoom in on it, to go inside. In a building, zoom out to come back.'),
          !list.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a git repository to add its building.' }) : null,
          h('ul', { className: 'city-list' }, list.map(function (b) {
            return h('li', { key: b.key },
              h('button', { type: 'button', className: 'city-row' + (b.key === p.shown ? ' is-shown' : '') + (hov && hov.key === b.key ? ' is-hover' : ''), onClick: function () { p.onEnter(b.key, city.current); } },
                h(A.StatusDot, { status: b.waiting ? 'waiting' : b.sessions ? 'working' : 'resting' }),
                h('span', { className: 'city-name' }, b.name),
                h('span', { className: 'city-sub mono' }, plural(b.floors.length, 'floor', 'floors') + ' · ' + b.sessions),
                b.waiting ? h('span', { className: 'city-wait' }, b.waiting + ' need you') : null));
          })),
          waiting ? h('p', { className: 'note' }, plural(waiting, 'request waits', 'requests wait') + '. Buildings with a request show a beacon.') : null)),
      hov ? h('div', { className: 'city-tag', role: 'status' }, h('b', null, hov.name), ' · ' + plural(hov.floors.length, 'floor', 'floors') + ' · ' + plural(hov.sessions, 'session', 'sessions') + (hov.waiting ? ' · ' + hov.waiting + ' need you' : '')) : null,
      h('div', { className: 'city-zoom', role: 'toolbar', 'aria-label': 'City zoom' },
        h(A.Button, { variant: 'quiet', icon: 'zoom-in', title: 'Zoom in', onClick: function () { if (city.current) city.current.zoomBy(1.35); } }, 'Zoom in'),
        h(A.Button, { variant: 'quiet', icon: 'zoom-out', title: 'Zoom out', onClick: function () { if (city.current) city.current.zoomBy(1 / 1.35); } }, 'Zoom out'),
        h(A.Button, { variant: 'quiet', icon: 'building', onClick: function () { if (city.current) city.current.fit(false); } }, 'Show all')));
  }

  // A side panel sits above the control strip: its bottom edge is the measured strip height.
  function clearStyle(v) { return v ? { bottom: v + 'px' } : undefined; }

  // ---------- the room board, read up close ----------
  function BoardPanel(p) {
    var d = p.data;
    if (!d) return null;
    var word = window.OfficeVocab.toolShort;
    var call = function (c, kind) { return h(A.ToolCall, { key: c.id, call: { id: c.id, tool: word(c.name), kind: kind || 'api', ok: c.ok === null ? undefined : c.ok, ms: c.ms == null ? undefined : c.ms, args: c.detail ? { target: c.detail } : undefined, summary: c.err || (c.who ? 'by ' + c.who : undefined) } }); };
    return h('aside', { className: 'board-panel', style: clearStyle(p.clear), 'aria-label': 'Board of ' + d.room },
      h(A.Panel, { title: d.room + (d.branch ? ' · ' + d.branch : ''), count: plural(d.sessions.length, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
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
    var info = window.officeAdapter.roomInfo(p.roomId, snap || undefined);
    var v = window.officeAdapter.figures(p.roomId, snap || undefined);
    var row = function (k, val) { return h('li', { key: k }, h('span', null, k), h('b', { className: 'mono' }, val)); };
    return h('aside', { className: 'board-panel', style: clearStyle(p.clear), 'aria-label': 'Stats of ' + ((info.place && info.place.roomName) || 'this room') },
      h(A.Panel, { title: ((info.place && info.place.roomName) || 'Room') + ' · stats', count: plural(v.sessions, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
          h('ul', { className: 'stats-list' },
            row('Working', String(v.working)), row('Needs you', String(v.waiting)), row('Tool calls', String(v.toolCalls)),
            row('Tokens', String(v.tokens)), row('Cost', money(v.cost)), row('To do done', v.todosDone + ' of ' + v.todosTotal),
            row('Last event', v.lastEvent ? ago(v.lastEvent) : 'none')))));
  }

  // The notes board, written on in place: a text box laid exactly over the board on screen.
  function NotesEditor(p) {
    var tx = useState(p.text || ''), text = tx[0], setText = tx[1];
    var rc = useState(null), rect = rc[0], setRect = rc[1];
    var sv = useState('saved'), state = sv[0], setState = sv[1];
    var ref = React.useRef(null), timer = React.useRef(0);
    var base = React.useRef(p.version || 0), latest = React.useRef(p.text || ''), fromSent = React.useRef(false);
    var edits = React.useRef(0), inflight = React.useRef(false), queued = React.useRef(null);
    useEffect(function () {
      var raf = 0;
      function follow() { var r = p.rect(); if (r) setRect(function (o) { return o && Math.abs(o.left - r.left) < 0.5 && Math.abs(o.top - r.top) < 0.5 && Math.abs(o.width - r.width) < 0.5 ? o : r; }); raf = requestAnimationFrame(follow); }
      follow();
      return function () { cancelAnimationFrame(raf); };
    }, []);
    // Closing the editor sends the last edit at once, not drops it.
    useEffect(function () { return function () { if (timer.current) { clearTimeout(timer.current); timer.current = 0; save(latest.current); } }; }, []);
    useEffect(function () { if (rect && !p.flying() && ref.current && document.activeElement !== ref.current) ref.current.focus(); }, [rect && Math.round(rect.width)]);
    // An idle editor takes a change that came from outside (an agent added a line).
    useEffect(function () {
      var ver = p.version || 0;
      if (state !== 'saved' || ver <= base.current) return;   // a save is pending, or this is our own save or an older snapshot
      base.current = ver; fromSent.current = false;
      if ((p.text || '') !== latest.current) { latest.current = p.text || ''; setText(latest.current); }
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
          else { fromSent.current = false; latest.current = res.text; setText(res.text); }
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
    var fs = Math.max(12, rect.height / 14);
    return h('div', { className: 'notes-edit', style: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } },
      h('textarea', { ref: ref, className: 'notes-text', 'aria-label': 'Notes for this room', value: text, maxLength: 4000, placeholder: 'Write a reminder for this room.', style: { fontSize: fs + 'px' }, onChange: function (e) { change(e.target.value); },
        onKeyDown: function (e) { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } } }),
      h('div', { className: 'notes-bar' },
        h('span', { className: 'notes-state', role: 'status' }, state === 'saving' ? 'Saving' : state === 'error' ? 'Not saved' : 'Saved'),
        h(A.Button, { variant: 'quiet', icon: 'approve', onClick: p.onClose }, 'Done')));
  }

  // ---------- room helpers ----------
  function modelWord(m) {
    if (!m) return 'Default model';
    var hit = MODELS.filter(function (o) { return o.value && m.indexOf(o.value) === 0; })[0] || MODELS.filter(function (o) { return o.value && m.toLowerCase().indexOf(o.label.toLowerCase()) >= 0; })[0];
    return hit ? hit.label : m;
  }

  // ---------- the agents in one room ----------
  function RoomDialog(p) {
    var snap = useSnapshot();
    var info = window.officeAdapter.roomInfo(p.roomId, snap || undefined);
    var list = info.sessions, place = info.place;
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var ad = useState(null), add = ad[0], setAdd = ad[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var cur = confirm ? list.filter(function (s) { return s.uid === confirm; })[0] : null;
    useEffect(function () { if (confirm && !cur) setConfirm(null); }, [confirm, !!cur]);
    function closeSession() {
      setBusy(true);
      api('/api/close', { uid: cur.uid }).then(function () { setBusy(false); setConfirm(null); p.toast({ tone: 'success', title: cur.name, text: 'Session closed' }); }, function (x) { setBusy(false); setErr(x.message); });
    }
    function addAgent() {
      var cwd = list.length && list[0].cwd ? list[0].cwd : place && place.path;
      if (!cwd) { setErr('This room has no folder yet.'); return; }
      setBusy(true); setErr('');
      api('/api/open', { cwd: cwd, name: add.name.trim(), where: 'office', isolation: 'same', model: add.model, prompt: add.prompt })
        .then(function () { setBusy(false); setAdd(null); p.toast({ tone: 'success', title: 'Office', text: 'Agent added' }); }, function (x) { setBusy(false); setErr(x.message); });
    }
    var title = 'Agents in ' + ((place && place.roomName) || 'this room');
    if (cur) {
      return h(A.Dialog, { key: 'confirm', open: true, title: 'Close ' + cur.name, onClose: function () { setConfirm(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); setErr(''); } }, 'Keep session'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy, onClick: closeSession }, 'Close session')] },
        h('div', { className: 'form' },
          h('p', null, 'This ends the session ' + cur.name + '. Its work in the folder stays.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    return h(A.Dialog, { key: add ? 'add' : 'list', open: true, title: title, onClose: p.onClose, actions: add
      ? [h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAdd(null); setErr(''); } }, 'Cancel'), h(A.Button, { key: 'a', variant: 'primary', icon: 'add', loading: busy, onClick: addAgent }, 'Add agent')]
      : [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form' },
        add ? h(React.Fragment, null,
          h('p', { className: 'note' }, 'The agent runs in the office, in the folder of this room.'),
          Pair(
            h(A.TextInput, { id: 'ra-name', label: 'Name (optional)', value: add.name, placeholder: 'Defaults to the folder name', onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } }),
            h(A.Select, { id: 'ra-model', label: 'Model', options: MODELS, value: add.model, onChange: function (v) { setAdd(Object.assign({}, add, { model: v })); } })),
          h(Area, { id: 'ra-prompt', label: 'First instruction (optional)', value: add.prompt, rows: 4, placeholder: 'Review the open PRs and list what blocks merge.', onChange: function (v) { setAdd(Object.assign({}, add, { prompt: v })); } }),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null)
        : h(React.Fragment, null,
          list.length ? h('ul', { className: 'agent-list' }, list.map(function (s) {
            return h('li', { key: s.uid, className: 'agent-row' },
              h(A.BotAvatar, { shape: window.officeAdapter.shapeOf(s.uid), color: botColor(), status: statusOf(s), size: 28 }),
              h('span', { className: 'agent-who' }, h('b', null, s.name), h('span', { className: 'agent-sub' }, window.OfficeVocab.status(s).word + ' · ' + modelWord(s.model))),
              h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { setErr(''); setConfirm(s.uid); } }, 'Close session'));
          })) : h(A.EmptyState, { icon: 'identity', compact: true, title: 'No agents here', text: 'Add an agent to start work in this room.' }),
          h(A.AddButton, { label: 'Add an agent', onClick: function () { setErr(''); setAdd({ name: '', model: '', prompt: '' }); } }))));
  }

  // ---------- one session as a full terminal ----------
  function TerminalPanel(p) {
    var snap = useSnapshot();
    var s = snap ? snap.sessions.filter(function (x) { return x.uid === p.uid; })[0] : null;
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
    // focus: into the input when the panel opens, back to the opener when it closes
    var opener = React.useRef(null), entered = React.useRef(false);
    useEffect(function () {
      opener.current = document.activeElement;
      return function () { var o = opener.current; if (o && o.isConnected && o.focus) o.focus(); };
    }, []);
    useEffect(function () {
      if (entered.current || !s) return;   // the first render has no snapshot, so no input yet
      entered.current = true;
      var f = document.querySelector('.terminal-panel .term-field') || vw.current;
      if (f && f.focus) f.focus();
    }, [!!s]);
    useEffect(function () {
      function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.ao-dialog')) { e.preventDefault(); p.onClose(); } }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, []);
    var rows = window.OfficeTerminal ? window.OfficeTerminal.lines(s, cols) : [{ text: 'The terminal view is not loaded.', tone: 'muted' }];
    if (s && s.headless && rows.length && rows[rows.length - 1].text === '> ') rows = rows.slice(0, -1);
    useEffect(function () { var v = vw.current; if (v && stick.current) v.scrollTop = v.scrollHeight; });
    function onScroll() { var v = vw.current; if (v) stick.current = v.scrollHeight - v.scrollTop - v.clientHeight < 24; }
    function send() {
      var t = text.trim();
      if (!t || !s || busy) return;
      setBusy(true);
      api('/api/message', { uid: s.uid, text: t }).then(function () { setBusy(false); setText(''); stick.current = true; }, function (x) { setBusy(false); p.toast({ tone: 'error', title: s.name, text: x.message }); });
    }
    function stop() { api('/api/interrupt', { uid: s.uid }).catch(function (x) { p.toast({ tone: 'error', title: s.name, text: x.message }); }); }
    var working = s && (s.status === 'working' || s.status === 'waiting');
    var ended = !s || s.status === 'ended';
    return h('aside', { className: 'terminal-panel', style: clearStyle(p.clear), 'aria-label': 'Terminal of ' + p.name },
      h('div', { className: 'term-head' },
        h(A.StatusDot, { status: s ? statusOf(s) : 'resting' }),
        h('b', { className: 'term-name' }, s ? s.name : p.name),
        h('span', { className: 'term-model mono' }, s ? modelWord(s.model) : ''),
        h(A.Button, { variant: 'quiet', icon: 'chevron-right', onClick: p.onClose }, 'Back')),
      h('div', { className: 'term-view', ref: vw, onScroll: onScroll, role: 'log', 'aria-live': 'off', tabIndex: 0 },
        h('span', { className: 'term-probe', ref: probe, 'aria-hidden': 'true' }, 'MMMMMMMMMM'),
        rows.map(function (r, i) { return h('div', { key: i, className: 'term-line tone-' + r.tone + (r.ask ? ' is-ask' : '') }, r.text || '\u00a0'); })),
      s && s.headless && !ended
        ? h('div', { className: 'term-input' },
            h('span', { className: 'term-caret mono', 'aria-hidden': 'true' }, '>'),
            h('input', { className: 'term-field', type: 'text', value: text, placeholder: 'Message ' + s.name, 'aria-label': 'Message ' + s.name, autoComplete: 'off', spellCheck: false,
              onChange: function (e) { setText(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } } }),
            working ? h(A.Button, { variant: 'quiet', icon: 'pause', onClick: stop }, 'Stop turn') : null)
        : s && !s.headless && !ended ? h('p', { className: 'term-note' }, 'This session runs in its own terminal window. Type there.') : null);
  }

  // ---------- page commands in the DS command palette (Ctrl+K) ----------
  // The HUD builds its palette list with AgentOffice.CommandPalette.actions(); the page adds its own.
  var pageActions = [];
  (function () {
    var base = A.CommandPalette && A.CommandPalette.actions;
    if (!base || base.__page) return;
    var wrapped = function (o) { return base(o).concat(pageActions); };
    wrapped.__page = true;
    A.CommandPalette.actions = wrapped;
  })();

  // ---------- the control strip ----------
  function Tip(p) { return p.text ? h(A.Tooltip, { text: p.text }, p.children) : p.children; }
  function Controls(p) {
    var snap = useSnapshot();
    var sess = p.sel ? window.officeAdapter.session(p.sel) : null;
    var live = snap ? snap.sessions.filter(function (s) { return s.status !== 'ended'; }) : [];
    // spend of the sessions that are open now (closed ones are under Past)
    var total = live.reduce(function (n, s) { return n + (typeof s.cost === 'number' ? s.cost : 0); }, 0);
    function fail(x) { p.toast({ tone: 'error', title: sess ? sess.name : 'Office', text: x.message }); }
    function ctl(action, value) { api('/api/control', { uid: sess.uid, action: action, value: value }).catch(fail); }
    function stopTurn() { api('/api/interrupt', { uid: sess.uid }).catch(fail); }
    var ask = sess && (sess.pending || []).filter(function (r) { return r.always; })[0];
    function always() { api('/api/answer', { id: ask.id, allow: true, always: true }).then(function () { p.toast({ tone: 'success', title: sess.name, text: 'Allowed from now on: ' + ask.always }); }, fail); }

    var modeOpts = [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan only' }, { value: 'acceptEdits', label: 'Accept edits' }];
    if (sess && sess.mode && !modeOpts.some(function (o) { return o.value === sess.mode; })) modeOpts.push({ value: sess.mode, label: sess.mode });
    var modelOpts = MODELS.slice(1);
    if (sess && sess.model && !modelOpts.some(function (o) { return o.value === sess.model; })) modelOpts.unshift({ value: sess.model, label: sess.model });
    var ctxPct = sess && sess.ctxTokens && sess.ctxWindow ? Math.round(100 * sess.ctxTokens / sess.ctxWindow) : null;
    var working = sess && (sess.status === 'working' || sess.status === 'waiting');
    var usage = sess && sess.usage && sess.usage.tokens ? sess.usage : null;
    // Requests wait in a building that is not shown: offer the way there.
    var elsewhere = p.buildings.filter(function (b) { return b.key !== p.shown && b.waiting; })[0];
    var many = p.buildings.length > 1 || (p.buildings.length && p.buildings[0].key !== p.shown);

    return h(React.Fragment, null,
      snap && !live.length ? h('div', { className: 'welcome' },
        h('div', { className: 'welcome-logo' }, h(A.Logo, { variant: 'lockup', height: 28 })),
        h(A.EmptyState, { icon: 'building', title: 'No sessions yet', text: 'Open a session to seat the first bot. You can also reopen a past one.', action: { label: 'Open session', icon: 'add', onClick: p.onOpen } })) : null,
      h('div', { className: 'strip', role: 'toolbar', 'aria-label': 'Office controls' },
        h('div', { className: 'strip-group' },
          h(A.Button, { variant: 'primary', icon: 'add', onClick: p.onOpen }, 'Open session'),
          many ? h(A.Select, { id: 'c-building', ariaLabel: 'Building (repository)', value: p.shown, onChange: p.onBuilding,
                options: p.buildings.map(function (b) { return { value: b.key, label: b.name + ' · ' + plural(b.sessions, 'session', 'sessions') + (b.waiting ? ' · ' + b.waiting + ' need you' : '') }; })
                  .concat(p.buildings.some(function (b) { return b.key === p.shown; }) ? [] : [{ value: p.shown, label: (p.shownName || 'This building') + ' · no sessions' }]) }) : null,
          elsewhere ? h(A.Button, { variant: 'emphasis', icon: 'waiting', onClick: function () { p.onBuilding(elsewhere.key); } }, plural(elsewhere.waiting, 'request', 'requests') + ' in ' + elsewhere.name) : null,
          live.length ? h('span', { className: 'strip-total mono' }, live.length + ' open · ' + money(total)) : null),
        h('div', { className: 'strip-group strip-nav' },
          p.view === 'city' ? h(A.Button, { variant: 'quiet', icon: 'floor', title: 'Go inside ' + (p.shownName || 'the building'), onClick: p.onOffice }, 'Go inside') : h(A.Button, { variant: 'quiet', icon: 'building', onClick: p.onCity }, 'City'),
          p.shown ? h(A.Button, { variant: 'quiet', icon: 'floor', onClick: p.onFloors }, 'Floors') : null,
          h(A.Button, { variant: 'quiet', icon: 'identity', onClick: p.onSessions }, 'Sessions'),
          h(A.Button, { variant: 'quiet', icon: 'session', onClick: p.onPast }, 'Past'),
          h(A.Button, { variant: 'quiet', icon: 'schedule', onClick: p.onSchedules }, 'Schedules'),
          h(A.Button, { variant: 'ghost', icon: 'terminal', onClick: p.onHooks }, 'Hooks'),
          h(Tip, { text: 'A thin status bar for a second screen' }, h(A.Button, { variant: 'ghost', icon: 'zoom-out', onClick: p.onCompact }, 'Compact'))),
        sess ? h('div', { className: 'strip-group strip-bot' },
          h('span', { className: 'strip-id' }, h(A.StatusDot, { status: statusOf(sess) }), h('b', null, sess.name), ctxPct != null ? h('span', { className: 'mono' }, 'context ' + ctxPct + '%') : null),
          sess.headless && (usage || sess.cost) ? h(A.CostMeter, { tokens: usage ? usage.tokens : 0, cost: sess.cost || 0, cached: usage && usage.input ? usage.cached / usage.input : undefined }) : null,
          sess.headless ? h(A.Select, { id: 'c-model', ariaLabel: 'Model of ' + sess.name, options: modelOpts, value: sess.model || '', onChange: function (v) { ctl('model', v); } }) : null,
          sess.headless ? h(A.Select, { id: 'c-mode', ariaLabel: 'Permissions of ' + sess.name, options: modeOpts, value: sess.mode || '', onChange: function (v) { ctl('mode', v); } }) : null,
          sess.headless ? h(Tip, { text: working ? '' : 'Nothing runs now' }, h(A.Button, { variant: 'quiet', icon: 'pause', disabled: !working, onClick: stopTurn }, 'Stop turn')) : null,
          h(A.Button, { variant: 'quiet', icon: 'terminal', onClick: function () { p.onTerminal(sess.uid, sess.name); } }, 'Open terminal'),
          h(A.Button, { variant: 'quiet', icon: 'trace', onClick: function () { p.onChanges(sess.uid, sess.name); } }, 'Changes'),
          h(A.Button, { variant: 'quiet', icon: 'connector', onClick: function () { p.onExtensions(sess.uid, sess.name); } }, 'Extensions'),
          ask ? h(A.Button, { variant: 'emphasis', icon: 'approve', onClick: always, title: 'Approve and allow this from now on: ' + ask.always }, 'Always allow ' + clip(ask.always, 28)) : null) : null));
  }

  // ---------- app ----------
  function App() {
    var sel = useChatBot();
    var s2 = useState(null), dlg = s2[0], setDlg = s2[1];
    var s3 = useState({ recent: [], templates: [], schedules: [] }), info = s3[0], setInfo = s3[1];
    var tt = useState([]), toasts = tt[0], setToasts = tt[1], tid = React.useRef(0);
    function toast(t) {
      var id = ++tid.current;
      setToasts(function (l) { return l.concat([Object.assign({ id: id }, t)]).slice(-3); });
      setTimeout(function () { setToasts(function (l) { return l.filter(function (x) { return x.id !== id; }); }); }, 6000);
    }
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
    // Compact view: the DS ambient bar, for a second screen. ?ambient=1 starts in it.
    var am = useState(function () { return /[?&]ambient=1\b/.test(location.search); }), ambient = am[0], setAmbient = am[1];
    var wantKey = shown + ':' + epoch + (Object.keys(now).length ? '' : ':empty') + (ambient ? ':ambient' : '');
    // City or office. The office is the default; the choice is kept in the browser.
    var vw = useState(function () { try { return localStorage.getItem('ao-view') === 'city' ? 'city' : 'office'; } catch (x) { return 'office'; } }), view = vw[0], setView = vw[1];
    // Smooth changes: the shown scene fades out, then the next one mounts and fades in.
    var fd = useState({ key: wantKey, repo: shown, view: view }), cur2 = fd[0], setCur2 = fd[1];
    var fading = cur2.key !== wantKey || cur2.view !== view;
    useEffect(function () {
      if (!fading) return undefined;
      var t = setTimeout(function () { setCur2({ key: wantKey, repo: shown, view: view }); }, reduced() ? 0 : cssMs('duration-base', 240));
      return function () { clearTimeout(t); };
    }, [wantKey, view]);
    var sceneKey = cur2.key;
    var introNext = React.useRef(true);
    // The scene mounts once per building. Re-rendering the page must not rebuild it.
    var def = useMemo(function () { return snap && cur2.view === 'office' ? window.officeAdapter.buildingFor(cur2.repo) : null; }, [snap ? sceneKey + cur2.view : null]);
    var intro = useMemo(function () { var i = introNext.current; if (def) introNext.current = false; return i && !ambient; }, [def]);
    function go(v) { setView(v); try { localStorage.setItem('ao-view', v); } catch (x) { /* private window */ } }
    // From the city: fly to the building, then enter it with the DS intro flythrough.
    function enter(key, city) {
      var inside = function () { introNext.current = true; pick(key); go('office'); };
      if (city) city.focus(key, inside); else inside();
    }
    var week = snap && snap.plan && snap.plan.week;
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-plan', !!week); }, [!!week]);
    var officeRef = React.useRef(null);
    // the room board the camera faces, if any (board.js)
    var boardRef = React.useRef(null);
    var bs = useState(null), board = bs[0], setBoard = bs[1];
    var latestSnap = React.useRef(null); latestSnap.current = snap;
    // the terminal of one session (terminal.js), read in full beside the room
    var terminalRef = React.useRef(null);
    // the scene host (scene-host.js): the one reader of the DS stage; board, terminal, streets and birds are its adapters
    var hostRef = React.useRef(null);
    var tm = useState(null), term = tm[0], setTerm = tm[1];
    function openTerminal(uid, name) {
      if (boardRef.current && boardRef.current.focused && boardRef.current.focused()) boardRef.current.blur();
      setBoard(null);
      setTerm({ uid: uid, name: name });
    }
    function noteKey(roomId) { return window.officeAdapter.noteKey(roomId); }   // the server's key for the room (place.mjs)
    useEffect(function () { return function () {
      if (boardRef.current) { boardRef.current.dispose(); boardRef.current = null; }
      if (terminalRef.current) { terminalRef.current.dispose(); terminalRef.current = null; }
      if (hostRef.current) { hostRef.current.dispose(); hostRef.current = null; }
      setBoard(null); setTerm(null);
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
      if (!b || window.officeAdapter.shown() !== shown) return null;
      roomIds().forEach(function (id) {
        var inf = window.officeAdapter.roomInfo(id, sn);
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
        toast({ tone: 'info', title: now[u].roomName, text: now[u].name + ' came in' });
      });
      Object.keys(prev.sessions).forEach(function (u) {
        if (now[u] && now[u].room === prev.sessions[u].room) return;
        if (b && b.doorPulse) b.doorPulse(prev.sessions[u].room, 'out');
        toast({ tone: 'info', title: prev.sessions[u].roomName, text: prev.sessions[u].name + ' left' });
      });
    }, [snap]);
    // side panels sit above the control strip, however tall it is
    var cl2 = useState(null), clear = cl2[0], setClear = cl2[1];
    useEffect(function () {
      var strip = null, ro = null;
      function set() {
        if (!strip) return;
        var v = Math.ceil(window.innerHeight - strip.getBoundingClientRect().top + 8);
        setClear(function (o) { return o === v ? o : v; });
      }
      function find() {
        var s2 = document.querySelector('.strip');
        if (s2 === strip) return;
        strip = s2;
        if (ro) { ro.disconnect(); ro = null; }
        if (strip && window.ResizeObserver) { ro = new ResizeObserver(set); ro.observe(strip); }
        set();
      }
      var mo = new MutationObserver(find);
      mo.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', set);
      find();
      return function () { mo.disconnect(); if (ro) ro.disconnect(); window.removeEventListener('resize', set); };
    }, []);
    // zoom out to leave: scrolling out at the widest zoom goes floor -> building -> city
    useEffect(function () {
      if (cur2.view !== 'office') return undefined;
      var pushes = 0, pushT = 0;
      function onWheel(e) {
        var o = officeRef.current, st = o && o.inspect && o.inspect().stage;
        if (!st || !st.ctl || e.deltaY <= 0 || !e.target.closest || !e.target.closest('.ao-scene')) { pushes = 0; return; }
        if (st.cam.zoom > st.ctl.minZoom * 1.03) return;
        var now = Date.now();
        pushes = now - pushT < 800 ? pushes + 1 : 1; pushT = now;
        if (pushes < 2) return;
        pushes = 0;
        if (hostRef.current && hostRef.current.inBuilding()) go('city'); else o.setView('building');
      }
      window.addEventListener('wheel', onWheel, { passive: true, capture: true });
      return function () { window.removeEventListener('wheel', onWheel, true); };
    }, [cur2.view]);
    var scene = cur2.view === 'city' ? h(CityView, { key: 'city', shown: shown, onEnter: enter }) : def ? h(A.OfficeScene, { key: sceneKey, building: def, adapter: window.officeAdapter, height: window.innerHeight, quality: 'auto', intro: intro, editable: false, simulate: false,
      ambient: ambient, onAmbientOpen: function () { setAmbient(false); }, onReady: function (o) {
        officeRef.current = o;
        window.officeScene = o;   // the mounted office API, for the console and tests
        var st = o.inspect && o.inspect().stage;
        if (boardRef.current) boardRef.current.dispose();
        if (terminalRef.current) terminalRef.current.dispose();
        if (hostRef.current) hostRef.current.dispose();
        var host = hostRef.current = window.OfficeSceneHost && st ? window.OfficeSceneHost.attach(o) : null;
        if (st && host && window.OfficeBoard) {
          boardRef.current = window.OfficeBoard.attach(o, {
            host: host,
            room: function (id) { return window.officeAdapter.roomInfo(id); },
            note: function (id) { var n = latestSnap.current && latestSnap.current.notes && latestSnap.current.notes[noteKey(id)]; return n ? n.text : ''; },
            tree: function (root) { return api('/api/tree', { root: root }); },
            stats: function (id) { return window.officeAdapter.figures(id); },
            pin: function (id) { var n = latestSnap.current && latestSnap.current.pins && latestSnap.current.pins[noteKey(id)]; return n && n.text ? { text: n.text, by: n.by } : null; },
            onDoor: function (id) { setTerm(null); setDlg({ name: 'room', roomId: id }); },
            onFocus: function (id, kind) { setTerm(null); setBoard({ id: id, kind: kind }); }, onBlur: function () { setBoard(null); }
          });
        }
        if (st && host && window.OfficeTerminal) {
          terminalRef.current = window.OfficeTerminal.attach(o, {
            host: host,
            session: function (botName) { return window.officeAdapter.session(botName); },
            onOpen: function (uid, name) { o.select(name); openTerminal(uid, name); }
          });
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

    function close() { setDlg(null); }
    function extensions(uid, name) { setDlg({ name: 'ext', uid: uid, label: name }); }
    function goTo(s) { var key = window.officeAdapter.buildingOf(s); pick(key); setDlg(null); setTimeout(function () { if (officeRef.current) officeRef.current.select(s.name); }, 400); }
    var selSess = sel ? window.officeAdapter.session(sel) : null;
    var d = dlg && dlg.name;

    // the page's own commands in Ctrl+K
    pageActions.length = 0;
    [['open', 'Open a session', 'add', function () { show('open'); }], ['sessions', 'All sessions', 'identity', function () { setDlg({ name: 'sessions' }); }],
     ['city', 'City view', 'building', function () { go('city'); }], ['office', 'Office view', 'floor', function () { go('office'); }], ['floors', 'Floors and rooms', 'floor', function () { setDlg({ name: 'floors' }); }],
     ['past', 'Past sessions', 'session', function () { show('past'); }], ['schedules', 'Schedules', 'schedule', function () { show('schedules'); }],
     ['hooks', 'Attach other sessions', 'terminal', function () { show('hooks'); }], ['compact', 'Compact view', 'zoom-out', function () { setAmbient(true); }]]
      .forEach(function (a) { pageActions.push({ id: 'page-' + a[0], label: a[1], icon: a[2], group: 'Office', run: a[3] }); });
    if (selSess) pageActions.push({ id: 'page-ext', label: 'Extensions of ' + selSess.name, icon: 'connector', group: 'Office', run: function () { extensions(selSess.uid, selSess.name); } });
    list.forEach(function (b) { if (b.key !== shown) pageActions.push({ id: 'page-b-' + b.key, label: 'Go to ' + b.name, icon: 'building', group: 'Buildings', keywords: 'building repository ' + b.name, run: function () { pick(b.key); } }); });

    return h(React.Fragment, null,
      h('div', { className: 'view' + (fading ? ' is-fading' : '') }, scene),
      ambient ? null : h(Controls, { sel: cur2.view === 'office' ? sel : null, buildings: list, shown: shown, shownName: (list.filter(function (b) { return b.key === shown; })[0] || def || {}).name, toast: toast, onBuilding: function (k) { pick(k); if (view === 'city') go('office'); }, onCity: function () { go('city'); }, onOffice: function () { introNext.current = true; go('office'); }, view: cur2.view, onSessions: function () { setDlg({ name: 'sessions' }); }, onCompact: function () { setAmbient(true); },
        onFloors: function () { setDlg({ name: 'floors' }); }, onExtensions: extensions, onTerminal: openTerminal, onOpen: function () { show('open'); }, onPast: function () { show('past'); }, onSchedules: function () { show('schedules'); }, onHooks: function () { show('hooks'); }, onChanges: changes }),
      d === 'open' ? h(OpenDialog, { recent: info.recent || [], templates: info.templates || [], onTemplates: refresh, onClose: close }) : null,
      d === 'past' ? h(PastDialog, { onClose: close, onChanges: changes, toast: toast }) : null,
      d === 'schedules' ? h(SchedulesDialog, { recent: info.recent, onInfo: setInfo, toast: toast, onClose: close }) : null,
      d === 'changes' ? h(ChangesDialog, { uid: dlg.uid, name: dlg.label, ended: dlg.ended, toast: toast, onClose: close }) : null,
      d === 'hooks' ? h(HooksDialog, { info: info, snap: snap, onClose: close }) : null,
      d === 'floors' ? h(FloorsDialog, { repo: shown, toast: toast, onClose: close }) : null,
      d === 'room' ? h(RoomDialog, { roomId: dlg.roomId, toast: toast, onClose: close }) : null,
      d === 'ext' ? h(ExtensionsDialog, { uid: dlg.uid, name: dlg.label, toast: toast, onClose: close }) : null,
      term ? h(TerminalPanel, { clear: clear, key: term.uid, uid: term.uid, name: term.name, toast: toast, onClose: function () { setTerm(null); } }) : null,
      !term && board && boardRef.current && board.kind === 'board' ? h(BoardPanel, { clear: clear, data: boardRef.current.dataOf(board.id), onClose: function () { boardRef.current.blur(); } }) : null,
      !term && board && boardRef.current && board.kind === 'stats' ? h(StatsPanel, { clear: clear, roomId: board.id, onClose: function () { boardRef.current.blur(); } }) : null,
      !term && board && boardRef.current && board.kind === 'notes' ? h(NotesEditor, { key: board.id, noteKey: noteKey(board.id), text: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).text || '', version: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).v || 0, toast: toast,
        rect: function () { return boardRef.current ? boardRef.current.rect() : null; }, flying: function () { return boardRef.current ? boardRef.current.flying() : false; },
        onClose: function () { boardRef.current.refresh(); boardRef.current.blur(); } }) : null,
      d === 'sessions' ? h(SessionsDialog, { onClose: close, onGo: goTo }) : null,
      ambient || cur2.view !== 'office' ? null : h(ChatHeaderButton, { sess: selSess, onOpen: function () { extensions(selSess.uid, selSess.name); } }),
      h('div', { className: 'page-toasts' }, h(A.ToastStack, { toasts: toasts, onClose: function (id) { setToasts(function (l) { return l.filter(function (x) { return x.id !== id; }); }); } })));
  }

  ReactDOM.createRoot(document.getElementById('office')).render(h(App));
})();
