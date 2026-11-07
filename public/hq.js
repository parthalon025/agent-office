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

  // The Lobby (#197): the dashboard of the company, the pending approvals and goals, the live activity and the org chart as floors, top floor
  // first. The words are OfficeVocab.hq (cards, glance); unknown data says Unknown. Read only: the writes come with the write grid.
  function Lobby(p) {
    var q = p.q, l = q.lobby, H = window.OfficeVocab.hq;
    var floors = (q.floors || []).filter(function (f) { return f.employees.length; }).slice().reverse();
    return h(React.Fragment, null,
      h('h3', { className: 'ext-h' }, 'Lobby'),
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
      floors.length ? h('div', { className: 'hq-floor' }, floors.map(function (f) {
        return h('p', { key: f.key, className: 'note' }, h('b', null, f.name + ': '), f.employees.map(function (e) { return e.name; }).join(', '));
      })) : h('p', { className: 'note' }, 'No employees yet.'),
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

  // The HQ: what Paperclip says about its company. Read only: Paperclip runs its heartbeats, routines and budgets. Supervise
  // in office is on the Agents screen of a Security room, with its painted Confirm (no button here: one place for a write).
  function HqDialog(p) {
    var q = p.snap && p.snap.hq, H = window.OfficeVocab.hq;
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
        q.contract && q.contract.length ? h('p', { className: 'ao-err', role: 'alert' }, 'Paperclip answered in a shape the office does not know, so the office does not show that part. ' + q.contract.join(' ')) : null,
        q.lobby ? h(Lobby, { q: q }) : null,
        h(Costs, null),
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
