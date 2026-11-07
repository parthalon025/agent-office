/* Agent Office for Claude Code x0.2: the session dialogs (split out of office.js, #1 story 26).
   Open session, skills, past sessions and search, hooks, Paperclip connect, the agent kinds, floors, all sessions and the
   agents of one room. Plain functions over the page core (window.OfficePage); the dialogs put their names on it for office.js
   and panels.js. Schedules, Extensions and the office dialogs are page features of their own (#184). */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, CostDialog = O.CostDialog, DEFAULT_KIND = O.DEFAULT_KIND, F = O.F,
      FeatureTags = O.FeatureTags, ISOLATION = O.ISOLATION, KIND = O.KIND, KV = O.KV, KindFields = O.KindFields,
      MODES = O.MODES, Pair = O.Pair, Pairs = O.Pairs, Tag = O.Tag, WHERE = O.WHERE, ago = O.ago, client = O.client,
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
      client.open(body).then(function () { setBusy(false); setCostQ(null); p.onClose(); }, function (x) {
        setBusy(false);
        if (costAsked(x) && confirmed !== true) { setCostQ(x.message); return; }
        setErr(x.message);
      });
    }
    function saveTemplate() {
      client.templateSave({ name: saving, text: form.prompt }).then(function (t) { setSaving(null); p.onTemplates(); setForm(Object.assign({}, form, { template: t.id })); }, function (x) { setErr(x.message); });
    }
    function delTemplate() { client.templateDelete({ id: form.template }).then(function () { setForm(Object.assign({}, form, { template: '' })); p.onTemplates(); }, function (x) { setErr(x.message); }); }
    var terminal = canWindow && form.where === 'terminal';
    var blocked = KV.noModelFor(k) || KV.notConfigured(k);
    // The server owns the folder rules (recent.mjs recentChoices); until its answer comes, show the stored list.
    var fc = useState(null), fetched = fc[0], setFetched = fc[1];
    useEffect(function () {
      client.get('choices', { first: p.shownPath || '' })
        .then(function (j) { setFetched(j.folders || null); }, function () {});
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
    function load() { client.history().then(function (j) { setList(j.sessions); }, function (x) { setErr(x.message); }); }
    useEffect(load, []);
    useEffect(function () {
      if (q.trim().length < 2) { setResults(null); return undefined; }
      var t = setTimeout(function () { client.search({ q: q }).then(function (j) { setResults(j.results); }, function (x) { setErr(x.message); }); }, 250);
      return function () { clearTimeout(t); };
    }, [q]);
    function act(uid, fn) { setBusy(uid); setErr(''); fn().then(function () { setBusy(''); }, function (x) { setBusy(''); setErr(x.message); }); }
    // The server answers confirm: 'cost' for an agent that reports no cost: the user says yes once, then the same call runs it.
    function reopen(s, confirmed) {
      act(s.uid, function () {
        return client.reopen({ uid: s.uid, confirmCost: confirmed === true }).then(function () { setRunAsk(null); p.onClose(); }, function (x) {
          if (costAsked(x) && !confirmed) { setRunAsk({ s: s, text: x.message }); return; }
          throw x;
        });
      });
    }
    // Fork (#72) writes a worktree and a session, so the server holds it: 409 with confirm: 'fork' and the question; the same call with confirmed: true runs it.
    function fork(s, confirmed) {
      act(s.uid, function () {
        return client.fork({ uid: s.uid, confirmed: confirmed === true }).then(function () {
          setForkAsk(null); if (p.toast) p.toast({ tone: 'success', title: s.name, text: 'Forked into a new worktree' }); p.onClose();
        }, function (x) {
          var q = window.OfficeAsk.asked(x, 'fork', confirmed);
          if (q) { setForkAsk({ s: s, text: q.text }); return; }
          throw x;
        });
      });
    }
    function forget(uid) { act(uid, function () { return client.historyForget({ uid: uid }).then(function () { setAsk(null); if (p.toast) p.toast({ tone: 'info', title: 'Session forgotten', text: 'It is gone from Past sessions.' }); load(); }); }); }
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
      client.startup({ enabled: !startup.enabled }).then(function (r) {
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
      client.settingsSpend({ limit: limitSent(limit, true), confirmed: true }).then(function (r) {
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
        h(PaperclipRuntime, { runtime: p.snap && p.snap.paperclipRuntime, toast: p.toast }),
        h(PaperclipConnect, { hq: p.snap && p.snap.hq, toast: p.toast })));
  }

  // ---------- the Paperclip runtime (#193): install, start, stop, and the board key ----------
  // The office installs one pinned release of Paperclip with npm into its own folder, runs it in login mode on 127.0.0.1 and stops it
  // with the office. What only a person can do (the first account, approving the board key in Paperclip) shows as steps with a link.
  function PaperclipRuntime(p) {
    var rt = p.runtime, V = window.OfficeVocab.hq;
    var b = useState(''), busy = b[0], setBusy = b[1];
    var e = useState(''), err = e[0], setErr = e[1];
    var q = useState(''), ask = q[0], setAsk = q[1];
    var w = useState('paperclipRuntimeInstall'), askFor = w[0], setAskFor = w[1];
    if (!rt) return null;
    var st = V.runtime(rt), s = rt.state;
    function call(name, body, done) {
      setBusy(name); setErr('');
      client[name](body || {}).then(function () { setBusy(''); setAsk(''); if (done) done(); }, function (x) {
        setBusy('');
        var a = window.OfficeAsk.asked(x, 'runtime', body && body.confirmed === true);
        if (a) { setAskFor(name); setAsk(a.text); return; }
        setErr(x.message);
      });
    }
    function toast(title, text) { if (p.toast) p.toast({ tone: 'success', title: title, text: text }); }
    var link = function (href, text) { return /^http:\/\/127\.0\.0\.1:\d+\//.test(href || '') ? h('a', { href: href, target: '_blank', rel: 'noopener noreferrer' }, text) : null; };
    var keyLink = rt.key && rt.key.approvalUrl ? link(rt.key.approvalUrl, 'Open the approval link') : null;
    var inviteLink = rt.inviteUrl ? link(rt.inviteUrl, 'Open the first-account link') : null;
    var openLink = s === 'running' && !inviteLink && !keyLink ? link(rt.url + '/', 'Open Paperclip') : null;
    var needsKey = rt.key && (rt.key.state === 'none' || rt.key.state === 'refused' || rt.key.state === 'expired');
    return h(React.Fragment, null,
      h('h3', { className: 'ext-h' }, 'Paperclip runtime'),
      h('p', { className: 'note' }, 'Run Paperclip from the office. The office installs release ' + rt.version + ' with npm into its own folder, starts it in login mode on this computer only (127.0.0.1) and stops it with the office. Its data stays in your local app data folder. A Paperclip that you run yourself is never changed.'),
      h('p', { className: 'note', role: 'status' }, h('span', { className: 'sess-state' }, h(A.StatusDot, { status: st.key }), st.word), rt.reason ? ' ' + rt.reason : ''),
      s === 'running' ? h('p', { className: 'note' }, V.runtimeKey(rt)) : null,
      rt.updateAvailable && s !== 'updating' ? h('p', { className: 'note' }, 'Paperclip ' + rt.installedVersion + ' is installed. Release ' + rt.version + ' is ready to install.') : null,
      rt.update && rt.update.error && s !== 'updating' ? h('p', { className: 'ao-err', role: 'alert' }, rt.update.error) : null,
      rt.steps && rt.steps.length && !ask ? h('ul', { className: 'kind-steps' }, rt.steps.map(function (t, i) { return h('li', { key: i }, t); })) : null,
      inviteLink || keyLink || openLink ? h('p', { className: 'note' }, inviteLink || keyLink || openLink) : null,
      ask ? h('div', { className: 'copy-row' }, h('p', { className: 'note', role: 'alert' }, ask),
        h('div', { className: 'btn-row' },
          askFor === 'paperclipRuntimeUpdate'
            ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === askFor, onClick: function () { call(askFor, { confirmed: true }, function () { toast('Updating Paperclip', 'It takes a few minutes. This panel says when it is done.'); }); } }, 'Update Paperclip')
            : h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === askFor, onClick: function () { call(askFor, { confirmed: true }, function () { toast('Installing Paperclip', 'It takes a few minutes. This panel says when it is done.'); }); } }, 'Install Paperclip'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAsk(''); } }, askFor === 'paperclipRuntimeUpdate' ? 'Do not update' : 'Do not install'))) : null,
      err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
      h('div', { className: 'btn-row' },
        (s === 'off' || (s === 'failed' && !rt.installed)) && !ask ? h(A.Button, { variant: 'quiet', icon: 'add', disabled: !!busy, loading: busy === 'paperclipRuntimeInstall', onClick: function () { call('paperclipRuntimeInstall', {}); } }, 'Install Paperclip') : null,
        s === 'stopped' || (s === 'failed' && rt.installed) ? h(A.Button, { variant: 'quiet', icon: 'resume', disabled: !!busy, loading: busy === 'paperclipRuntimeStart', onClick: function () { call('paperclipRuntimeStart', {}, function () { toast('Paperclip is starting', 'The first start takes a minute or two.'); }); } }, 'Start Paperclip') : null,
        s === 'running' && rt.bootstrap !== 'pending' && needsKey ? h(A.Button, { variant: 'quiet', icon: 'tool', disabled: !!busy, loading: busy === 'paperclipRuntimeKey', onClick: function () { call('paperclipRuntimeKey', {}); } }, 'Connect board key') : null,
        rt.updateAvailable && (s === 'stopped' || s === 'running' || s === 'failed') && !ask ? h(A.Button, { variant: 'quiet', icon: 'add', disabled: !!busy, loading: busy === 'paperclipRuntimeUpdate', onClick: function () { call('paperclipRuntimeUpdate', {}); } }, 'Update Paperclip') : null,
        s === 'running' || s === 'starting' ? h(A.Button, { variant: 'quiet', icon: 'close', disabled: !!busy, loading: busy === 'paperclipRuntimeStop', onClick: function () { call('paperclipRuntimeStop', {}, function () { toast('Paperclip stopped', 'It starts again only when you start it.'); }); } }, 'Stop Paperclip') : null));
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
      client.paperclipConnect({ url: url, company: co || undefined }).then(function (r) {
        setBusy(false);
        if (r.choose) { setCompany(r.choose[0] ? r.choose[0].id : ''); return; }
        if (p.toast) p.toast({ tone: 'success', title: 'Paperclip connected', text: H.state(r.hq) + '. The office only reads it.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function disconnect() {
      setBusy(true);
      client.paperclipDisconnect({}).then(function () { setBusy(false); if (p.toast) p.toast({ tone: 'info', title: 'Paperclip disconnected', text: 'Paperclip runs on as before. The office no longer watches it.' }); },
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
      'floorCleanup': function (b, j) { return F.cleanupNote(j); },
      'floorCreate': ['success', 'Floor added', function (b) { return 'Branch ' + b.branch + ' with its first room.'; }],
      'floorDelete': ['info', 'Floor deleted', function (b) { return 'Branch ' + b.branch + ' and its rooms are gone.'; }],
      'roomCreate': ['success', 'Room added', function (b) { return 'A new worktree on ' + b.branch + '.'; }],
      'roomDelete': ['info', 'Room removed', function (b) { return 'The folder ' + String(b.root).split(/[\\/]/).pop() + ' is gone. Its branch stays.'; }] };
    function run(key, path, body, after) {
      setBusy(key); setErr('');
      client.send(path, Object.assign({ repo: p.repo }, body)).then(function (j) {
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
        fl.length ? h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'cleanup', onClick: function () { run('cleanup', 'floorCleanup', { branches: fl.map(function (f) { return f.branch; }) }, function () { setClean(null); }); } }, 'Delete ' + fl.length + (fl.length === 1 ? ' floor' : ' floors')) : null] },
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
        if (isFloor) run('confirm', 'floorDelete', { branch: confirm.branch, force: forced }, function () { setConfirm(null); });
        else run('confirm', 'roomDelete', { root: confirm.root, force: forced }, function () { setConfirm(null); });
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
              h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'new', disabled: !form.branch.trim(), onClick: function () { run('new', 'floorCreate', { branch: form.branch.trim(), from: form.from, name: (form.name || '').trim() }, function () { setForm(null); }); } }, 'Create floor and room'),
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
                h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'room:' + b, onClick: function () { run('room:' + b, 'roomCreate', { branch: b, name: newRoom.name.trim() }, function () { setNewRoom(null); }); } }, 'Add room'),
                h(A.Button, { variant: 'quiet', onClick: function () { setNewRoom(null); } }, 'Cancel')) : null),
            h('div', { className: 'past-actions' },
              newRoom && newRoom.branch === b ? null : h(A.Button, { variant: 'quiet', icon: 'add', onClick: function () { setErr(''); setNewRoom({ branch: b, name: '' }); } }, 'Add room'),
              hasMain ? null : h(A.Button, { variant: 'ghost', icon: 'remove', onClick: function () { setErr(''); setConfirm({ kind: 'floor', branch: b }); } }, 'Delete floor')));
        })),
        form ? null : h('div', { className: 'inline-actions' },
          h(A.AddButton, { label: 'Add a floor', onClick: function () { setErr(''); setForm({ branch: '', from: main ? main.branch : '', name: '' }); } }),
          h(A.Button, { variant: 'quiet', icon: 'remove', loading: busy === 'stale', onClick: function () { setBusy('stale'); setErr(''); client.floorStale({ repo: p.repo }).then(function (j) { setBusy(''); setClean({ floors: j.floors }); }, function (x) { setBusy(''); setErr(x.message); }); } }, 'Clean up unused floors')),
        h(FloorsWithoutRooms, { repo: p.repo, busy: busy, run: run, shown: repo.worktrees.map(function (w) { return w.branch; }) })));
  }
  // Branches with no worktree: a room brings the floor into the building.
  function FloorsWithoutRooms(p) {
    var l = useState(null), list = l[0], setList = l[1];
    useEffect(function () { client.branches({ repo: p.repo }).then(function (j) { setList(j.branches); }, function () { setList([]); }); }, [p.repo, p.shown.join('|')]);
    var rest = (list || []).filter(function (b) { return p.shown.indexOf(b) < 0; });
    if (!rest.length) return null;
    return h('div', { className: 'form' },
      h('p', { className: 'note' }, 'Branches with no room. Add a room to show the floor.'),
      h('ul', { className: 'past' }, rest.slice(0, 30).map(function (b) {
        return h('li', { key: b, className: 'past-row' },
          h('div', { className: 'past-title' }, h(A.Icon, { name: 'floor', size: 16 }), h('span', { className: 'mono' }, b)),
          h(A.Button, { variant: 'quiet', icon: 'add', loading: p.busy === 'room:' + b, onClick: function () { p.run('room:' + b, 'roomCreate', { branch: b }); } }, 'Add room'));
      })));
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
      client.close({ uid: cur.uid }).then(function () { setBusy(false); setConfirm(null); p.toast({ tone: 'success', title: cur.name, text: 'Session closed' }); }, function (x) { setBusy(false); setErr(x.message); });
    }
    function addAgent(confirmed) {
      var cwd = list.length && list[0].cwd ? list[0].cwd : place && place.path;
      if (!cwd) { setErr('This room has no folder yet.'); return; }
      setBusy(true); setErr('');
      client.open({ cwd: cwd, name: add.name.trim(), provider: add.provider, where: 'office', isolation: 'same', model: add.model, prompt: add.prompt, confirmCost: confirmed === true })
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
      client.screenSet({ key: wallKey, view: v }).then(function () { p.toast({ tone: 'success', title: 'Wall screen', text: WV.word(v) }); }, function (x) { setErr(x.message); });
    }
    if (costQ) return h(CostDialog, { title: 'Run ' + (addKind ? addKind.label : 'the agent'), text: costQ, busy: busy, err: err, onCancel: function () { setCostQ(null); setErr(''); }, onRun: function () { addAgent(true); } });
    if (skills) return h(O.Skills.Dialog, { kind: skills.kind, agent: skills.agent, toast: p.toast, onClose: function () { setSkills(null); } });
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

  Object.assign(O, { FloorsDialog: FloorsDialog, HooksDialog: HooksDialog, KindsDialog: KindsDialog,
      OpenDialog: OpenDialog, PastDialog: PastDialog, RoomDialog: RoomDialog,
      SessionsDialog: SessionsDialog });
})();
