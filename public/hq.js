/* Agent Office for Claude Code x0.2: the hq feature (#184, the page features of #168).
   The Manager board, the Paperclip HQ and earned trust (#157, #76, #153). One Module: its Interface is window.OfficePage.Hq = { Manager: ManagerDialog, Hq: HqDialog, Trust: TrustDialog }.
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts. */
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
        v.empty ? h(A.EmptyState, { icon: 'plan', compact: true, title: 'No plan yet', text: 'A goal and its steps show here. Paperclip tasks show here when a company is connected.' }) : null,
        v.groups.map(function (g) {
          var open = g.status === 'planning' || g.status === 'awaiting-approval' || g.status === 'running' || g.status === 'blocked';
          return h('section', { key: g.id, className: 'manager-goal' + (g.frozen ? ' is-frozen' : ''), 'aria-label': g.goal },
            h('div', { className: 'past-title' }, h('b', null, g.goal), h(Tag, null, g.sourceWord), g.readOnly ? h(Tag, null, 'Read only') : null, g.building ? h(Tag, null, buildingName(g.building) || 'Other folders') : null,
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
      l.goals && l.goals.items.length ? h('h3', { className: 'ext-h' }, 'Goals') : null,
      l.goals && l.goals.items.length ? h('ul', { className: 'past' }, l.goals.items.map(function (g) {
        return h('li', { key: g.id, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, g.title), g.status ? h(Tag, null, g.status) : null)));
      })) : null,
      h('h3', { className: 'ext-h' }, 'Org chart'),
      h(OrgChart, { q: q, toast: p.toast, mark: p.mark }),
      h('h3', { className: 'ext-h' }, 'Activity'),
      l.activity === null ? h('p', { className: 'note' }, 'The office could not read the activity.')
        : l.activity.length ? h('ul', { className: 'stats-list' }, l.activity.map(function (x) { return h('li', { key: x.id }, h('span', null, x.text), h('b', null, x.at ? ago(x.at) : '')); }))
        : h('p', { className: 'note' }, 'No activity yet.'));
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

  // The HQ: what Paperclip says about its company. Read only: Paperclip runs its heartbeats, routines and budgets. Supervise
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
        h(Access, { company: q.company.name, toast: p.toast }),
        h('h3', { className: 'ext-h' }, 'Agents'),
        q.agents.length ? h('ul', { className: 'past' }, q.agents.map(function (a) {
          var st = H.status(a), sup = H.supervision(a);
          var facts = [a.kind || 'adapter', a.heartbeat.on ? 'Heartbeat ' + H.every(a.heartbeat.every) + (a.heartbeat.last ? ', last ' + ago(a.heartbeat.last) : '') : 'No heartbeat', H.budget(a.budget)].join(' · ');
          return h('li', { key: a.id, id: 'hq-employee-' + a.id, className: 'past-row' + (mark('employee', a.id) ? ' is-found' : '') },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, a.name), h(Tag, null, a.title || a.role), h('span', { className: 'sess-state' }, h(A.StatusDot, { status: st.key }), st.word)),
              h('div', { className: 'past-meta' }, a.task ? (a.task.identifier ? a.task.identifier + ' ' : '') + a.task.title : 'No open task'),
              h('div', { className: 'past-sub mono' }, facts),
              h('div', { className: 'past-meta', title: a.supervision.why || undefined }, sup + (a.supervision.why ? '. ' + a.supervision.why : ''))));
        })) : h('p', { className: 'note' }, 'This company has no agents yet.'),
        h('h3', { className: 'ext-h' }, 'Projects and workspaces'),
        q.rooms && q.rooms.length ? h('ul', { className: 'past', 'aria-label': 'Project rooms' }, q.rooms.map(function (r) {
          return h('li', { key: r.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.name), r.status ? h(Tag, null, r.status.replace(/_/g, ' ')) : null),
              h('div', { className: 'past-meta' }, r.employees.length ? 'In the room: ' + r.employees.map(function (e) { return e.name + (e.workspace ? ' (' + e.workspace + ')' : ''); }).join(', ') : 'Nobody works here now'),
              r.workspaces.length ? h('div', { className: 'past-sub mono' }, r.workspaces.map(function (w) { return w.name + (w.folder ? ': ' + w.folder : ''); }).join(' · ')) : h('div', { className: 'past-meta' }, 'No workspace')));
        })) : h('p', { className: 'note' }, 'No projects.'),
        h('h3', { className: 'ext-h' }, 'Routines'),
        q.routines.length ? h('ul', { className: 'past' }, q.routines.map(function (r) {
          return h('li', { key: r.id, id: 'hq-routine-' + r.id, className: 'past-row' + (mark('routine', r.id) ? ' is-found' : '') },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, r.title), r.status ? h(Tag, null, r.status) : null),
              h('div', { className: 'past-meta' }, [r.agent ? 'For ' + r.agent : '', r.cron ? 'Cron ' + r.cron : '', r.next ? 'Next ' + new Date(r.next).toLocaleString() : 'No next run'].filter(Boolean).join(' · '))));
        })) : h('p', { className: 'note' }, 'No routines.'),
        runtime,
        h('p', { className: 'note' }, 'Both schedulers run: Paperclip runs its heartbeats and routines, the office runs its own schedules. The office never starts, changes or stops a Paperclip run. To hold the Claude Code calls of an agent here, use Supervise in office on the Agents screen of a Security room.')));
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

  O.Hq = { Manager: ManagerDialog, Hq: HqDialog, Trust: TrustDialog };
})();
