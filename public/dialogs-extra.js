/* Agent Office for Claude Code x0.2: the office dialogs (split out of office.js, #1 story 26).
   The Manager board, the HQ, earned trust, agent characters (personas), the weekly recap, the Reception and the lobby tour.
   Plain functions over the page core (window.OfficePage); they put their names on it for office.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, F = O.F, Pair = O.Pair, Tag = O.Tag, ago = O.ago, api = O.api, call = O.call,
      money = O.money, plural = O.plural, useSnapshot = O.useSnapshot;

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
      api(route, body).then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: 'Manager', text: x.message }); });
    }
    // The first call has no confirmed: the server answers 409 with the exact tasks it would create. The Confirm sends the same call again.
    function handoff(g, confirmed) {
      setBusy(g.id);
      api('/api/goal/handoff', { id: g.id, confirmed: confirmed === true }).then(function () {
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
                  !g.readOnly && x.state === 'error' ? h(A.Button, { variant: 'quiet', icon: 'retry', disabled: busy === g.id + x.id, onClick: function () { act('/api/goal/retry', { id: g.id, step: x.id }, g.id + x.id); } }, 'Retry step') : null));
            })) : null,
            !g.readOnly && (open || (g.handoffable && connected)) ? h('div', { className: 'inline-actions' },
              g.status === 'awaiting-approval' ? h(A.Button, { variant: 'emphasis', icon: 'approve', disabled: busy === g.id, onClick: function () { act('/api/goal/approve', { id: g.id }, g.id); } }, 'Approve plan') : null,
              g.handoffable && connected ? h(A.Button, { variant: g.handoff && g.handoff.failed ? 'emphasis' : 'quiet', icon: g.handoff && g.handoff.failed ? 'retry' : 'hq', disabled: busy === g.id, onClick: function () { handoff(g, false); } }, g.handoff && g.handoff.failed ? 'Retry handoff' : 'Hand to Paperclip') : null,
              open ? h(A.Button, { variant: 'quiet', icon: 'decline', disabled: busy === g.id, onClick: function () { act('/api/goal/cancel', { id: g.id }, g.id); } }, 'Cancel goal') : null) : null,
            g.handoff && g.handoff.done && p.onHq ? h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'hq', onClick: p.onHq }, 'Open Paperclip HQ')) : null);
        })));
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
      api(route, body).then(function () { setBusy(''); setSure(null); if (done) p.toast(done); }, function (x) { setBusy(''); setErr(x.message); });
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
              asking ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy === x.id, onClick: function () { run(x.id, '/api/trust/apply', { id: x.id, confirmed: true }, { tone: 'success', title: 'Rule granted', text: x.rowLabel + ' for ' + x.agent }); } }, 'Confirm allow') : h(A.Button, { variant: 'quiet', icon: 'approve', onClick: function () { setSure(x.id); setErr(''); } }, 'Allow'),
              asking ? h(A.Button, { variant: 'quiet', onClick: function () { setSure(null); } }, 'Cancel') : h(A.Button, { variant: 'quiet', icon: 'decline', loading: busy === x.id, onClick: function () { run(x.id, '/api/trust/dismiss', { id: x.id }); } }, 'Not now')));
        })) : h(A.EmptyState, { icon: 'security', compact: true, title: 'No proposals', text: 'A proposal shows after you approve the same kind of call five times with no decline.' }),
        h('h3', { className: 'ext-h' }, 'Rules you granted'),
        grants.length ? h('ul', { className: 'past' }, grants.map(function (g) {
          return h('li', { key: g.id, className: 'past-row' },
            h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, grantName(g))), h('div', { className: 'past-meta' }, 'Granted ' + ago(g.at) + '. Withdraw puts the cell back as it was.')),
            h('div', { className: 'past-actions' }, h(A.Button, { variant: 'quiet', icon: 'retry', loading: busy === g.id, onClick: function () { run(g.id, '/api/trust/withdraw', { id: g.id }, { tone: 'success', title: 'Rule withdrawn', text: grantName(g) }); } }, 'Withdraw')));
        })) : h('p', { className: 'note' }, 'No rule was granted from a proposal.'),
        h('h3', { className: 'ext-h' }, 'Trust per agent'),
        cards.length ? h('ul', { className: 'past' }, cards.map(function (c) {
          return h('li', { key: c.col, className: 'past-row' },
            h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, c.agent)),
              h('div', { className: 'past-meta' }, c.clean + ' of ' + c.runs + ' ' + (c.runs === 1 ? 'run' : 'runs') + ' clean · ' + c.declined + ' declined ' + (c.declined === 1 ? 'call' : 'calls') + ' · ' + c.granted + ' ' + (c.granted === 1 ? 'rule' : 'rules') + ' granted')));
        })) : h('p', { className: 'note' }, 'No agent has a history yet.')));
  }

  // ---------- agent characters (#150) ----------
  // A persona is the look (shape, color, accessory) and the working style of an agent, saved by its name. The style changes
  // how the agent talks and nothing it may do. The office reads the look at once; the style applies to the next session the
  // office opens with that name. The record is personas.mjs; the words are OfficeVocab.persona.
  var PV = window.OfficeVocab.persona;
  var P_SHAPES = [['round', 'Round'], ['square', 'Square'], ['tall', 'Tall'], ['wide', 'Wide']];
  var P_ACC = ['none', 'glasses', 'hat', 'headset', 'scarf'];
  var P_STYLES = ['careful', 'fast', 'chatty'];
  var P_STYLE_NOTE = { careful: 'Checks its work and says what it is unsure about.', fast: 'Short replies. The result comes first.', chatty: 'Friendly. Says what it plans to do next.' };
  function PersonasDialog(p) {
    var snap = useSnapshot();
    var ls = useState(null), list = ls[0], setList = ls[1];
    var fm = useState(null), form = fm[0], setForm = fm[1];     // the persona in the editor, or null
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var tm = useState({}), teams = tm[0], setTeams = tm[1];
    var te = useState(null), tform = te[0], setTform = te[1];   // the team template in the editor, or null
    var importRef = React.useRef(null);
    var fo = useState(p.folder || ''), folder = fo[0], setFolder = fo[1];   // where a character or a squad starts
    function load() { call('/api/personas').then(function (r) { return r.json(); }).then(function (j) { setList(j.personas || {}); setTeams(j.teams || {}); }, function (x) { setList({}); setErr(x.message); }); }
    useEffect(load, []);
    // Start an agent from a character, or a squad from a team template (#152). Each agent gets its own room. A cost question or a refusal is shown, never skipped.
    function startAgent(r) {
      setBusy(true); setErr('');
      api('/api/open', { persona: r.name, cwd: folder }).then(function () { setBusy(false); p.toast({ tone: 'success', title: 'Agent started', text: r.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function startSquad(t) {
      setBusy(true); setErr('');
      api('/api/team/start', { team: t.name, cwd: folder }).then(function (j) {
        setBusy(false);
        var bad = (j.started || []).filter(function (m) { return m.error; });
        p.toast({ tone: bad.length ? 'error' : 'success', title: bad.length ? 'Squad started with problems' : 'Squad started', text: bad.length ? bad[0].name + ': ' + bad[0].error : t.name });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function addStarters() {
      setBusy(true); setErr('');
      api('/api/persona/starters', {}).then(function (j) { setBusy(false); load(); p.toast({ tone: 'success', title: j.added ? 'Starters added' : 'No new starters', text: j.added ? 'Reviewer, Fixer, Researcher and a team.' : 'You have them all.' }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function saveTeam() {
      setBusy(true); setErr('');
      var members = String(tform.members || '').split(',').map(function (m) { return m.trim(); }).filter(Boolean);
      api('/api/team/save', { name: tform.name, members: members }).then(function () { setBusy(false); setTform(null); load(); p.toast({ tone: 'success', title: 'Team saved', text: tform.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function delTeam(name) {
      setBusy(true); setErr('');
      api('/api/team/delete', { name: name }).then(function () { setBusy(false); load(); }, function (x) { setBusy(false); setErr(x.message); });
    }
    // Export and import: one JSON file of the setup (characters, teams, floor layouts, wall screens). It holds no Security rules.
    function exportSetup() {
      call('/api/custom/export').then(function (r) { return r.text(); }).then(function (t) {
        var url = URL.createObjectURL(new Blob([t], { type: 'application/json;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url; a.download = 'agent-office-setup.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        p.toast({ tone: 'success', title: 'Setup exported', text: 'agent-office-setup.json' });
      }, function (x) { setErr(x.message); });
    }
    function importSetup(e) {
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      setBusy(true); setErr('');
      f.text().then(function (t) { return api('/api/custom/import', { data: JSON.parse(t) }); }).then(function (j) {
        setBusy(false); load(); p.toast({ tone: 'success', title: 'Setup imported', text: j.personas + ' characters, ' + j.teams + ' teams' });
      }, function (x) { setBusy(false); setErr(x instanceof SyntaxError ? 'This file is not JSON.' : x.message); });
    }
    var colors = Array.prototype.slice.call(window.AgentOffice.BODY_COLORS || []);
    var saved = Object.keys(list || {}).map(function (k) { return list[k]; });
    var live = ((snap && snap.sessions) || []).filter(function (s) { return s.status !== 'ended' && !s.pseudo; }).map(function (s) { return s.name; })
      .filter(function (n, i, a) { return n && a.indexOf(n) === i && !(list && list[String(n).trim().toLowerCase()]); });
    function set(k) { return function (v) { var n = Object.assign({}, form); n[k] = v; setForm(n); }; }
    function save() {
      setBusy(true); setErr('');
      api('/api/persona/save', form).then(function () { setBusy(false); setForm(null); load(); p.toast({ tone: 'success', title: 'Character saved', text: form.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function del(name) {
      setBusy(true); setErr('');
      api('/api/persona/delete', { name: name }).then(function () { setBusy(false); setForm(null); load(); p.toast({ tone: 'success', title: 'Character removed', text: name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function look(r) { var l = PV.lookOf(r, colors) || {}; return { shape: l.shape || 'blob', color: l.color || colors[0] }; }
    function row(r) {
      var l = look(r);
      return h('li', { key: r.name, className: 'past-row' },
        h('div', { className: 'past-main' },
          h('div', { className: 'past-title' }, h(A.BotAvatar, { shape: l.shape, color: l.color, status: 'resting', size: 28 }), h('b', null, r.name)),
          h('div', { className: 'past-meta' }, [PV.styleWord(r.style) || 'No style', r.accessory && r.accessory !== 'none' ? PV.accessoryWord(r.accessory) : null].filter(Boolean).join(' · '))),
        h('div', { className: 'past-actions' },
          h(A.Button, { variant: 'quiet', disabled: busy || !folder, onClick: function () { startAgent(r); } }, 'Start'),
          h(A.Button, { variant: 'quiet', onClick: function () { setForm(Object.assign({}, r)); } }, 'Edit'),
          h(A.Button, { variant: 'quiet', icon: 'remove', disabled: busy, onClick: function () { del(r.name); } }, 'Remove')));
    }
    if (form) {
      var fl = look(form);
      return h(A.Dialog, { open: true, title: 'Agent character', onClose: p.onClose, actions: [
        h(A.Button, { key: 'b', variant: 'quiet', onClick: function () { setForm(null); setErr(''); } }, 'Back'),
        h(A.Button, { key: 's', variant: 'primary', loading: busy, disabled: !String(form.name || '').trim(), onClick: save }, 'Save character')] },
        h('div', { className: 'form' },
          h('div', { className: 'persona-preview', 'aria-label': 'Preview of the bot' },
            h(A.BotAvatar, { shape: fl.shape, color: fl.color, status: 'working', size: 64 }),
            h('span', { className: 'persona-acc' }, form.accessory && form.accessory !== 'none' ? 'Wears: ' + PV.accessoryWord(form.accessory).toLowerCase() : 'No accessory')),
          h(A.TextInput, { id: 'p-name', label: 'Agent name', value: form.name || '', onChange: set('name'), hint: 'The bot name in the office. A new session with this name gets the character.', error: err || undefined }),
          Pair(
            h(A.Select, { id: 'p-style', label: 'Working style', options: [{ value: '', label: 'No style' }].concat(P_STYLES.map(function (k) { return { value: k, label: PV.styleWord(k) }; })), value: form.style || '', onChange: set('style') }),
            h(A.Select, { id: 'p-acc', label: 'Accessory', options: P_ACC.map(function (k) { return { value: k, label: PV.accessoryWord(k) }; }), value: form.accessory || 'none', onChange: set('accessory') })),
          Pair(
            h(A.Select, { id: 'p-shape', label: 'Shape', options: P_SHAPES.map(function (s) { return { value: s[0], label: s[1] }; }), value: form.shape || 'round', onChange: set('shape') }),
            h(A.Select, { id: 'p-color', label: 'Color', options: colors.slice(0, PV.COLOR_COUNT).map(function (c, i) { return { value: String(i), label: PV.colorWord(i) }; }), value: String(form.color == null ? 0 : form.color), onChange: function (v) { set('color')(+v); } })),
          h(Area, { id: 'p-role', label: 'Role', rows: 3, value: form.role || '', onChange: set('role'), hint: 'What this agent does. It is added to the prompt as text.' }),
          h(A.TextInput, { id: 'p-model', label: 'Model', value: form.model || '', onChange: set('model'), hint: 'Leave empty for the default model.' }),
          h('p', { className: 'note' }, (form.style ? P_STYLE_NOTE[form.style] + ' ' : '') + 'A style changes only how the agent talks. It never changes what the agent may do. The Security room decides that.'),
          h('p', { className: 'note' }, 'The bot raises a hand when it needs you, scratches its head after an error and stretches when it is finished. Reduced motion turns this off.')));
    }
    if (tform) {
      return h(A.Dialog, { open: true, title: 'Team template', onClose: p.onClose, actions: [
        h(A.Button, { key: 'b', variant: 'quiet', onClick: function () { setTform(null); setErr(''); } }, 'Back'),
        h(A.Button, { key: 's', variant: 'primary', loading: busy, disabled: !String(tform.name || '').trim() || !String(tform.members || '').trim(), onClick: saveTeam }, 'Save team')] },
        h('div', { className: 'form' },
          h(A.TextInput, { id: 't-name', label: 'Team name', value: tform.name || '', onChange: function (v) { setTform(Object.assign({}, tform, { name: v })); }, error: err || undefined }),
          h(A.TextInput, { id: 't-members', label: 'Characters', value: tform.members || '', onChange: function (v) { setTform(Object.assign({}, tform, { members: v })); }, hint: 'Names of saved characters, split by commas. Up to 8. Each one starts in a room of its own.' })));
    }
    var squads = Object.keys(teams || {}).map(function (k) { return teams[k]; });
    function teamRow(t) {
      return h('li', { key: t.name, className: 'past-row' },
        h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, t.name)), h('div', { className: 'past-meta' }, t.members.join(', '))),
        h('div', { className: 'past-actions' },
          h(A.Button, { variant: 'quiet', disabled: busy || !folder, onClick: function () { startSquad(t); } }, 'Start squad'),
          h(A.Button, { variant: 'quiet', onClick: function () { setTform({ name: t.name, members: t.members.join(', ') }); } }, 'Edit'),
          h(A.Button, { variant: 'quiet', icon: 'remove', disabled: busy, onClick: function () { delTeam(t.name); } }, 'Remove')));
    }
    return h(A.Dialog, { open: true, title: 'Agent characters', onClose: p.onClose, actions: [
      h(A.Button, { key: 'n', variant: 'quiet', icon: 'add', onClick: function () { setForm({ name: '', style: '', shape: 'round', color: 0, accessory: 'none' }); } }, 'New character'),
      h(A.Button, { key: 't', variant: 'quiet', icon: 'add', onClick: function () { setTform({ name: '', members: '' }); } }, 'New team'),
      h(A.Button, { key: 'e', variant: 'quiet', onClick: exportSetup }, 'Export setup'),
      h(A.Button, { key: 'i', variant: 'quiet', disabled: busy, onClick: function () { if (importRef.current) importRef.current.click(); } }, 'Import setup'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'Give an agent a look, a role and a working style. The style changes how it talks, not what it may do.'),
        h('input', { ref: importRef, type: 'file', accept: 'application/json,.json', className: 'persona-file', 'aria-label': 'Import setup file', onChange: importSetup, tabIndex: -1 }),
        h(A.TextInput, { id: 'p-folder', label: 'Start in folder', value: folder, onChange: setFolder, hint: 'A character or a squad starts here, each in a room of its own.' }),
        list !== null && !saved.length ? h(A.Button, { variant: 'primary', loading: busy, onClick: addStarters }, 'Add starter characters') : null,
        squads.length ? h('h3', { className: 'ext-h' }, 'Teams') : null,
        squads.length ? h('ul', { className: 'past' }, squads.map(teamRow)) : null,
        squads.length ? h('h3', { className: 'ext-h' }, 'Characters') : null,
        h(Busy, { on: list === null }),
        err ? h('p', { className: 'note', role: 'alert' }, err) : null,
        list !== null && !saved.length ? h(A.EmptyState, { icon: 'bot', title: 'No characters yet', text: 'A bot has its default look until you give it a character.' }) : null,
        saved.length ? h('ul', { className: 'past' }, saved.map(row)) : null,
        live.length ? h('div', { className: 'persona-live' },
          h('span', { className: 'note' }, 'Bots in the office:'),
          live.map(function (n) { return h(A.Button, { key: n, variant: 'quiet', icon: 'add', onClick: function () { setForm({ name: n, style: '', shape: 'round', color: 0, accessory: 'none' }); } }, n); })) : null));
  }

  // ---------- weekly recap, while you were away, Focus mode (#151) ----------
  var AWAY_KEY = 'ao_away_since';
  function awaySince() { try { var v = Number(localStorage.getItem(AWAY_KEY)); return v > 0 ? v : Date.now() - 24 * 3600000; } catch (x) { return Date.now() - 24 * 3600000; } }
  function awayMark() { try { localStorage.setItem(AWAY_KEY, String(Date.now())); } catch (x) { /* the list then starts 24 hours back */ } }
  function RecapDialog(p) {
    var ls = useState(null), r = ls[0], setR = ls[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var since = useState(awaySince)[0];
    useEffect(function () { call('/api/recap?since=' + since).then(function (x) { return x.json(); }).then(setR, function (x) { setErr(x.message); }); }, []);
    function close() { awayMark(); p.onClose(); }
    function focus(on) { setBusy(true); api('/api/settings/focus', { on: on }).then(function () { setBusy(false); setR(Object.assign({}, r, { focus: on })); p.toast({ tone: 'info', title: on ? 'Focus mode is on' : 'Focus mode is off', text: on ? 'Sound, motion and rituals are off.' : 'Rituals are back.' }); }, function (x) { setBusy(false); setErr(x.message); }); }
    var m = r && r.metrics;
    function num(v, unit) { return v == null ? 'No data yet' : v + (unit || ''); }
    function row(k, title, meta) { return h('li', { key: k, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h('b', null, title)), meta ? h('div', { className: 'past-meta' }, meta) : null)); }
    return h(A.Dialog, { open: true, title: 'Weekly recap', onClose: close, actions: [
      h(A.Button, { key: 'f', variant: 'quiet', icon: 'sound-off', loading: busy, disabled: !r, onClick: function () { focus(!(r && r.focus)); } }, r && r.focus ? 'Turn off Focus mode' : 'Turn on Focus mode'),
      h(A.Button, { key: 'd', variant: 'primary', onClick: close }, 'Done')] },
      h('div', { className: 'form wide' },
        h(Busy, { on: !r && !err }),
        err ? h('p', { className: 'note', role: 'alert' }, err) : null,
        r ? h('div', null,
          h('p', { className: 'note' }, 'Last ' + r.days + ' days. Cost counts the sessions that started in this time.'),
          h('ul', { className: 'past' },
            row('ship', F.plural(r.shipped.length, 'change', 'changes') + ' shipped', r.shipped.slice(0, 5).map(function (x) { return '#' + x.number + ' ' + x.title; }).join(' · ')),
            row('cost', money(r.cost) + ' spent'),
            row('apm', 'Approvals per merge: ' + num(m.approvalsPerMerge), F.plural(m.approvals, 'approval', 'approvals') + ' for ' + F.plural(m.merges, 'merge', 'merges')),
            row('mtm', 'Minutes from done to merged: ' + num(m.minutesToMerge)),
            row('iph', 'Interruptions per hour: ' + num(m.interruptionsPerHour), F.plural(m.interruptions, 'answer', 'answers') + ' from you')),
          r.best.length ? h('div', null, h('h3', null, 'Best moments'), h('ul', { className: 'past' }, r.best.map(function (b) { return row('b-' + b.name, b.name, b.text); }))) : null,
          h('h3', null, 'While you were away'),
          r.away.length ? h('ul', { className: 'past' }, r.away.map(function (a, i) { return row('a' + i, a.text, F.clock ? F.clock(a.t) : ''); })) : h('p', { className: 'note' }, 'Nothing happened since your last visit.')) : null));
  }

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

  Object.assign(O, { HqDialog: HqDialog, ManagerDialog: ManagerDialog, PersonasDialog: PersonasDialog,
      RecapDialog: RecapDialog, ReceptionDialog: ReceptionDialog, TourCard: TourCard, TrustDialog: TrustDialog,
      setTourSeen: setTourSeen, tourSeen: tourSeen });
})();
