/* Agent Office for Claude Code x0.2: the schedules feature (#184, the page features of #168).
   Schedules: timed sessions. One Module: its Interface is window.OfficePage.Schedules = { Dialog: SchedulesDialog }.
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, DEFAULT_KIND = O.DEFAULT_KIND, F = O.F, ISOLATION = O.ISOLATION, KIND = O.KIND, KV = O.KV, KindFields = O.KindFields, Pair = O.Pair, Tag = O.Tag, ago = O.ago, cadence = O.cadence, client = O.client, clip = O.clip, getInfo = O.getInfo, kindOf = O.kindOf, limitHint = O.limitHint, limitSent = O.limitSent, limitText = O.limitText, useFirstModel = O.useFirstModel, useKinds = O.useKinds;

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
      client.scheduleSave(Object.assign({}, edit, { every: Number(edit.every) || 60, maxBudget: limited ? limitSent(edit.maxBudget, p.spendLimit !== undefined) : undefined })).then(function () { if (p.toast) p.toast({ tone: 'success', title: edit.id ? 'Schedule saved' : 'Schedule added', text: edit.name || cadence(edit) }); setEdit(null); setErr(''); load(); }, function (x) { setErr(x.message); });
    }
    var dl = useState(null), ask = dl[0], setAsk = dl[1];   // the schedule the user is about to delete
    function run(s) { client.scheduleRun({ id: s.id }).then(function () { setErr(''); if (p.toast) p.toast({ tone: 'success', title: s.name || 'Schedule', text: 'A session is starting now.' }); }, function (x) { setErr(x.message); }); }
    function del(id) { client.scheduleDelete({ id: id }).then(function () { setAsk(null); if (p.toast) p.toast({ tone: 'info', title: 'Schedule deleted', text: 'It will not run again.' }); load(); }, function (x) { setErr(x.message); }); }
    if (ask && !edit) {
      return h(A.Dialog, { open: true, title: 'Delete ' + (ask.name || 'this schedule'), onClose: function () { setAsk(null); setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'd', variant: 'danger', icon: 'remove', onClick: function () { del(ask.id); } }, 'Delete schedule')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'The schedule will not run again. Sessions it already started stay open.'),
          err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    function toggle(s) { client.scheduleSave(Object.assign({}, s, { enabled: !s.enabled })).then(load, function (x) { setErr(x.message); }); }
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

  O.Schedules = { Dialog: SchedulesDialog };
})();
