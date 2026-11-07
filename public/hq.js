/* Agent Office for Claude Code x0.2: the hq feature (#184, the page features of #168).
   The Manager board, the Paperclip HQ and earned trust (#157, #76, #153). One Module: its Interface is window.OfficePage.Hq = { Manager: ManagerDialog, Hq: HqDialog, Trust: TrustDialog, Hire: HireDialog, HireForm: HireForm, Memory: MemoryPanel, AdapterInstall: AdapterInstall } (the HR desk, #201; company memory, #205).
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts.
   The HQ dialog also holds the Lobby (#197): Lobby shows the dashboard cards (from OfficeVocab.hq.cards), the approvals
   and goals that wait, the org chart as floors top first, and the activity. The HQ dialog carries the Paperclip runtime
   panel (O.PaperclipRuntime, defined in dialogs.js). office.js hqBuilding makes the city's HQ floors from snap.hq.floors;
   needs.js PhoneView lists the HQ on a phone. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Tag = O.Tag, ago = O.ago, call = O.call, client = O.client, plural = O.plural, useSnapshot = O.useSnapshot;

  // ---------- the Manager board (#157): one plan per goal, from the Office or from Paperclip ----------
  // One snapshot field (plans), one view (OfficeVocab.plan.board). A Paperclip goal is read only: no button writes to Paperclip.
  // An Office goal can be approved, cancelled and, for a failed step, retried (the goal routes of #156).
  function ManagerDialog(p) {
    var snap = useSnapshot(), V = window.OfficeVocab, v = V.plan.board(snap && snap.plans);
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var ha = useState(null), ask = ha[0], setAsk = ha[1];   // { g, text, tasks }: the handoff waits for the painted Confirm (#159)
    var connected = !!(snap && snap.hq && snap.hq.company);
    // Managers as Paperclip employees (#204): the Managers of the company, and the hire of one for a building. It is the one hire of the HR
    // desk (#201, a write of the grid's Hires cell), so it asks for a monthly budget like every hire: the dialog takes a name and the budget,
    // the first call gets the server's question (ask-first 'write', the exact words of what it creates), and only the painted Confirm sends.
    var ms = useState([]), managers = ms[0], setManagers = ms[1];
    var oa = useOfficeAdapter();   // #222: a hire needs the office adapter in Paperclip
    var adapterOk = oa.loaded && !!oa.adapter && oa.adapter.state === 'installed';
    var hs = useState(null), hire = hs[0], setHire = hs[1];   // { building, name, budget, ask, err }: the Hire Manager dialog
    var bs = useState(''), pick = bs[0], setPick = bs[1];
    useEffect(function () {
      if (!connected) { setManagers([]); return; }
      client.get('managers').then(function (r) { setManagers(r.managers || []); }, function () { setManagers([]); });
    }, [connected, !hire]);   // read again when the Hire Manager dialog closes, not on each key in it
    function hireManager(f, confirmed) {
      setBusy('hire');
      client.managerHire({ building: f.building, name: f.name.trim() || undefined, budgetDollars: Number(f.budget), confirmed: confirmed === true ? true : undefined }).then(function (r) {
        setBusy(''); setHire(null); p.toast({ tone: 'success', title: V.plan.hireManager.done, text: r && r.pendingApproval ? V.plan.hireManager.pending : '' });
      }, function (x) {
        setBusy('');
        var q = window.OfficeAsk.asked(x, 'write', confirmed === true);
        setHire(function (cur) { return cur ? Object.assign({}, cur, q ? { ask: q.text, err: '' } : { ask: '', err: x.message }) : cur; });
      });
    }
    function act(route, body, key) {
      setBusy(key);
      client.send(route, body).then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: 'Manager', text: x.message }); });
    }
    // The first call has no confirmed: the server answers 409 with the exact tasks it would create. The Confirm sends the same call again.
    function handoff(g, confirmed) {
      setBusy(g.id);
      client.goalHandoff({ id: g.id, confirmed: confirmed === true }).then(function () {
        setBusy(''); setAsk(null); p.toast({ tone: 'success', title: 'Handed to Paperclip', text: g.goal });
      }, function (x) {
        setBusy('');
        var q = window.OfficeAsk.asked(x, 'handoff', confirmed);
        if (q) { setAsk({ g: g, text: q.text, tasks: q.body.tasks || [] }); return; }
        setAsk(null); p.toast({ tone: 'error', title: 'Handoff failed', text: x.message });
      });
    }
    var buildingName = function (key) { var r = ((snap && snap.repos) || []).filter(function (x) { return x.key === key; })[0]; return r ? r.name : ''; };
    if (hire) {
      var hm = V.plan.hireManager, budgetOk = hm.budgetOk(hire.budget) && adapterOk;
      var setField = function (k, x) { var o = { ask: '', err: '' }; o[k] = x; setHire(Object.assign({}, hire, o)); };
      return h(A.Dialog, { open: true, title: hm.title, onClose: function () { setHire(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setHire(null); } }, 'Not now'),
        hire.ask
          ? h(A.Button, { key: 'y', variant: 'primary', icon: 'approve', loading: busy === 'hire', onClick: function () { hireManager(hire, true); } }, hm.confirm)
          : h(A.Button, { key: 'y', variant: 'primary', icon: 'hq', disabled: !budgetOk, loading: busy === 'hire', onClick: function () { hireManager(hire, false); } }, hm.button)] },
        h('div', { className: 'form wide' },
          h('p', { className: 'note' }, hm.intro(buildingName(hire.building) || 'Other folders')),
          adapterOk ? null : h(AdapterInstall, { ad: oa, toast: p.toast }),
          h(A.TextInput, { id: 'mgr-name', label: hm.name, value: hire.name, onChange: function (t) { setField('name', t); } }),
          h(A.TextInput, { id: 'mgr-budget', label: hm.budget, value: hire.budget, onChange: function (t) { setField('budget', t); } }),
          !budgetOk ? h('p', { className: 'note', role: 'status' }, hm.needBudget) : null,
          hire.ask ? h('p', { className: 'note', role: 'alert' }, hire.ask) : null,
          hire.err ? h('p', { className: 'ao-err', role: 'alert' }, hire.err) : null));
    }
    if (ask) {
      var rows = V.plan.handoffRows(ask.tasks, ask.g.handoff && ask.g.handoff.tasks), todo = rows.filter(function (r) { return !r.written; }).length;
      return h(A.Dialog, { open: true, title: 'Hand this goal to Paperclip', onClose: function () { setAsk(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); } }, 'Keep it here'),
        h(A.Button, { key: 'y', variant: 'primary', icon: 'hq', loading: busy === ask.g.id, onClick: function () { handoff(ask.g, true); } }, 'Create ' + plural(todo, 'task', 'tasks'))] },
        h('div', { className: 'form wide handoff-ask' },
          h('p', { className: 'note' }, ask.text),
          h('ul', { className: 'past', 'aria-label': 'Tasks the office creates' }, rows.map(function (r) {
            return h('li', { key: r.step, className: 'past-row' }, h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.title), r.written ? h(Tag, null, 'Already in Paperclip') : null),
              h('div', { className: 'past-meta handoff-desc' }, r.description)));
          }))));
    }
    return h(A.Dialog, { open: true, title: 'Manager board', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide manager-board' },
        v.unreadable.map(function (t) { return h('p', { key: t, className: 'note manager-warn', role: 'status' }, t); }),
        connected && ((snap && snap.repos) || []).length ? h('div', { className: 'inline-actions manager-hire' },
          h(A.Select, { id: 'mgr-building', ariaLabel: V.plan.hireManager.building, options: [{ value: '', label: V.plan.hireManager.building }].concat(((snap && snap.repos) || []).map(function (r) { return { value: r.key, label: r.name }; })), value: pick, onChange: setPick }),
          h(A.Button, { variant: 'quiet', icon: 'hq', disabled: !pick || busy === 'hire', onClick: function () { setHire({ building: pick, name: '', budget: V.plan.hireManager.budgetStart, ask: '', err: '' }); } }, V.plan.hireManager.button)) : null,
        connected && managers.length ? h('p', { className: 'note' }, V.plan.hireManager.has + managers.map(function (m) { return m.name + ' (' + (buildingName(m.building) || 'Other folders') + ')'; }).join(', ')) : null,
        connected && snap.hq.goals ? h('section', { className: 'manager-goal', 'aria-label': 'Paperclip goals' }, h('div', { className: 'past-title' }, h('b', null, 'Paperclip goals'), h(Tag, null, 'Paperclip')), h(Goals, { q: snap.hq, toast: p.toast })) : null,
        v.empty ? h(A.EmptyState, { icon: 'plan', compact: true, title: 'No plan yet', text: 'A goal and its steps show here. Paperclip tasks show here when a company is connected.' }) : null,
        v.groups.map(function (g) {
          var open = g.status === 'planning' || g.status === 'awaiting-approval' || g.status === 'running' || g.status === 'blocked';
          return h('section', { key: g.id, className: 'manager-goal' + (g.frozen ? ' is-frozen' : ''), 'aria-label': g.goal },
            h('div', { className: 'past-title' }, h('b', null, g.goal), h(Tag, null, g.sourceWord), g.readOnly ? h(Tag, null, 'Read only') : null, g.fromTask ? h(Tag, null, g.fromTask) : null, g.building ? h(Tag, null, buildingName(g.building) || 'Other folders') : null,
              g.stateWord ? h('span', { className: 'sess-state' }, g.stateWord) : null),
            g.note && !(g.handoff && g.handoff.failed) ? h('p', { className: 'note', role: g.frozen ? 'status' : undefined }, g.note) : null,
            g.handoff && g.handoff.failed && g.note ? h('p', { className: 'note' }, g.note.replace(/^Handoff failed: \d+ of \d+ tasks written, \d+ left\.\s*/, '')) : null,
            g.handoff && g.handoff.failed ? h('p', { className: 'note', role: 'alert' }, V.plan.handoffFailed(g.handoff)) : null,
            g.handoff && g.handoff.done ? h('p', { className: 'note', role: 'status' }, V.plan.handoffDone(g.handoff)) : null,
            g.total ? h('p', { className: 'note mono' }, g.done + ' of ' + plural(g.total, 'step', 'steps') + ' done') : null,
            g.total ? h('ul', { className: 'past' }, g.steps.map(function (x) {
              var facts = [x.owner ? 'Agent ' + x.owner : '', x.model, x.budget ? 'Budget ' + window.OfficeFormat.cost(x.budget.spent) + (x.budget.limit ? ' of ' + window.OfficeFormat.cost(x.budget.limit) : '') : '', x.cost != null ? window.OfficeFormat.cost(x.cost) : ''].filter(Boolean).join(' · ');
              return h('li', { key: x.id, className: 'past-row' },
                h('div', { className: 'past-main' },
                  h('div', { className: 'past-title' }, h('span', { className: 'sess-state' }, h(A.StatusDot, { status: x.state === 'pending' || x.state === 'unknown' ? 'resting' : x.state }), x.state === 'unknown' && x.raw ? 'Unknown: ' + x.raw : x.word), h('b', null, x.title)),
                  facts ? h('div', { className: 'past-meta' }, facts) : null,
                  x.skipped ? h('div', { className: 'past-meta' }, 'This run skipped the office. ' + (x.skippedWhy || '')) : null),
                h('div', { className: 'past-actions' },
                  x.uid ? h(A.Button, { variant: 'ghost', icon: 'chevron-right', onClick: function () { var s = window.officeAdapter.sessionByUid(x.uid); if (s) p.onGo(s); } }, 'Go to desk') : null,
                  !g.readOnly && x.state === 'error' ? h(A.Button, { variant: 'quiet', icon: 'retry', disabled: busy === g.id + x.id, onClick: function () { act('goalRetry', { id: g.id, step: x.id }, g.id + x.id); } }, 'Retry step') : null));
            })) : null,
            !g.readOnly && (open || (g.handoffable && connected)) ? h('div', { className: 'inline-actions' },
              g.status === 'awaiting-approval' ? h(A.Button, { variant: 'emphasis', icon: 'approve', disabled: busy === g.id, onClick: function () { act('goalApprove', { id: g.id }, g.id); } }, 'Approve plan') : null,
              g.handoffable && connected ? h(A.Button, { variant: g.handoff && g.handoff.failed ? 'emphasis' : 'quiet', icon: g.handoff && g.handoff.failed ? 'retry' : 'hq', disabled: busy === g.id, onClick: function () { handoff(g, false); } }, g.handoff && g.handoff.failed ? 'Retry handoff' : 'Hand to Paperclip') : null,
              open ? h(A.Button, { variant: 'quiet', icon: 'decline', disabled: busy === g.id, onClick: function () { act('goalCancel', { id: g.id }, g.id); } }, 'Cancel goal') : null) : null,
            g.handoff && g.handoff.done && p.onHq ? h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'hq', onClick: p.onHq }, 'Open Paperclip HQ')) : null);
        })));
  }

  // The org chart (#202): the floors of the HQ top floor first, a cable (a line) from each employee to its manager, and the editor. Words and
  // options are OfficeVocab.hq.org. A change waits for its painted Confirm, then one call (hqReportingLine). The write grid is the
  // server's seam (#198): while it is not built the Selects are off and say why, and the server refuses the call anyway.
  function OrgChart(p) {
    var o = window.OfficeVocab.hq.org(p.q);
    var ps = useState(null), pend = ps[0], setPend = ps[1];   // { id, manager }: the change that waits for its Confirm
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    function send() {
      setBusy(pend.id);
      client.send('hqReportingLine', { agent: pend.id, manager: pend.manager || null, confirmed: true }).then(function () { setBusy(''); setPend(null); p.toast({ tone: 'success', title: 'Reporting line changed' }); },
        function (x) { setBusy(''); setPend(null); p.toast({ tone: 'error', title: 'Reporting line not changed', text: x.message }); });
    }
    if (!o.floors.length) return h('p', { className: 'note' }, 'No employees yet.');
    return h('div', { className: 'org-chart' },
      h('p', { className: 'note', role: 'status' }, o.note),
      o.floors.map(function (f) {
        return h('section', { key: f.key, id: 'hq-floor-' + f.key, className: 'org-floor' + (p.mark && p.mark('floor', f.key) ? ' is-found' : ''), 'aria-label': f.name + ' floor' },
          h('h4', { className: 'org-floor-name' }, f.name),
          h('ul', { className: 'org-rows' }, f.rows.map(function (r) {
            var waiting = pend && pend.id === r.id;
            return h('li', { key: r.id, className: 'org-row' },
              h('span', { className: 'org-cable' + (r.managerId ? '' : ' is-root'), 'aria-hidden': 'true' }),
              h('div', { className: 'org-who' }, h('b', null, r.name), h(Tag, null, r.role), h('span', { className: 'past-meta' }, r.line)),
              h(A.Select, { id: 'org-' + r.id, ariaLabel: 'Manager of ' + r.name, options: r.options, value: waiting ? pend.manager : r.managerId, disabled: !o.write || busy === r.id,
                onChange: function (v) { setPend(v === r.managerId ? null : { id: r.id, manager: v }); } }),
              waiting ? h('div', { className: 'past-actions' },
                h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === r.id, disabled: busy === r.id, onClick: send }, 'Change reporting line'),
                h(A.Button, { variant: 'quiet', onClick: function () { setPend(null); } }, 'Cancel')) : null);
          })));
      }));
  }

  // Routines (#209), the back office: the routines of the company with New, Edit and Run now. Every change is one call of hqWrite, which the
  // server's write grid decides (the Routines cell). With Allow it goes at once; with Confirm the server answers its ask-first question, the
  // dialog shows what it will send and the painted Confirm sends the same calls again with confirmed: true; Deny is the server's 403.
  // A new routine has no schedule yet (Paperclip adds triggers); Edit changes the cron line of the routine's first schedule.
  function Routines(p) {
    var q = p.q, H = window.OfficeVocab.hq;
    var ed = useState(null), edit = ed[0], setEdit = ed[1];   // { id|null, title, description, agent, status, cron, timezone, trigger }: the form
    var pd = useState(null), pend = pd[0], setPend = pd[1];   // { calls, text }: calls that wait for the painted Confirm
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var agents = [{ value: '', label: 'No employee' }].concat((q.agents || []).map(function (a) { return { value: a.id, label: a.name }; }));
    function send(calls, confirmed, from) {
      setBusy(true); setErr('');
      var i = from || 0;
      (function next() {
        if (i >= calls.length) { setBusy(false); setPend(null); setEdit(null); p.toast({ tone: 'success', title: calls.length > 1 ? 'Routine changed' : H.routineDone(calls[0]) }); return; }
        client.hqWrite(Object.assign({}, calls[i], { confirmed: confirmed === true })).then(function () { i++; next(); }, function (x) {
          setBusy(false);
          var a = window.OfficeAsk.asked(x, 'write', confirmed);
          if (a) { setPend({ calls: calls, from: i, text: a.text }); return; }
          setPend(null); setErr(x.message);
          if (i > 0) p.toast({ tone: 'error', title: 'Routine only partly changed', text: x.message });
        });
      })();
    }
    function save() {
      var calls = H.routineCalls(edit, (q.routines || []).filter(function (r) { return r.id === edit.id; })[0]);
      if (!calls.length) { setErr('Nothing changed.'); return; }
      send(calls, false, 0);
    }
    function set(k) { return function (v) { setEdit(Object.assign({}, edit, (function () { var o = {}; o[k] = v; return o; })())); }; }
    var form = edit ? h(A.Dialog, { open: true, title: edit.id ? 'Edit routine' : 'New routine', onClose: function () { if (!busy) { setEdit(null); setPend(null); setErr(''); } }, actions: [
      h(A.Button, { key: 'c', variant: 'quiet', disabled: busy, onClick: function () { setEdit(null); setPend(null); setErr(''); } }, 'Cancel'),
      pend ? h(A.Button, { key: 'y', variant: 'primary', icon: 'approve', loading: busy, onClick: function () { send(pend.calls, true, pend.from); } }, 'Confirm and send')
        : h(A.Button, { key: 's', variant: 'primary', loading: busy, onClick: save }, edit.id ? 'Save routine' : 'Create routine')] },
      h('div', { className: 'form wide' },
        h(A.TextInput, { id: 'rt-title', label: 'Title', value: edit.title, onChange: set('title'), disabled: !!pend }),
        h(A.TextInput, { id: 'rt-desc', label: 'What to do', value: edit.description, onChange: set('description'), disabled: !!pend }),
        h(A.Select, { id: 'rt-agent', label: 'Employee', options: agents, value: edit.agent, onChange: set('agent'), disabled: !!pend }),
        edit.id ? h(A.Select, { id: 'rt-status', label: 'State', options: H.routineStates, value: edit.status, onChange: set('status'), disabled: !!pend }) : null,
        edit.id && edit.trigger ? h(A.TextInput, { id: 'rt-cron', label: 'Schedule (cron, five fields)', value: edit.cron, placeholder: '0 9 * * 1', onChange: set('cron'), disabled: !!pend }) : null,
        edit.id && !edit.trigger ? h('p', { className: 'note' }, 'This routine has no schedule. Add one in Paperclip.') : null,
        !edit.id ? h('p', { className: 'note' }, 'A new routine has no schedule yet. Add one in Paperclip.') : null,
        pend ? h('p', { className: 'note', role: 'status' }, pend.text) : null,
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null)) : null;
    // Run now has its own small Confirm (one POST, no body), so it never hides in the form.
    var rn = useState(null), run = rn[0], setRun = rn[1];   // { r, text }
    function runNow(r, confirmed) {
      setBusy(true);
      client.hqWrite({ kind: 'routine', action: 'run', routine: r.id, confirmed: confirmed === true }).then(function () { setBusy(false); setRun(null); p.toast({ tone: 'success', title: 'Routine started', text: r.title }); }, function (x) {
        setBusy(false);
        var a = window.OfficeAsk.asked(x, 'write', confirmed);
        if (a) { setRun({ r: r, text: a.text }); return; }
        setRun(null); p.toast({ tone: 'error', title: 'Routine not started', text: x.message });
      });
    }
    var runDialog = run ? h(A.Dialog, { open: true, title: 'Run ' + run.r.title + ' now', onClose: function () { setRun(null); }, actions: [
      h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setRun(null); } }, 'Keep it waiting'),
      h(A.Button, { key: 'y', variant: 'primary', icon: 'approve', loading: busy, onClick: function () { runNow(run.r, true); } }, 'Run routine')] },
      h('div', { className: 'form wide' }, h('p', { className: 'note' }, run.text))) : null;
    var list = q.routines || [];
    return h(React.Fragment, null,
      h('h3', { className: 'ext-h' }, 'Routines'),
      h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'add', onClick: function () { setErr(''); setEdit(H.routineForm(null)); } }, 'New routine')),
      list.length ? h('ul', { className: 'past' }, list.map(function (r) {
        return h('li', { key: r.id, id: 'hq-routine-' + r.id, className: 'past-row' + (p.mark('routine', r.id) ? ' is-found' : '') },
          h('div', { className: 'past-main' },
            h('div', { className: 'past-title' }, h('b', null, r.title), r.status ? h(Tag, null, r.status) : null),
            h('div', { className: 'past-meta' }, H.routineFacts(r)),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'edit', onClick: function () { setErr(''); setEdit(H.routineForm(r)); } }, 'Edit'),
              r.status === 'active' ? h(A.Button, { variant: 'quiet', icon: 'play', disabled: busy, onClick: function () { runNow(r, false); } }, 'Run now') : null)));
      })) : h('p', { className: 'note' }, 'No routines.'),
      form, runDialog);
  }

  // The Lobby (#197): the dashboard of the company, the pending approvals and goals, the live activity and the org chart as floors, top floor
  // first. The words are OfficeVocab.hq (cards, glance, org); unknown data says Unknown. The org chart is the one write here (OrgChart).
  function Lobby(p) {
    var q = p.q, l = q.lobby, H = window.OfficeVocab.hq;
    return h(React.Fragment, null,
      h('h3', { className: 'ext-h' + (p.mark('floor', 'lobby') ? ' is-found' : ''), id: 'hq-floor-lobby' }, 'Lobby'),
      h('ul', { className: 'hq-cards', 'aria-label': 'Company dashboard' }, H.cards(l).map(function (c) {
        return h('li', { key: c.key, className: 'hq-card' }, h('span', { className: 'hq-label' }, c.label), h('b', null, c.value), c.note ? h('span', { className: 'hq-note' }, c.note) : null);
      })),
      l.approvals && l.approvals.items.length ? h('h3', { className: 'ext-h' }, 'Approvals waiting') : null,
      l.approvals && l.approvals.items.length ? h('ul', { className: 'past' }, l.approvals.items.map(function (a) {
        return h('li', { key: a.id, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, a.kind.replace(/_/g, ' ')), a.by ? h(Tag, null, 'From ' + a.by) : null)));
      })) : null,
      h('h3', { className: 'ext-h' + (p.mark('floor', 'rank-0') ? ' is-found' : ''), id: 'hq-floor-goals' }, 'Executive floor: goals'),
      h(Goals, { q: q, toast: p.toast, mark: p.mark }),
      h('h3', { className: 'ext-h' }, 'Org chart'),
      h(OrgChart, { q: q, toast: p.toast, mark: p.mark }),
      h('h3', { className: 'ext-h' }, 'Activity'),
      l.activity === null ? h('p', { className: 'note' }, 'The office could not read the activity.')
        : l.activity.length ? h('ul', { className: 'stats-list' }, l.activity.map(function (x) { return h('li', { key: x.id }, h('span', null, x.text), h('b', null, x.at ? ago(x.at) : '')); }))
        : h('p', { className: 'note' }, 'No activity yet.'));
  }

  // The goals of the company (#207), the executive floor: the goal tree (parents first, children indented), each goal with its state, owner and
  // detail, and the forms to make a goal and to change one. Words and options are OfficeVocab.hq.goals. Every change is one call of hqWrite (the
  // HQ write grid, #198): Allow sends, Confirm shows the exact change here and waits for the Confirm, Deny turns the forms off. Goals are Paperclip's.
  function Goals(p) {
    var v = window.OfficeVocab.hq.goals(p.q), mark = p.mark;
    var os = useState(''), open = os[0], setOpen = os[1];          // the goal id whose detail shows, or 'new'
    var fs = useState({}), form = fs[0], setForm = fs[1];
    var as = useState(null), ask = as[0], setAsk = as[1];          // { body, text }: the change that waits for its Confirm
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    function show(id, row) {
      if (open === id) { setOpen(''); setAsk(null); return; }
      setOpen(id); setAsk(null);
      setForm(row ? { title: row.title, description: row.description, status: row.status.value, owner: row.ownerId } : { title: '', description: '', level: '', parent: '', owner: '' });
    }
    var set = function (k) { return function (val) { var o = Object.assign({}, form); o[k] = val; setForm(o); setAsk(null); }; };
    function send(body, confirmed) {
      setBusy(true);
      client.send('hqWrite', Object.assign({ kind: 'goal' }, body, { confirmed: confirmed === true })).then(function () {
        setBusy(false); setAsk(null); setOpen(''); p.toast({ tone: 'success', title: body.action === 'create' ? 'Goal created' : 'Goal changed', text: body.title || form.title });
      }, function (x) {
        setBusy(false);
        var q = window.OfficeAsk.asked(x, 'write', confirmed);
        if (q) { setAsk({ body: body, text: q.text }); return; }
        setAsk(null); p.toast({ tone: 'error', title: 'Goal not saved', text: x.message });
      });
    }
    function bodyOf(row) {
      if (!row) {
        var b = { action: 'create', title: (form.title || '').trim() };
        if (form.description) b.description = form.description;
        if (form.level) b.level = form.level;
        if (form.parent) b.parent = form.parent;
        if (form.owner) b.owner = form.owner;
        return b;
      }
      var u = { action: 'update', goal: row.id };
      if ((form.title || '').trim() !== row.title) u.title = (form.title || '').trim();
      if ((form.description || '') !== row.description) u.description = form.description || '';
      if (form.status !== row.status.value) u.status = form.status;
      if ((form.owner || '') !== row.ownerId) u.owner = form.owner || null;
      return u;
    }
    function fields(row) {
      var id = 'goal-' + (row ? row.id : 'new'), b = bodyOf(row), changed = row ? Object.keys(b).length > 2 : !!b.title;
      return h('div', { className: 'form wide goal-form' },
        h(A.TextInput, { id: id + '-title', label: 'Title', value: form.title || '', onChange: set('title') }),
        h(O.Area, { id: id + '-desc', label: 'Description', rows: 3, value: form.description || '', onChange: set('description') }),
        h('div', { className: 'row' },
          row ? h(A.Select, { id: id + '-status', label: 'Status', options: v.statusOptions, value: form.status, onChange: set('status') })
            : h(A.Select, { id: id + '-level', label: 'Level', options: v.levelOptions, value: form.level || '', onChange: set('level') }),
          h(A.Select, { id: id + '-owner', label: 'Owner', options: v.ownerOptions, value: form.owner || '', onChange: set('owner') })),
        row ? null : h(A.Select, { id: id + '-parent', label: 'Parent goal', options: v.parentOptions(), value: form.parent || '', onChange: set('parent') }),
        ask ? h('div', { className: 'hq-found', role: 'alert' }, h('span', null, ask.text),
          h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, onClick: function () { send(ask.body, true); } }, 'Send to Paperclip'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAsk(null); } }, 'Cancel'))
          : h('div', { className: 'past-actions' },
            h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, disabled: busy || !changed, onClick: function () { send(b, false); } }, row ? 'Save goal' : 'Create goal'),
            h(A.Button, { variant: 'quiet', onClick: function () { show(row ? row.id : 'new', row); } }, 'Close')));
    }
    return h('div', { className: 'goal-tree' },
      h('p', { className: 'note', role: 'status' }, v.note),
      v.write && !v.unknown ? (open === 'new' ? fields(null) : h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'plus', onClick: function () { show('new', null); } }, 'New goal'))) : null,
      v.unknown ? h('p', { className: 'note' }, 'Unknown: Paperclip did not answer for the goals.')
        : !v.rows.length ? h('p', { className: 'note' }, 'No goals yet.')
        : h('ul', { className: 'past', 'aria-label': 'Goals' }, v.rows.map(function (r) {
          var shown = open === r.id;
          return h('li', { key: r.id, id: 'hq-goal-' + r.id, className: 'past-row goal-row goal-d' + r.depth + (mark && mark('goal', r.id) ? ' is-found' : '') },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.title), h('span', { className: 'sess-state' }, h(A.StatusDot, { status: r.status.key }), r.status.word)),
              h('div', { className: 'past-meta' }, r.line),
              r.description && !shown ? h('div', { className: 'past-sub' }, r.description) : null,
              shown ? fields(r) : null),
            v.write && !shown ? h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'edit', onClick: function () { show(r.id, r); } }, 'Edit')) : null);
        })));
  }

  // Costs (#208), the Finance floor: spend per agent and per project for the last three months, and the budgets. Read from
  // the hqCosts command when the HQ opens. Unknown says Unknown, never $0.00: a month or a cut Paperclip did not answer is null.
  function Costs() {
    var st = useState({ costs: undefined, err: '' }), s = st[0], setS = st[1];
    useEffect(function () {
      var live = true;
      client.get('hqCosts').then(function (j) { if (live) setS({ costs: j.costs || null, err: '' }); }, function (x) { if (live) setS({ costs: null, err: x.message }); });
      return function () { live = false; };
    }, []);
    var F = window.OfficeFormat, c = s.costs;
    function cut(rows) {
      if (!rows) return h('p', { className: 'note' }, 'Unknown: Paperclip did not answer.');
      if (!rows.length) return h('p', { className: 'note' }, 'No spend.');
      return h('ul', { className: 'stats-list' }, rows.map(function (r) { return h('li', { key: r.id }, h('span', null, r.name), h('b', null, r.cost == null ? 'Unknown' : F.money(r.cost))); }));
    }
    function amount(b, v) { return v == null ? 'Unknown' : b.metric === 'billed_cents' ? F.money(v) : F.tokens(v) + ' tokens'; }
    return h('div', { className: 'hq-floor' },
      h('h3', { className: 'ext-h' }, 'Costs'),
      s.err ? h('p', { className: 'ao-err', role: 'alert' }, 'The office could not read the costs. ' + s.err)
        : c === undefined ? h('p', { className: 'note', role: 'status' }, 'Reading the costs.')
        : !c ? h('p', { className: 'note' }, 'The office is not connected to Paperclip.')
        : [
          c.contract && c.contract.length ? h('p', { key: 'k', className: 'ao-err', role: 'alert' }, 'Paperclip answered in a shape the office does not know, so the office does not show that part. ' + c.contract.join(' ')) : null,
          h('h4', { key: 'bh', className: 'ext-h' }, 'Budgets'),
          c.budgets === null ? h('p', { key: 'b', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : c.budgets.length ? h('ul', { key: 'b', className: 'stats-list' }, c.budgets.map(function (b) {
              return h('li', { key: b.id }, h('span', null, b.name + ' (' + b.scope + ')'), h('b', null, amount(b, b.used) + ' of ' + amount(b, b.limit) + (b.percent != null ? ', ' + Math.round(b.percent) + '%' : '') + (b.paused ? ', paused' : '')));
            })) : h('p', { key: 'b', className: 'note' }, 'No budget is set.'),
          c.pausedAgents ? h('p', { key: 'p', className: 'note' }, plural(c.pausedAgents, 'agent', 'agents') + ' paused by a budget.') : null,
          c.months.map(function (m) {
            return h('div', { key: m.key, className: 'hq-floor' },
              h('h4', { className: 'ext-h' }, m.label + ': ' + (m.total == null ? 'Unknown' : F.money(m.total) + (m.partial ? ' or more' : ''))),
              h('p', { className: 'note' }, h('b', null, 'By agent')), cut(m.agents),
              h('p', { className: 'note' }, h('b', null, 'By project')), cut(m.projects));
          })]);
  }

  // Company memory (#205, src/memory.mjs): what the employees of the company learned, each with where it came from. Browse, search,
  // add a fact and forget one. Forget asks first: the server answers 409 (ask-first kind memory) and the row shows a painted Confirm.
  // Keyword search always works; the note says when a local model makes it semantic. Used by the HQ dialog and the Orientation step.
  function MemoryPanel(p) {
    var st = useState({ data: undefined, err: '' }), s = st[0], setS = st[1];
    var qs = useState(''), q = qs[0], setQ = qs[1];
    var ts = useState(''), text = ts[0], setText = ts[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var cf = useState(0), confirm = cf[0], setConfirm = cf[1];   // the id whose Forget waits for the Confirm
    function load(query) {
      return client.get('memory', { q: query || '' }).then(function (j) { setS({ data: j, err: '' }); }, function (x) { setS({ data: null, err: x.message }); });
    }
    useEffect(function () { load(''); }, []);
    function add() {
      setBusy(true); setErr('');
      client.memoryRemember({ text: text }).then(function (r) {
        setBusy(false); setText(''); if (p.onUsed) p.onUsed();
        if (p.toast) p.toast({ tone: 'success', title: 'Company memory', text: r.existed ? 'The company already knew this.' : 'Remembered.' });
        return load(q);
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function forget(id, confirmed) {
      setBusy(true); setErr('');
      client.memoryForget({ id: id, confirmed: confirmed === true ? true : undefined }).then(function () { setBusy(false); setConfirm(0); return load(q); }, function (x) {
        setBusy(false);
        if (window.OfficeAsk.asked(x, 'memory', confirmed === true)) { setConfirm(id); return; }
        setConfirm(0); setErr(x.message);
      });
    }
    var d = s.data;
    if (s.err) return h('p', { className: 'ao-err', role: 'alert' }, 'The office could not read company memory. ' + s.err);
    if (d === undefined) return h('p', { className: 'note', role: 'status' }, 'Reading company memory.');
    var m = d.memory;
    if (!m.available) return h(A.EmptyState, { icon: 'hq', compact: true, title: 'Company memory is off', text: m.reason });
    if (!d.company) return h(A.EmptyState, { icon: 'hq', compact: true, title: 'No company yet', text: 'Company memory belongs to a company. Create your company first.' });
    var how = m.search === 'semantic' ? 'Search finds meaning and words. A local model (' + m.model + ' on ' + m.server + ') makes it so.' : 'Search finds words. It needs no model.' + (m.note ? ' ' + m.note : ' Start Ollama or LM Studio with an embedding model to find meaning too.');
    return h('div', { className: 'hq-floor' },
      h('p', { className: 'note' }, 'What the employees of ' + d.company.name + ' learned. It stays on this PC (' + m.label + '). ' + how),
      h('div', { className: 'inline-actions' },
        h(A.TextInput, { id: 'mem-q', label: 'Search memory', value: q, onChange: setQ }),
        h(A.Button, { variant: 'quiet', icon: 'search', onClick: function () { load(q); } }, 'Search'),
        d.query ? h(A.Button, { variant: 'quiet', onClick: function () { setQ(''); load(''); } }, 'Show all') : null),
      h('div', { className: 'inline-actions' },
        h(A.TextInput, { id: 'mem-add', label: 'Remember a fact (one short sentence)', value: text, onChange: setText }),
        h(A.Button, { variant: 'quiet', icon: 'add', disabled: !text.trim(), loading: busy && !confirm, onClick: add }, 'Remember')),
      err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
      d.items.length ? h('ul', { className: 'past', 'aria-label': 'Memories' }, d.items.map(function (x) {
        var from = x.source === 'user' ? 'You' : x.employee || 'An employee';
        return h('li', { key: x.id, className: 'past-row' },
          h('div', { className: 'past-main' },
            h('div', { className: 'past-title' }, h('b', null, x.text)),
            h('div', { className: 'past-meta' }, [from, x.task ? 'task ' + x.task : '', x.run ? 'run ' + x.run : '', ago(x.at)].filter(Boolean).join(' · '))),
          confirm === x.id
            ? h('div', { className: 'inline-actions' },
              h(A.Button, { variant: 'primary', icon: 'remove', loading: busy, onClick: function () { forget(x.id, true); } }, 'Forget it'),
              h(A.Button, { variant: 'quiet', onClick: function () { setConfirm(0); } }, 'Keep it'))
            : h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { forget(x.id); } }, 'Forget'));
      })) : h('p', { className: 'note' }, d.query ? 'Nothing in memory matches.' : 'Nothing is remembered yet. A run that ends well adds its last words. You can add a fact above.'),
      !d.query && d.total > d.items.length ? h('p', { className: 'note' }, 'Showing the newest ' + d.items.length + ' of ' + d.total + '. Search to find the rest.') : null);
  }

  // Skills, secrets and plugins (#212): company skills, secrets by name (never a value), Paperclip's plugins and adapters. Read only.
  function Catalog() {
    var cat = O.HqCatalog.use(), C = O.HqCatalog;
    return h('div', { className: 'hq-floor' }, h(C.Skills, { cat: cat }), h(C.Secrets, { cat: cat }), h(C.Plugins, { cat: cat }), h(C.Adapters, { cat: cat }));
  }

  // Company admin (#213), owner only: the settings of the company, invites, join requests and members. Read from the hqAccess command
  // when the HQ opens; each change is one write of the write grid (kinds Company and Invites and access) behind a painted Confirm.
  // The page is the owner's (the agent token never reaches it) and the invite link stays in Paperclip: the office shows no token.
  var JOINS = [{ value: 'human', label: 'People' }, { value: 'agent', label: 'Agents' }, { value: 'both', label: 'People and agents' }];
  var ROLES = [{ value: 'admin', label: 'Admin' }, { value: 'operator', label: 'Operator' }, { value: 'viewer', label: 'Viewer' }];
  var MEMBER_ROLES = [{ value: 'owner', label: 'Owner' }].concat(ROLES);
  var APPROVAL = [{ value: 'keep', label: 'Keep as it is' }, { value: 'on', label: 'New employees need approval' }, { value: 'off', label: 'New employees start at once' }];
  function Access(p) {
    var st = useState({ access: undefined, err: '' }), s = st[0], setS = st[1];
    var ps = useState(null), pend = ps[0], setPend = ps[1];      // { key, body, text }: the write that waits for its Confirm
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var fm = useState({ name: p.company || '', approval: 'keep', joins: 'human', role: 'viewer', picks: {} }), form = fm[0], setForm = fm[1];
    function load() {
      client.get('hqAccess').then(function (j) { setS({ access: j.access || null, err: '' }); }, function (x) { setS({ access: null, err: x.message }); });
    }
    useEffect(function () { load(); }, []);
    function set(k) { return function (v) { var n = {}; n[k] = v; setForm(Object.assign({}, form, n)); }; }
    function pick(id, v) { var n = {}; n[id] = v; setForm(Object.assign({}, form, { picks: Object.assign({}, form.picks, n) })); }
    function send() {
      setBusy(true);
      client.send('hqWrite', Object.assign({}, pend.body, { confirmed: true })).then(function () { setBusy(false); p.toast({ tone: 'success', title: 'Done', text: pend.text }); setPend(null); load(); },
        function (x) { setBusy(false); setPend(null); p.toast({ tone: 'error', title: 'Not changed', text: x.message }); });
    }
    function want(key, body, text) { setPend({ key: key, body: body, text: text }); }
    function confirm(key) {
      return pend && pend.key === key ? h('div', { key: 'c' + key, className: 'past-actions' },
        h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, disabled: busy, onClick: send }, 'Confirm: ' + pend.text),
        h(A.Button, { variant: 'quiet', onClick: function () { setPend(null); } }, 'Cancel')) : null;
    }
    var a = s.access, known = (a && a.known) || {};
    function list(rows, empty, row) { return rows.length ? h('ul', { className: 'past' }, rows.map(row)) : h('p', { className: 'note' }, empty); }
    var settings = {};
    if (form.name.trim() && form.name.trim() !== (p.company || '')) settings.name = form.name.trim();
    if (form.approval !== 'keep') settings.requireBoardApprovalForNewAgents = form.approval === 'on';
    var joins = a ? a.joins.filter(function (x) { return x.status === 'pending_approval'; }) : [];
    var live = a ? a.invites.filter(function (x) { return x.state === 'active'; }) : [];
    return h('div', { className: 'hq-floor', id: 'hq-access' },
      h('h3', { className: 'ext-h' }, 'Company admin'),
      h('p', { className: 'note' }, 'Only you, the owner, can change these. Each change asks first, as the write grid says (Company, Invites and access). The invite link stays in Paperclip.'),
      s.err ? h('p', { className: 'ao-err', role: 'alert' }, 'The office could not read the access. ' + s.err)
        : a === undefined ? h('p', { className: 'note', role: 'status' }, 'Reading the access.')
        : !a ? h('p', { className: 'note' }, 'The office is not connected to Paperclip.')
        : [
          a.error ? h('p', { key: 'e', className: 'ao-err', role: 'alert' }, a.error) : null,
          h('h4', { key: 'sh', className: 'ext-h' }, 'Company settings'),
          h('div', { key: 's', className: 'form' },
            h(A.TextInput, { id: 'co-name', label: 'Company name', value: form.name, onChange: set('name') }),
            h(A.Select, { id: 'co-approval', ariaLabel: 'Approval of new employees', options: APPROVAL, value: form.approval, onChange: set('approval') }),
            h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', disabled: !Object.keys(settings).length, onClick: function () { want('co', Object.assign({ kind: 'company', action: 'update' }, settings), 'Save the company settings'); } }, 'Save settings')),
            confirm('co')),
          h('h4', { key: 'ih', className: 'ext-h' }, 'Invites'),
          h('div', { key: 'inew', className: 'form' },
            h(A.Select, { id: 'inv-joins', ariaLabel: 'Who may join', options: JOINS, value: form.joins, onChange: set('joins') }),
            form.joins !== 'agent' ? h(A.Select, { id: 'inv-role', ariaLabel: 'Role of a person', options: ROLES, value: form.role, onChange: set('role') }) : null,
            h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { want('inv', Object.assign({ kind: 'access', action: 'invite', allowedJoinTypes: form.joins }, form.joins !== 'agent' ? { humanRole: form.role } : {}), 'Create the invite'); } }, 'Create invite')),
            confirm('inv')),
          known.invites === false ? h('p', { key: 'iu', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : list(live, 'No invite is open.', function (x) {
              return h('li', { key: x.id, className: 'past-row' },
                h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, (JOINS.filter(function (j) { return j.value === x.joins; })[0] || { label: x.joins }).label), x.role ? h(Tag, null, x.role) : null), x.expiresAt ? h('div', { className: 'past-meta' }, 'Ends ' + new Date(x.expiresAt).toLocaleString()) : null),
                h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'decline', onClick: function () { want('rv' + x.id, { kind: 'access', action: 'revoke', invite: x.id }, 'Revoke the invite'); } }, 'Revoke')),
                confirm('rv' + x.id));
            }),
          h('h4', { key: 'jh', className: 'ext-h' }, 'Join requests'),
          known.joins === false ? h('p', { key: 'ju', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : list(joins, 'No request waits.', function (x) {
              return h('li', { key: x.id, className: 'past-row' },
                h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, x.name), h(Tag, null, x.type === 'agent' ? 'Agent' : 'Person'))),
                h('div', { className: 'past-actions' },
                  h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { want('ja' + x.id, { kind: 'access', action: 'approveJoin', join: x.id }, 'Approve ' + x.name); } }, 'Approve'),
                  h(A.Button, { variant: 'quiet', icon: 'decline', onClick: function () { want('jr' + x.id, { kind: 'access', action: 'rejectJoin', join: x.id }, 'Reject ' + x.name); } }, 'Reject')),
                confirm('ja' + x.id), confirm('jr' + x.id));
            }),
          h('h4', { key: 'mh', className: 'ext-h' }, 'Members'),
          known.members === false ? h('p', { key: 'mu', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : list(a.members, 'No member.', function (x) {
              var v = form.picks[x.id] || x.role || 'viewer';
              return h('li', { key: x.id, className: 'past-row' },
                h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, x.name), h(Tag, null, x.status))),
                h(A.Select, { id: 'mem-' + x.id, ariaLabel: 'Role of ' + x.name, options: MEMBER_ROLES, value: v, onChange: function (nv) { pick(x.id, nv); } }),
                v !== x.role ? h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { want('mm' + x.id, { kind: 'access', action: 'member', member: x.id, role: v }, 'Make ' + x.name + ' ' + v); } }, 'Change role')) : null,
                confirm('mm' + x.id));
            })]);
  }

  // ---------- employee management (#203): pause, let go, budgets and self-approval ----------
  // Every change is one call of hqWrite (the one writer); the write grid decides it. The page shows the exact words of the change with a
  // Confirm and sends it only on the Confirm. The Confirm scrolls into view when it appears, so it stays reachable at 400 px. A move is the
  // reporting line of the org chart (OrgChart). Let go keeps the employee's tasks and history in Paperclip.
  function useConfirm(toast, done) {
    var ps = useState(null), pend = ps[0], setPend = ps[1];   // { body, text, done }: the change that waits for its Confirm
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var ref = React.useRef(null);
    useEffect(function () { if (pend && ref.current && ref.current.scrollIntoView) ref.current.scrollIntoView({ block: 'nearest' }); }, [pend]);
    function send() {
      setBusy(true);
      client.send('hqWrite', Object.assign({}, pend.body, { confirmed: true })).then(function () { setBusy(false); toast({ tone: 'success', title: 'Done', text: pend.done }); setPend(null); if (done) done(); },
        function (x) { setBusy(false); setPend(null); toast({ tone: 'error', title: 'Not changed', text: x.message }); });
    }
    function box() {
      return pend ? h('div', { className: 'past-actions', ref: ref },
        h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, disabled: busy, onClick: send }, 'Confirm: ' + pend.text),
        h(A.Button, { variant: 'quiet', onClick: function () { setPend(null); } }, 'Cancel')) : null;
    }
    return { pend: pend, want: function (body, text, doneText) { setPend({ body: body, text: text, done: doneText || text }); }, box: box };
  }
  function EmployeeTools(p) {
    var a = p.agent, c = useConfirm(p.toast), bs = useState(''), amount = bs[0], setAmount = bs[1];
    var paused = a.status === 'paused', money = amount.trim() === '' ? NaN : Number(amount);
    return h('div', { className: 'hq-manage' },
      h('div', { className: 'past-actions' },
        paused ? h(A.Button, { variant: 'quiet', icon: 'approve', disabled: !p.write || a.busy, onClick: function () { c.want({ kind: 'pause', action: 'resume', agent: a.id }, 'Resume ' + a.name); } }, 'Resume')
          : h(A.Button, { variant: 'quiet', icon: 'pause', disabled: !p.write || a.busy, onClick: function () { c.want({ kind: 'pause', action: 'pause', agent: a.id }, 'Pause ' + a.name); } }, 'Pause'),
        h(A.Button, { variant: 'quiet', icon: 'decline', disabled: !p.write || a.busy, onClick: function () { c.want({ kind: 'pause', action: 'retire', agent: a.id }, 'Let go of ' + a.name + '. Its tasks and history stay in Paperclip', a.name + ' is let go'); } }, 'Let go')),
      h('div', { className: 'form' },
        h(A.TextInput, { id: 'bud-' + a.id, label: 'Monthly budget in dollars', value: amount, onChange: setAmount, disabled: !p.write || a.busy }),
        h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', disabled: !p.write || a.busy || !(money > 0), onClick: function () { c.want({ kind: 'budget', action: 'agent', agent: a.id, budgetDollars: money }, 'Set the budget of ' + a.name + ' to $' + money.toFixed(2) + ' a month', 'Budget set'); } }, 'Set budget'))),
      c.box());
  }
  function CompanyBudget(p) {
    var c = useConfirm(p.toast), bs = useState(''), amount = bs[0], setAmount = bs[1], money = amount.trim() === '' ? NaN : Number(amount);
    return h('div', { className: 'form', id: 'hq-company-budget' },
      h(A.TextInput, { id: 'co-budget', label: 'Company budget per month in dollars', value: amount, onChange: setAmount }),
      h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', disabled: !(money > 0), onClick: function () { c.want({ kind: 'budget', action: 'company', budgetDollars: money }, 'Set the company budget to $' + money.toFixed(2) + ' a month', 'Company budget set'); } }, 'Set company budget')),
      c.box());
  }
  // Self-approval: which approval kinds an employee may approve itself. Turning one on asks first; off is at once. Hire and budget kinds are
  // shown locked: they stay with you (so do access and secrets, which are not approval kinds at all).
  function SelfApproval(p) {
    var st = useState({ s: undefined, err: '' }), v = st[0], setV = st[1];
    var ps = useState(null), pend = ps[0], setPend = ps[1], bz = useState(false), busy = bz[0], setBusy = bz[1];
    var ref = React.useRef(null);
    function load() { client.get('hqGrid').then(function (j) { setV({ s: j.selfApproval || null, err: '' }); }, function (x) { setV({ s: null, err: x.message }); }); }
    useEffect(function () { load(); }, []);
    useEffect(function () { if (pend && ref.current && ref.current.scrollIntoView) ref.current.scrollIntoView({ block: 'nearest' }); }, [pend]);
    function set(type, value, confirmed) {
      setBusy(true);
      client.send('hqSelfApproval', { type: type, value: value, confirmed: confirmed === true }).then(function (j) { setBusy(false); setPend(null); setV({ s: j.selfApproval, err: '' }); p.toast({ tone: 'success', title: 'Self-approval ' + (value ? 'on' : 'off') }); },
        function (x) { setBusy(false); setPend(null); p.toast({ tone: 'error', title: 'Not changed', text: x.message }); });
    }
    var s = v.s;
    return h('div', { className: 'hq-floor', id: 'hq-self-approval' },
      h('h3', { className: 'ext-h' }, 'Self-approval'),
      h('p', { className: 'note' }, 'An employee may approve its own work only for the kinds you turn on. Hires and budgets always stay with you. So do access and secrets.'),
      v.err ? h('p', { className: 'ao-err', role: 'alert' }, 'The office could not read the setting. ' + v.err)
        : s === undefined ? h('p', { className: 'note', role: 'status' }, 'Reading the setting.')
        : !s ? h('p', { className: 'note' }, 'The office could not read the setting.')
        : h('ul', { className: 'past' },
          s.kinds.map(function (k) {
            return h('li', { key: k.type, className: 'past-row' },
              h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, k.label), h(Tag, null, k.on ? 'On' : 'Off')), h('div', { className: 'past-meta' }, k.text)),
              h('div', { className: 'past-actions' }, k.on
                ? h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { set(k.type, false); } }, 'Turn off')
                : h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { setPend(k); } }, 'Turn on')),
              pend && pend.type === k.type ? h('div', { className: 'past-actions', ref: ref },
                h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, disabled: busy, onClick: function () { set(k.type, true, true); } }, 'Confirm: employees approve their own "' + k.label + '"'),
                h(A.Button, { variant: 'quiet', onClick: function () { setPend(null); } }, 'Cancel')) : null);
          }).concat(s.never.map(function (t) {
            return h('li', { key: t, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, t.replace(/_/g, ' ')), h(Tag, null, 'Always yours'))));
          }))));
  }

  // The Confirm of a write that waits for the user (#221): a bar with the exact words of the change. It scrolls into view when it appears,
  // because it sits under a long form in a scrolling dialog (a phone shows one screen of it).
  function ConfirmBar(p) {
    var ref = React.useRef(null);
    useEffect(function () { if (ref.current && ref.current.scrollIntoView) ref.current.scrollIntoView({ block: 'nearest' }); }, []);
    return h('div', { ref: ref, className: 'past-actions' },
      h(A.Button, { variant: 'primary', icon: 'approve', loading: p.busy, disabled: p.busy, onClick: p.onConfirm }, 'Confirm: ' + p.text),
      h(A.Button, { variant: 'quiet', onClick: p.onCancel }, 'Cancel'));
  }
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // Company export and import (#221), next to the office setup export of Agent characters. Export is a read of Paperclip: the file holds no
  // secret value and the office keeps no copy. Import makes a NEW company (one write of the grid's Company cell, behind a painted Confirm that
  // names what the file holds): its routines start paused, and the company shows as another building of the city when it exists.
  var IMPORT_MAX = 10 * 1024 * 1024;
  function Portability(p) {
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var ps = useState(null), pend = ps[0], setPend = ps[1];      // { body, text }: the import that waits for its Confirm
    var er = useState(''), err = er[0], setErr = er[1];
    var nm = useState(''), name = nm[0], setName = nm[1];
    var fileRef = React.useRef(null);
    function doExport() {
      setBusy(true); setErr('');
      client.send('hqCompanyExport', {}).then(function (j) {
        setBusy(false);
        var file = String(p.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-export.json';
        download(file, JSON.stringify({ rootPath: j.rootPath, manifest: j.manifest, files: j.files }, null, 1));
        p.toast({ tone: 'success', title: 'Company exported', text: file + ' holds no secret value.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function ask(body, confirmed) {
      setBusy(true); setErr('');
      return client.send('hqWrite', Object.assign({}, body, confirmed ? { confirmed: true } : {})).then(function (r) {
        setBusy(false); setPend(null);
        p.toast({ tone: 'success', title: 'Company imported', text: (r.name || 'The company') + ' is a new building in the city.' });
      }, function (x) {
        setBusy(false);
        if (!confirmed && x.status === 409 && x.body && x.body.write) setPend({ body: body, text: x.body.write.summary });
        else { setPend(null); setErr(x.message); }
      });
    }
    function pickFile(e) {
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (f.size > IMPORT_MAX) { setErr('This file is too large. The limit is 10 MB.'); return; }
      setErr(''); setPend(null);
      f.text().then(function (t) {
        var j = JSON.parse(t);
        if (!j || typeof j !== 'object' || !j.files || typeof j.files !== 'object') throw new SyntaxError('files');
        var src = j.manifest && j.manifest.source ? { source: j.manifest.source } : undefined;
        var body = { kind: 'company', action: 'import', bundle: { rootPath: j.rootPath || null, manifest: src, files: j.files } };
        if (name.trim()) body.name = name.trim();
        return ask(body, false);
      }).catch(function (x) { setBusy(false); setErr(x instanceof SyntaxError ? 'This file is not a company export.' : x.message); });
    }
    return h('div', { className: 'hq-floor', id: 'hq-portability' },
      h('h3', { className: 'ext-h' }, 'Company export and import'),
      h('p', { className: 'note' }, 'Export saves this company as one file: no secret value is in it, and the office keeps no copy. Import makes a new company from a file like it. Its routines start paused. Only an instance admin of Paperclip can import.'),
      err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
      h('div', { className: 'form' },
        h(A.TextInput, { id: 'co-import-name', label: 'Name of the new company (optional)', value: name, onChange: setName }),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'quiet', icon: 'copy', loading: busy && !pend, disabled: busy, onClick: doExport }, 'Export this company'),
          h(A.Button, { variant: 'quiet', icon: 'add', disabled: busy, onClick: function () { if (fileRef.current) fileRef.current.click(); } }, 'Import a company file'),
          h('input', { ref: fileRef, type: 'file', accept: 'application/json,.json', className: 'persona-file', 'aria-label': 'Company export file', onChange: pickFile, tabIndex: -1 })),
        pend ? h(ConfirmBar, { key: pend.text, busy: busy, text: pend.text, onConfirm: function () { ask(pend.body, true); }, onCancel: function () { setPend(null); } }) : null));
  }

  // Instance and environments (#221), owner only, the top of the HQ: the two general settings of the whole Paperclip, its environments (name,
  // driver and state: never a config or an env value) and the default environment. The office renames and archives an environment and sets the
  // default; it makes and deletes none. Each change is one write of the grid's Instance cell behind a painted Confirm; Paperclip lets only an
  // instance admin do them.
  var SHARING = [{ value: 'prompt', label: 'Ask each time' }, { value: 'allowed', label: 'Allowed' }, { value: 'not_allowed', label: 'Not allowed' }];
  var ON_OFF = [{ value: 'off', label: 'Show it' }, { value: 'on', label: 'Hide it' }];
  function Instance(p) {
    var st = useState({ inst: undefined, err: '' }), s = st[0], setS = st[1];
    var ps = useState(null), pend = ps[0], setPend = ps[1];      // { key, body, text }
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var fm = useState({ censor: null, sharing: null, names: {} }), form = fm[0], setForm = fm[1];
    function load() { client.get('hqInstance').then(function (j) { setS({ inst: j.instance || null, err: '' }); }, function (x) { setS({ inst: null, err: x.message }); }); }
    useEffect(function () { load(); }, []);
    function set(k) { return function (v) { var n = {}; n[k] = v; setForm(Object.assign({}, form, n)); }; }
    function rename(id, v) { var n = {}; n[id] = v; setForm(Object.assign({}, form, { names: Object.assign({}, form.names, n) })); }
    function want(key, body, text) { setPend({ key: key, body: body, text: text }); }
    function send() {
      setBusy(true);
      client.send('hqWrite', Object.assign({}, pend.body, { confirmed: true })).then(function () { setBusy(false); p.toast({ tone: 'success', title: 'Done', text: pend.text }); setPend(null); setForm({ censor: null, sharing: null, names: {} }); load(); },
        function (x) { setBusy(false); setPend(null); p.toast({ tone: 'error', title: 'Not changed', text: x.message }); });
    }
    function confirm(key) { return pend && pend.key === key ? h(ConfirmBar, { key: 'c' + key, busy: busy, text: pend.text, onConfirm: send, onCancel: function () { setPend(null); } }) : null; }
    var i = s.inst, known = (i && i.known) || {};
    var g = i && i.general, censor = form.censor || (g && g.censorUsernameInLogs ? 'on' : 'off'), sharing = form.sharing || (g && g.feedbackDataSharingPreference) || 'prompt';
    var change = {};
    if (g && censor !== (g.censorUsernameInLogs ? 'on' : 'off')) change.censorUsernameInLogs = censor === 'on';
    if (g && sharing !== g.feedbackDataSharingPreference) change.feedbackDataSharingPreference = sharing;
    var envs = i ? i.environments : [];
    var active = envs.filter(function (e) { return e.status === 'active'; });
    return h('div', { className: 'hq-floor', id: 'hq-instance' },
      h('h3', { className: 'ext-h' }, 'Instance and environments'),
      h('p', { className: 'note' }, 'These settings are for the whole Paperclip, not for one company. Only you, the owner, and an instance admin of Paperclip can change them. Each change asks first, as the write grid says (Instance and environments). The office shows no config and no env value of an environment, and it makes and deletes no environment.'),
      s.err ? h('p', { className: 'ao-err', role: 'alert' }, 'The office could not read the instance. ' + s.err)
        : i === undefined ? h('p', { className: 'note', role: 'status' }, 'Reading the instance.')
        : !i ? h('p', { className: 'note' }, 'The office is not connected to Paperclip.')
        : [
          i.error ? h('p', { key: 'e', className: 'ao-err', role: 'alert' }, i.error) : null,
          h('h4', { key: 'gh', className: 'ext-h' }, 'General settings'),
          known.general === false ? h('p', { key: 'gu', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : h('div', { key: 'g', className: 'form' },
              h(A.Select, { id: 'inst-censor', ariaLabel: 'User name in logs', options: ON_OFF, value: censor, onChange: set('censor') }),
              h(A.Select, { id: 'inst-sharing', ariaLabel: 'Sharing of feedback data', options: SHARING, value: sharing, onChange: set('sharing') }),
              h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', disabled: !Object.keys(change).length, onClick: function () { want('gen', Object.assign({ kind: 'instance', action: 'general' }, change), 'Save the instance settings'); } }, 'Save settings')),
              confirm('gen')),
          h('h4', { key: 'dh', className: 'ext-h' }, 'Default environment'),
          known.environments === false ? h('p', { key: 'du', className: 'note' }, 'Unknown: Paperclip did not answer.')
            : h('div', { key: 'd', className: 'form' },
              h(A.Select, { id: 'inst-default', ariaLabel: 'Default environment', options: [{ value: '', label: 'None' }].concat(active.map(function (e) { return { value: e.id, label: e.name }; })), value: form.def === undefined ? (i.defaultEnvironmentId || '') : form.def, onChange: set('def') }),
              h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', disabled: form.def === undefined || form.def === (i.defaultEnvironmentId || ''), onClick: function () { want('def', { kind: 'instance', action: 'defaultEnvironment', environment: form.def || null }, form.def ? 'Set the default environment' : 'Clear the default environment'); } }, 'Save default')),
              confirm('def')),
          h('h4', { key: 'eh', className: 'ext-h' }, 'Environments'),
          known.environments === false ? null
            : envs.length ? h('ul', { key: 'el', className: 'past' }, envs.map(function (e) {
              var v = form.names[e.id] === undefined ? e.name : form.names[e.id], archived = e.status === 'archived';
              return h('li', { key: e.id, className: 'past-row' },
                h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, e.name), h(Tag, null, e.driver), archived ? h(Tag, null, 'Archived') : null, e.isDefault ? h(Tag, null, 'Default') : null), e.description ? h('div', { className: 'past-meta' }, e.description) : null),
                h(A.TextInput, { id: 'env-' + e.id, label: 'Name of ' + e.name, value: v, onChange: function (nv) { rename(e.id, nv); } }),
                h('div', { className: 'past-actions' },
                  v.trim() && v.trim() !== e.name ? h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { want('en' + e.id, { kind: 'instance', action: 'environment', environment: e.id, name: v.trim() }, 'Rename ' + e.name); } }, 'Rename') : null,
                  h(A.Button, { variant: 'quiet', icon: archived ? 'retry' : 'decline', onClick: function () { want('es' + e.id, { kind: 'instance', action: 'environment', environment: e.id, status: archived ? 'active' : 'archived' }, (archived ? 'Restore ' : 'Archive ') + e.name); } }, archived ? 'Restore' : 'Archive')),
                confirm('en' + e.id), confirm('es' + e.id));
            })) : h('p', { key: 'en', className: 'note' }, 'Paperclip has no environment.')]);
  }

  // The HQ: what Paperclip says about its company. Goals, routines and company admin have their own writes (Goals, Routines, Access); the rest
  // is read only. Supervise
  // in office is on the Agents screen of a Security room, with its painted Confirm (no button here: one place for a write).
  function HqDialog(p) {
    var q = p.snap && p.snap.hq, H = window.OfficeVocab.hq;
    // Ctrl+K search (#214): p.focus = { kind, id } names what the user picked. The card says what was found, and the row of an employee,
    // floor or routine is marked and scrolled into view. A task, goal or approval has no row here, so the card is its place.
    var focus = p.focus, found = focus ? ((q && q.search) || []).filter(function (x) { return x.kind === focus.kind && x.id === focus.id; })[0] : null;
    var mark = function (kind, id) { return focus && focus.kind === kind && focus.id === id; };
    useEffect(function () {
      if (!focus) return;
      var el = document.getElementById('hq-' + focus.kind + '-' + focus.id);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    }, [focus && focus.kind, focus && focus.id]);
    var close = [h(A.Button, { key: 'a', variant: 'quiet', onClick: p.onAttach }, 'Connection'), h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')];
    // The runtime panel (install, start, stop, board key) lives here since #197; it is the first step while no company is connected.
    var runtime = O.PaperclipRuntime ? h(O.PaperclipRuntime, { runtime: p.snap && p.snap.paperclipRuntime, toast: p.toast }) : null;
    if (!q || !q.company) return h(A.Dialog, { open: true, title: 'Paperclip HQ', onClose: p.onClose, actions: close },
      h('div', { className: 'form wide' },
        h(A.EmptyState, { icon: 'hq', compact: true, title: 'Paperclip is not connected', text: q ? H.state(q) : 'Install and start Paperclip below, or connect to yours. Then connect it in Attach sessions.' }),
        runtime));
    return h(A.Dialog, { open: true, title: q.company.name + ': Paperclip HQ', onClose: p.onClose, actions: close },
      h('div', { className: 'form wide' },
        h('p', { className: 'note', role: 'status' }, H.state(q)),
        h('p', { className: 'note' }, 'Budget for its runs: ' + H.budget(q.budget) + '. Paperclip keeps this budget. The office sets no second limit on Paperclip runs.'),
        found ? h('div', { className: 'hq-found', role: 'status', 'aria-label': 'Found in Paperclip' }, h(Tag, null, 'Found'), h('b', null, found.label), found.hint ? h('span', { className: 'hq-note' }, found.hint) : null) : null,
        q.contract && q.contract.length ? h('p', { className: 'ao-err', role: 'alert' }, 'Paperclip answered in a shape the office does not know, so the office does not show that part. ' + q.contract.join(' ')) : null,
        q.lobby ? h(Lobby, { q: q, mark: mark, toast: p.toast }) : null,
        h(Costs, null),
        h('h3', { className: 'ext-h' }, 'Office adapter'),
        h(AdapterInstall, { toast: p.toast }),
        h('h3', { className: 'ext-h' }, 'Company memory'),
        h(MemoryPanel, { toast: p.toast }),
        h(Catalog, null),
        h(Access, { company: q.company.name, toast: p.toast }),
        h(SelfApproval, { toast: p.toast }),
        h(CompanyBudget, { toast: p.toast }),
        h(Portability, { company: q.company.name, toast: p.toast }),
        h(Instance, { toast: p.toast }),
        h('h3', { className: 'ext-h' }, 'Agents'),
        q.agents.length ? h('ul', { className: 'past' }, q.agents.map(function (a) {
          var st = H.status(a), sup = H.supervision(a);
          var facts = [a.kind || 'adapter', a.heartbeat.on ? 'Heartbeat ' + H.every(a.heartbeat.every) + (a.heartbeat.last ? ', last ' + ago(a.heartbeat.last) : '') : 'No heartbeat', H.budget(a.budget)].join(' · ');
          return h('li', { key: a.id, id: 'hq-employee-' + a.id, className: 'past-row' + (mark('employee', a.id) ? ' is-found' : '') },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, a.name), h(Tag, null, a.title || a.role), h('span', { className: 'sess-state' }, h(A.StatusDot, { status: st.key }), st.word)),
              h('div', { className: 'past-meta' }, a.task ? (a.task.identifier ? a.task.identifier + ' ' : '') + a.task.title : 'No open task'),
              h('div', { className: 'past-sub mono' }, facts),
              h('div', { className: 'past-meta', title: a.supervision.why || undefined }, sup + (a.supervision.why ? '. ' + a.supervision.why : '')),
              h(EmployeeTools, { agent: a, write: q.employeeWrite !== false, toast: p.toast })));
        })) : h('p', { className: 'note' }, 'This company has no agents yet.'),
        h('h3', { className: 'ext-h' }, 'Projects and workspaces'),
        q.rooms && q.rooms.length ? h('ul', { className: 'past', 'aria-label': 'Project rooms' }, q.rooms.map(function (r) {
          return h('li', { key: r.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.name), r.status ? h(Tag, null, r.status.replace(/_/g, ' ')) : null),
              h('div', { className: 'past-meta' }, r.employees.length ? 'In the room: ' + r.employees.map(function (e) { return e.name + (e.workspace ? ' (' + e.workspace + ')' : ''); }).join(', ') : 'Nobody works here now'),
              r.workspaces.length ? h('div', { className: 'past-sub mono' }, r.workspaces.map(function (w) { return w.name + (w.folder ? ': ' + w.folder : ''); }).join(' · ')) : h('div', { className: 'past-meta' }, 'No workspace')));
        })) : h('p', { className: 'note' }, 'No projects.'),
        h(Routines, { q: q, mark: mark, toast: p.toast }),
        runtime,
        h('p', { className: 'note' }, 'Both schedulers run: Paperclip runs its heartbeats and routines, the office runs its own schedules. The office changes a routine only through the HQ write grid. To hold the Claude Code calls of an agent here, use Supervise in office on the Agents screen of a Security room.')));
  }

  // ---------- the office adapter (#222) ----------
  // Every hire runs through the office adapter, and Paperclip refuses a hire for an adapter it does not have. This part says whether Paperclip has
  // it and, when it does not, installs it: one write of the write grid (kind Office adapter) behind its Confirm. The same part shows in the HQ,
  // in the company step of Orientation and where a hire is refused. The Confirm scrolls into view, so it stays reachable on a phone.
  function useOfficeAdapter() {
    var st = useState({ loaded: false, adapter: null, write: true, err: '' }), s = st[0], setS = st[1];
    var n = useState(0), tick = n[0], setTick = n[1];
    useEffect(function () {
      var live = true;
      client.get('hqAdapter').then(function (j) { if (live) setS({ loaded: true, adapter: j.adapter, write: j.write !== false, err: '' }); },
        function (x) { if (live) setS({ loaded: true, adapter: null, write: true, err: x.message }); });
      return function () { live = false; };
    }, [tick]);
    return Object.assign({ reload: function () { setTick(function (t) { return t + 1; }); } }, s);
  }
  function AdapterInstall(p) {
    var own = useOfficeAdapter(), ad = p.ad || own, W = window.OfficeVocab.hq.adapter(ad.adapter);
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var qs = useState(''), ask = qs[0], setAsk = qs[1];
    var ref = React.useRef(null);
    useEffect(function () { if (ask && ref.current && ref.current.scrollIntoView) ref.current.scrollIntoView({ block: 'nearest' }); }, [ask]);
    function install(confirmed) {
      setBusy(true); setErr('');
      client.send('hqWrite', { kind: 'adapter', action: 'install', confirmed: confirmed === true ? true : undefined }).then(function (r) {
        setBusy(false); setAsk('');
        p.toast({ tone: 'success', title: 'Office adapter installed', text: r && r.requiresRestart ? 'Paperclip loaded it again. Restart Paperclip if a run uses the old copy.' : 'Paperclip loaded it. You can hire now.' });
        ad.reload(); if (p.onDone) p.onDone();
      }, function (x) {
        setBusy(false);
        var a = window.OfficeAsk.asked(x, 'write', confirmed === true);
        if (a) { setAsk(a.text); return; }
        setErr(x.message);
      });
    }
    if (!ad.loaded) return h('p', { className: 'note', role: 'status' }, 'Reading the adapter list of Paperclip.');
    if (ad.err) return h('p', { className: 'ao-err', role: 'alert' }, ad.err);
    return h('div', { className: 'hq-adapter' },
      h('p', { className: 'note', role: 'status' }, W.line + '.'),
      W.why && !W.ok ? h('p', { className: 'note' }, W.why) : null,
      W.install && !ad.write ? h('p', { className: 'note' }, 'The HQ write grid denies this. Allow Office adapter in the write grid to install it here.') : null,
      ask ? h('p', { className: 'note', role: 'alert' }, ask) : null,
      err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
      W.install && ad.write ? h('div', { className: 'inline-actions', ref: ref },
        ask ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, onClick: function () { install(true); } }, 'Confirm install') : h(A.Button, { variant: 'primary', icon: 'add', loading: busy, onClick: function () { install(false); } }, 'Install office adapter'),
        ask ? h(A.Button, { variant: 'quiet', onClick: function () { setAsk(''); } }, 'Do not install') : null) : null);
  }

  // ---------- the HR desk (#201): hire an employee ----------
  // Role cards, then name, manager, agent kind, model, monthly budget and skills. The Hire button asks the office once (ask-first 'write'):
  // the answer is the exact words of what it creates, shown with a Confirm, and only the Confirm sends. A hire has a budget (the office
  // refuses one without) and the office adapter, so the new employee is supervised: its runs go through the Security room. The onboarding
  // task (a first stand-up note on the room board) goes with the same Confirm. One write path: the hqHire command, which ends in hq.write.
  function HireForm(p) {
    var snap = useSnapshot(), q = snap && snap.hq;
    var ds = useState(null), desk = ds[0], setDesk = ds[1];
    var rs = useState(''), role = rs[0], setRole = rs[1];
    var f = useState({ name: '', manager: '', agentKind: 'claude-code', model: '', budget: '20', skills: '' }), v = f[0], setV = f[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var qs = useState(''), ask = qs[0], setAsk = qs[1];
    var actionsRef = React.useRef(null);
    // The Confirm sits under a long form in a scrolling dialog (a phone shows one screen of it): bring it into view when the question comes.
    useEffect(function () { if (ask && actionsRef.current && actionsRef.current.scrollIntoView) actionsRef.current.scrollIntoView({ block: 'nearest' }); }, [ask]);
    var tk = useState(0), tick = tk[0], setTick = tk[1];   // read the desk again after the adapter is installed (#222)
    useEffect(function () { var live = true; client.get('hqHireDesk').then(function (j) { if (live) setDesk(j); }, function (x) { if (live) setErr(x.message); }); return function () { live = false; }; }, [tick]);
    if (!q || !q.company) return h('p', { className: 'note' }, 'Connect a company in Paperclip first. Then you can hire here.');
    if (!desk) return err ? h('p', { className: 'ao-err', role: 'alert' }, err) : h('p', { className: 'note', role: 'status' }, 'Reading the HR desk.');
    if (!desk.write) return h('p', { className: 'note' }, 'The HQ write grid denies hires. Allow them in the write grid to hire here.');
    if (desk.adapter && desk.adapter.state !== 'installed') return h('div', { className: 'form wide' }, h(AdapterInstall, { toast: p.toast, onDone: function () { setTick(tick + 1); } }));
    function set(k, x) { var o = {}; o[k] = x; setV(Object.assign({}, v, o)); setAsk(''); setErr(''); }
    function pick(r) { setRole(r.role); setAsk(''); if (!v.name.trim()) setV(Object.assign({}, v, { name: r.label })); }
    var dollars = Number(v.budget), budgetOk = v.budget.trim() !== '' && isFinite(dollars) && dollars > 0;
    var ready = !!role && !!v.name.trim() && budgetOk;
    function send(confirmed) {
      setBusy(true); setErr('');
      client.hqHire({ name: v.name, role: role, manager: v.manager || undefined, agentKind: v.agentKind, model: v.model.trim() || undefined, budgetDollars: dollars,
        skills: v.skills.split(',').map(function (x) { return x.trim(); }).filter(Boolean), welcome: true, confirmed: confirmed === true ? true : undefined }).then(function (r) {
        setBusy(false); setAsk('');
        var waits = r.pendingApproval ? window.OfficeVocab.plan.hireManager.pending + ' ' : '';
        p.toast({ tone: 'success', title: v.name + ' is hired', text: waits + (r.onboarding === 'sent' ? 'The first stand-up task is sent.' : r.onboarding === 'failed' ? 'The first stand-up task was not sent. ' + r.onboardingError : '') });
        if (p.onDone) p.onDone(r);
      }, function (x) {
        setBusy(false);
        var a = window.OfficeAsk.asked(x, 'write', confirmed === true);
        if (a) { setAsk(a.text); return; }
        setErr(x.message);
      });
    }
    var managers = [{ value: '', label: 'No manager' }].concat((q.agents || []).map(function (a) { return { value: a.id, label: a.name }; }));
    var kinds = ((snap && snap.kinds) || []).map(function (k) { return { value: k.kind, label: k.label }; });
    return h('div', { className: 'form wide' },
      h('div', { className: 'hire-roles', role: 'group', 'aria-label': 'Role' }, desk.roles.map(function (r) {
        return h('div', { key: r.role, className: 'hire-role' }, h(A.Button, { variant: role === r.role ? 'primary' : 'quiet', onClick: function () { pick(r); } }, r.label), h('span', { className: 'hq-note' }, r.text));
      })),
      h(A.TextInput, { id: 'hire-name', label: 'Name', value: v.name, onChange: function (t) { set('name', t); } }),
      h(A.Select, { id: 'hire-manager', label: 'Reports to', options: managers, value: v.manager, onChange: function (t) { set('manager', t); } }),
      kinds.length ? h(A.Select, { id: 'hire-kind', label: 'Agent kind', options: kinds, value: v.agentKind, onChange: function (t) { set('agentKind', t); } }) : null,
      h(A.TextInput, { id: 'hire-model', label: 'Model (optional)', value: v.model, onChange: function (t) { set('model', t); } }),
      h(A.TextInput, { id: 'hire-budget', label: 'Monthly budget in dollars', value: v.budget, onChange: function (t) { set('budget', t); } }),
      h(A.TextInput, { id: 'hire-skills', label: 'Skills (names, separated by commas)', value: v.skills, onChange: function (t) { set('skills', t); } }),
      h('p', { className: 'note' }, 'The new employee runs through the office adapter, so the Security room decides every call. It gets a first task: post a stand-up note on its room board.'),
      !budgetOk ? h('p', { className: 'note', role: 'status' }, 'Set a monthly budget above zero. The office does not hire without one.') : null,
      ask ? h('p', { className: 'note', role: 'alert' }, ask) : null,
      err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
      h('div', { className: 'inline-actions', ref: actionsRef },
        ask ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, onClick: function () { send(true); } }, 'Confirm hire') : h(A.Button, { variant: 'primary', icon: 'add', disabled: !ready, loading: busy, onClick: function () { send(false); } }, 'Hire'),
        ask ? h(A.Button, { variant: 'quiet', onClick: function () { setAsk(''); } }, 'Do not hire') : null));
  }
  function HireDialog(p) {
    return h(A.Dialog, { open: true, title: 'HR desk', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'quiet', onClick: p.onClose }, 'Close')] },
      h(HireForm, { toast: p.toast, onDone: p.onClose }));
  }

  // ---------- earned trust (#153, trust.mjs, ADR 0009) ----------
  // The office proposes a rule from the answers the user gave; it never applies one. A proposal is one building-scope cell for
  // one agent kind. Allow is a looser change, so it asks for a second click (Confirm) and sends confirmed: true. A grant
  // withdraws in one click and the cell goes back to what it was. The Secrets rows are never proposed.
  function TrustDialog(p) {
    var snap = useSnapshot(), t = snap && snap.security && snap.security.trust;
    var sb = useState(null), sure = sb[0], setSure = sb[1];     // the proposal id waiting for its Confirm
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    function run(id, route, body, done) {
      setBusy(id); setErr('');
      client.send(route, body).then(function () { setBusy(''); setSure(null); if (done) p.toast(done); }, function (x) { setBusy(''); setErr(x.message); });
    }
    var proposals = (t && t.proposals) || [], grants = (t && t.grants) || [], cards = (t && t.cards) || [];
    function grantName(g) {
      var S = window.OfficeVocab.security, col = S.columns.filter(function (c) { return c.id === g.col; })[0];
      return (S.rows[g.row] ? S.rows[g.row].label : g.row) + ', ' + (col ? col.label : g.col) + ' in ' + (g.building ? g.building.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'Other folders');
    }
    return h(A.Dialog, { open: true, title: 'Earned trust', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'The office reads your answers and proposes a rule. It never applies one by itself. Each rule needs your Confirm, and you can withdraw it here. Secrets rows are never proposed.'),
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h('h3', { className: 'ext-h' }, 'Proposals'),
        proposals.length ? h('ul', { className: 'past' }, proposals.map(function (x) {
          var asking = sure === x.id;
          return h('li', { key: x.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, x.rowLabel), h(Tag, null, x.agent), h(Tag, null, x.buildingName)),
              h('div', { className: 'past-meta' }, x.text)),
            h('div', { className: 'past-actions' },
              asking ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === x.id, onClick: function () { run(x.id, 'trustApply', { id: x.id, confirmed: true }, { tone: 'success', title: 'Rule granted', text: x.rowLabel + ' for ' + x.agent }); } }, 'Confirm allow') : h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { setSure(x.id); setErr(''); } }, 'Allow'),
              asking ? h(A.Button, { variant: 'quiet', onClick: function () { setSure(null); } }, 'Cancel') : h(A.Button, { variant: 'quiet', icon: 'decline', loading: busy === x.id, onClick: function () { run(x.id, 'trustDismiss', { id: x.id }); } }, 'Not now')));
        })) : h(A.EmptyState, { icon: 'security', compact: true, title: 'No proposals', text: 'A proposal shows after you approve the same kind of call five times with no decline.' }),
        h('h3', { className: 'ext-h' }, 'Rules you granted'),
        grants.length ? h('ul', { className: 'past' }, grants.map(function (g) {
          return h('li', { key: g.id, className: 'past-row' },
            h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, grantName(g))), h('div', { className: 'past-meta' }, 'Granted ' + ago(g.at) + '. Withdraw puts the cell back as it was.')),
            h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'retry', loading: busy === g.id, onClick: function () { run(g.id, 'trustWithdraw', { id: g.id }, { tone: 'success', title: 'Rule withdrawn', text: grantName(g) }); } }, 'Withdraw')));
        })) : h('p', { className: 'note' }, 'No rule was granted from a proposal.'),
        h('h3', { className: 'ext-h' }, 'Trust per agent'),
        cards.length ? h('ul', { className: 'past' }, cards.map(function (c) {
          return h('li', { key: c.col, className: 'past-row' },
            h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, c.agent)),
              h('div', { className: 'past-meta' }, c.clean + ' of ' + c.runs + ' ' + (c.runs === 1 ? 'run' : 'runs') + ' clean · ' + c.declined + ' declined ' + (c.declined === 1 ? 'call' : 'calls') + ' · ' + c.granted + ' ' + (c.granted === 1 ? 'rule' : 'rules') + ' granted')));
        })) : h('p', { className: 'note' }, 'No agent has a history yet.')));
  }

  O.Hq = { Manager: ManagerDialog, Hq: HqDialog, Trust: TrustDialog, Hire: HireDialog, HireForm: HireForm, Memory: MemoryPanel, AdapterInstall: AdapterInstall };
})();
