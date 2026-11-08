/* Agent Office for Claude Code x0.2: Needs you and the phone list (split out of office.js, #1 story 26).
   The request rows with their three layers (RequestLayers), GroupRow, QueueList (uses Merge.use and Merge.Row), NeedsDialog,
   PhoneView (#148; PHONE_MAX; below 820 px) and openPalette. The paper flow itself (Ready to merge, the pipeline board) is
   in merge.js. The Paperclip HQ card of the phone list lists the employees and what needs the user from OfficeVocab.hq.phone
   (#215). A Paperclip approval row decides the approval (Hq.ApprovalDecide). A task row links to the task in Paperclip (Hq.PaperclipLink) and has Open Paperclip HQ.
   Plain functions over the page core (window.OfficePage); they put their names on it for office.js.
   Interface: OfficePage.Needs = { Dialog, Phone, PHONE_MAX, openPalette }. Needs page-core.js and merge.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Tag = O.Tag, ago = O.ago, client = O.client, clip = O.clip, plural = O.plural, refocusRow = O.refocusRow,
      sceneName = O.sceneName, useSnapshot = O.useSnapshot;

  // The three layers of a request (#149): intent and reason (written by a local model when one is ready, else only the agent's
  // own reason), then the raw command. The raw command is always there: a summary never replaces it.
  function RequestLayers(p) {
    var L = window.OfficeVocab.explainLayers(p.r);
    return h('div', { className: 'req-layers' },
      L.intent ? h('div', { className: 'past-snip req-intent' }, L.intent) : h('div', { className: 'past-snip' }, p.r.text),
      L.reason ? h('div', { className: 'past-snip' }, h('em', null, 'reason: '), L.reason) : null,
      h('div', { className: 'req-raw mono', title: L.raw }, h('em', null, 'command: '), clip(L.raw.replace(/\s+/g, ' '), 300)),
      L.explained ? h('div', { className: 'past-meta mono' }, 'Written by ' + (L.model || 'a local model') + '. Check the command.') : null);
  }
  // Similar open requests, answered together. Each request still gets its own answer.
  function GroupRow(p) {
    var g = p.g, first = g.items[0], off = p.busy === g.key;
    return h('li', { className: 'past-row req-group' },
      h('div', { className: 'past-main' },
        h('div', { className: 'past-title' }, h(A.Icon, { name: 'waiting', size: 16 }), h('b', null, plural(g.count, 'similar request', 'similar requests')), h(Tag, null, first.tool), h(A.RiskBadge, { risk: first.risk })),
        h(RequestLayers, { r: g.items.filter(function (r) { return r.explain; })[0] || first }),
        h('div', { className: 'past-meta mono' }, g.items.map(function (r) { return sceneName({ uid: r.uid, name: r.bot }) + ' in ' + r.buildingName; }).join(' · '))),
      h('div', { className: 'past-actions' },
        h(A.Button, { variant: 'emphasis', icon: 'approve', disabled: off, onClick: function () { p.onAnswer(g, true); } }, 'Approve ' + g.count),
        h(A.Button, { variant: 'quiet', icon: 'decline', disabled: off, onClick: function () { p.onAnswer(g, false); } }, 'Decline ' + g.count)));
  }

  // ---------- Needs you: every open request and question of every building ----------
  // The one queue as a list, with Approve and Decline on each row: the Needs you dialog and the phone list show it (#148).
  function QueueList(p) {
    var snap = useSnapshot();
    var list = snap ? window.officeAdapter.queue(snap).items : [];
    var bz = useState(''), busy = bz[0], setBusy = bz[1], box = React.useRef(null), lastIdx = React.useRef(0), M = O.Merge.use(p.toast);
    // After an answer the row goes. Keep the focus inside the dialog, on the row that took its place.
    useEffect(function () { refocusRow(box.current, lastIdx.current); }, [list.map(function (r) { return r.id; }).join('|')]);
    var groups = window.OfficeVocab.requestGroups(list);
    // A group answer is one answer per request: each goes to the server by itself, so each is recorded by itself (#149).
    function answerGroup(g, allow) {
      var answers = window.OfficeVocab.groupAnswers(g, allow);
      lastIdx.current = list.indexOf(g.items[0]);
      setBusy(g.key);
      answers.reduce(function (chain, a) { return chain.then(function () { return client.answer(a); }); }, Promise.resolve())
        .then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: g.items[0].tool, text: x.message }); });
    }
    function answer(r, allow) {
      lastIdx.current = list.indexOf(r);
      setBusy(r.id);
      client.answer({ id: r.id, allow: allow }).then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: r.bot, text: x.message }); });
    }
    return h(React.Fragment, null,
        list.length ? h('p', { className: 'note' }, plural(list.length, 'request waits', 'requests wait') + ' for you, oldest first. This is every building.') : null,
        !list.length ? h(A.EmptyState, { icon: 'finished', compact: true, title: 'Nothing needs you', text: 'New requests show here when an agent asks.' }) : null,
        h('div', { ref: box }, h('ul', { className: 'past' }, groups.map(function (g) {
          if (g.groupable) return h(GroupRow, { key: g.key, g: g, busy: busy, onAnswer: answerGroup });
          var r = g.items[0];
          if (r.kind === 'plan') return h('li', { key: r.id, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h(A.Icon, { name: 'plan', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName))),
            h('div', { className: 'past-actions' }, h(A.Button, { variant: 'emphasis', icon: 'plan', onClick: function () { p.onManager(); } }, 'Open Manager board')));
          if (r.kind === 'paperclip' && r.item === 'approval') return h('li', { key: r.id, className: 'past-row' }, h('div', { className: 'past-main' },
            h('div', { className: 'past-title' }, h(A.Icon, { name: 'hq', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName)),
            h('div', { className: 'past-meta mono' }, 'Paperclip approval' + (r.t ? ' · ' + ago(r.t) : '') + '.'),
            O.Hq && O.Hq.ApprovalDecide ? h(O.Hq.ApprovalDecide, { id: r.approval, write: !(snap.hq && snap.hq.approvalWrite === false), toast: p.toast, place: 'needs' }) : null),
            h('div', { className: 'past-actions' }, O.Hq && O.Hq.PaperclipLink ? h(O.Hq.PaperclipLink, { href: r.link }) : null, h(A.Button, { variant: 'quiet', icon: 'hq', onClick: function () { p.onHq(); } }, 'Open Paperclip HQ')));
          if (r.kind === 'paperclip') return h('li', { key: r.id, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h(A.Icon, { name: 'hq', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName)),
            h('div', { className: 'past-meta mono' }, 'Paperclip ' + r.roomName.toLowerCase() + (r.t ? ' · ' + ago(r.t) : '') + '.')),
            h('div', { className: 'past-actions' }, O.Hq && O.Hq.PaperclipLink ? h(O.Hq.PaperclipLink, { href: r.link }) : null, h(A.Button, { variant: 'quiet', icon: 'hq', onClick: function () { p.onHq(); } }, 'Open Paperclip HQ')));
          if (r.kind === 'merge') return h(O.Merge.Row, { key: r.id, r: r, busy: M.busy, onMerge: function (x) { M.start(x); } });
          var q = r.kind === 'question';
          return h('li', { key: r.id, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, sceneName({ uid: r.uid, name: r.bot })), h(Tag, null, r.buildingName), q ? null : h(A.RiskBadge, { risk: r.risk })),
              q ? h('div', { className: 'past-snip' }, r.text) : h(RequestLayers, { r: r }),
              h('div', { className: 'past-meta mono' }, r.roomName + ' · ' + ago(r.t))),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'emphasis', icon: 'approve', disabled: busy === r.id, onClick: function () { answer(r, true); } }, q ? 'Yes' : 'Approve'),
              h(A.Button, { variant: 'quiet', icon: 'decline', disabled: busy === r.id, onClick: function () { answer(r, false); } }, q ? 'No' : 'Decline'),
              h(A.Button, { variant: 'ghost', icon: 'chevron-right', onClick: function () { p.onGo(r); } }, 'Go to')));
        }))), M.node);
  }
  function NeedsDialog(p) {
    return h(A.Dialog, { open: true, title: 'Needs you', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' }, h(QueueList, { toast: p.toast, onManager: p.onManager, onHq: p.onHq, onGo: p.onGo })));
  }

  // the DS palette listens for Ctrl+K on the document, so a button sends the same key
  function openPalette() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); }

  // ---------- the phone list (#148): the Glance and Look layers and the queue as a 2D list, below 820 px ----------
  // It reads the store (officeAdapter.phone), never the scene, so it always agrees with the scene. Every request is answered
  // here, with the same rows as Needs you. An agent row opens that agent in the scene (Inspect).
  var PHONE_MAX = 820;
  function PhoneMood(p) {
    var k = p.glance.mood.key === 'review' ? 'waiting' : p.glance.mood.key;
    return h('span', { className: 'phone-mood is-' + k }, h('span', { className: 'phone-dot', 'aria-hidden': 'true' }), p.glance.text || p.glance.mood.word);
  }
  function PhoneView(p) {
    var snap = useSnapshot();
    var ph = snap ? window.officeAdapter.phone(snap) : { queue: { count: 0 }, buildings: [] };
    var hqPh = snap && snap.hq && snap.hq.company ? window.OfficeVocab.hq.phone(snap.hq) : null;
    return h('div', { className: 'phone', role: 'region', 'aria-label': 'Agents' },
      h('div', { className: 'phone-head' },
        h('h1', { className: 'phone-title' }, 'Agent Office'),
        h(A.Button, { variant: 'quiet', icon: 'search', 'aria-label': 'Open the command palette', onClick: openPalette }, 'Commands')),
      h('section', { className: 'phone-sec', 'aria-label': 'Needs you' },
        h('h2', { className: 'phone-h' }, 'Needs you', ph.queue.count ? h(Tag, null, String(ph.queue.count)) : null),
        h(QueueList, { toast: p.toast, onManager: p.onManager, onHq: p.onHq, onGo: p.onGo })),
      // The HQ building (#197): the company of the connected Paperclip, its Lobby in one line, and the way to the dashboard.
      hqPh ? h('section', { className: 'phone-sec', 'aria-label': 'Paperclip HQ' },
        h('h2', { className: 'phone-h' }, 'Paperclip HQ'),
        h('div', { className: 'phone-bld' },
          h('div', { className: 'phone-row phone-bld-head' }, h('b', null, snap.hq.company.name)),
          h('p', { className: 'look-facts mono' }, window.OfficeVocab.hq.glance(snap.hq) || window.OfficeVocab.hq.state(snap.hq)),
          hqPh.needs.length || hqPh.approvalsUnknown ? h('ul', { className: 'phone-hq-needs', 'aria-label': 'Needs you in Paperclip' },
            hqPh.needs.map(function (n) { return h('li', { key: n.key }, n.text); }),
            hqPh.approvalsUnknown ? h('li', { key: 'unknown' }, 'The office could not read the approvals.') : null) : null,
          hqPh.employees.length ? h('ul', { className: 'look-agents', 'aria-label': 'Employees' }, hqPh.employees.map(function (e) {
            return h('li', { key: e.id, className: 'phone-emp' },
              h('span', { className: 'phone-row' }, h('b', null, e.name), h(PhoneMood, { glance: { mood: e.mood, text: e.mood.word } })),
              h('span', null, [e.title, clip(e.line, 60)].filter(Boolean).join(' · ')),
              h('span', { className: 'look-facts' }, e.supervision));
          })) : h('p', { className: 'look-facts' }, 'No employees yet.'),
          p.onHq ? h(A.Button, { variant: 'quiet', icon: 'hq', onClick: p.onHq }, 'Open Paperclip HQ') : null)) : null,
      h('section', { className: 'phone-sec', 'aria-label': 'Buildings' },
        h('h2', { className: 'phone-h' }, 'Buildings'),
        !ph.buildings.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a repository to see it here.' }) : null,
        ph.buildings.map(function (b) {
          return h('div', { key: b.key, className: 'phone-bld' },
            h('div', { className: 'phone-row phone-bld-head' }, h('b', null, b.name), h(PhoneMood, { glance: b.glance })),
            b.rooms.map(function (r) {
              return h('div', { key: r.id, className: 'phone-room' },
                h('div', { className: 'phone-row' }, h('b', null, r.name), h(PhoneMood, { glance: r.glance })),
                h('p', { className: 'look-intent' }, r.look.intent),
                h('p', { className: 'look-facts mono' }, [plural(r.agents.length, 'agent', 'agents'), r.look.progress, r.look.cost].filter(Boolean).join(' · ')),
                h('ul', { className: 'look-agents' }, r.agents.map(function (a) {
                  return h('li', { key: a.uid }, h('button', { type: 'button', className: 'look-agent', onClick: function () { p.onOpenAgent(a.uid); } },
                    h('span', { className: 'phone-row' }, h('b', null, a.name || 'Agent'), h(PhoneMood, { glance: a.glance })),
                    h('span', null, [clip(a.look.intent, 60), a.look.progress, a.look.cost].filter(Boolean).join(' · '))));
                })));
            }));
        })));
  }

  O.Needs = { Dialog: NeedsDialog, Phone: PhoneView, PHONE_MAX: PHONE_MAX, openPalette: openPalette };
})();
