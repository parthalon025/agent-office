/* Agent Office for Claude Code x0.2: Needs you and the phone list (split out of office.js, #1 story 26).
   The paper flow (Ready to merge, the pipeline board), the request rows with their three layers, the Needs you list and the
   phone list below 820 px. Plain functions over the page core (window.OfficePage); they put their names on it for office.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Tag = O.Tag, ago = O.ago, api = O.api, clip = O.clip, plural = O.plural, refocusRow = O.refocusRow,
      sceneName = O.sceneName, useSnapshot = O.useSnapshot;

  // ---------- paper flow (#93): Ready to merge, the pipeline board and the PR cards ----------
  // The server reads `gh` (read-only); building.js changes() turns it into folders. Merge is the one write and asks first: the first
  // call is 409 with confirm: 'merge' and the question, and the Merge dialog sends the same call again with confirmed: true.
  function useMerge(toast) {
    var st = useState(null), ask = st[0], setAsk = st[1], bz = useState(''), busy = bz[0], setBusy = bz[1], er = useState(''), err = er[0], setErr = er[1];
    function send(r, confirmed) {
      setBusy(r.id || ('pr:' + r.number)); setErr('');
      return api('/api/merge', { repo: r.repo, number: r.number, confirmed: confirmed === true }).then(function () {
        setBusy(''); setAsk(null); toast({ tone: 'success', title: 'Merged #' + r.number, text: r.title || '' });
      }, function (x) {
        setBusy('');
        var q = window.OfficeAsk.asked(x, 'merge', confirmed);
        if (q) { setAsk({ r: r, text: q.text }); return; }
        if (confirmed) setErr(x.message); else { setAsk(null); toast({ tone: 'error', title: 'Merge #' + r.number, text: x.message }); }
      });
    }
    var node = ask ? h(A.Dialog, { open: true, title: 'Merge #' + ask.r.number, onClose: function () { setAsk(null); setErr(''); }, actions: [
      h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setAsk(null); setErr(''); } }, 'Cancel'),
      h(A.Button, { key: 'm', variant: 'primary', icon: 'merge', loading: !!busy, onClick: function () { send(ask.r, true); } }, 'Merge it')] },
      h('div', { className: 'form' }, h('p', { className: 'note' }, ask.text), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null)) : null;
    return { start: function (r) { send(r, false); }, busy: busy, node: node };
  }
  // A decision summary: the key point first, the recommendation, the reason, a link to the review finding (the change page).
  function MergeRow(p) {
    var r = p.r;
    return h('li', { className: 'past-row' },
      h('div', { className: 'past-main' },
        h('div', { className: 'past-title' }, h(A.Icon, { name: 'merge', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName)),
        h('div', { className: 'past-snip' }, h('em', null, 'Recommended: '), r.recommendation + '. ' + r.reason),
        r.url ? h('div', { className: 'past-sub mono' }, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Review finding on #' + r.number)) : null),
      h('div', { className: 'past-actions' },
        h(A.Button, { variant: 'emphasis', icon: 'merge', disabled: !!p.busy, onClick: function () { p.onMerge(r); } }, 'Merge')));
  }
  // The pipeline board: every change by stage (Intake, Build, Check, Review, Gate, Merge, Release, Record); a stage with no data says unknown.
  // Each change is a PR card: glyph, number and title, branch to base, the state in words, checks, reviewer, diff size, Merge when ready.
  function FlowDialog(p) {
    var snap = useSnapshot(), M = useMerge(p.toast), now = Date.now();
    var repos = snap ? snap.repos || [] : [];
    return h(A.Dialog, { open: true, title: 'Changes', onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide flow' },
        !repos.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a repository to see its changes.' }) : null,
        repos.map(function (r) {
          var c = window.OfficeBuilding.changes(snap, r.key, now), open = c.folders.filter(function (f) { return f.state !== 'merged' && f.state !== 'closed'; });
          return h('section', { key: r.key, className: 'flow-b', 'aria-label': r.name },
            h('div', { className: 'past-title' }, h(A.Icon, { name: 'building', size: 16 }), h('b', null, r.name), c.unknown ? h(Tag, null, c.line) : h(Tag, null, c.mergedToday + ' merged today')),
            h('ol', { className: 'flow-stages', 'aria-label': 'Pipeline of ' + r.name }, c.pipeline.map(function (st) {
              return h('li', { key: st.id, className: 'flow-stage' + (st.unknown ? ' is-unknown' : ''), 'aria-label': st.name + ': ' + (st.unknown ? 'unknown' : plural(st.count, 'change', 'changes')) },
                h('span', { className: 'flow-n mono' }, st.unknown ? 'unknown' : String(st.count)), h('span', { className: 'flow-w' }, st.name));
            })),
            !c.unknown && !open.length ? h('p', { className: 'note' }, 'No open changes.') : null,
            h('ul', { className: 'past' }, open.map(function (f) {
              var ck = f.checks || { total: 0, passed: 0 };
              return h('li', { key: f.number, className: 'past-row flow-card' },
                h('div', { className: 'past-main' },
                  h('div', { className: 'past-title' }, h(A.Icon, { name: f.glyph, size: 16 }), h('b', null, '#' + f.number + ' ' + f.title)),
                  h('div', { className: 'past-sub mono' }, f.head + ' to ' + (f.base || 'main')),
                  h('div', { className: 'past-meta mono' }, [f.word, ck.total ? ck.passed + ' of ' + plural(ck.total, 'check', 'checks') + ' passed' : 'no checks', f.reviewer ? 'reviewer ' + f.reviewer : 'no reviewer', '+' + f.diff.additions + ' -' + f.diff.deletions + ' in ' + plural(f.diff.files, 'file', 'files')].join(' · '))),
                f.state === 'ready' ? h('div', { className: 'past-actions' }, h(A.Button, { variant: 'emphasis', icon: 'merge', disabled: !!M.busy, onClick: function () { M.start({ repo: r.key, number: f.number, title: f.title }); } }, 'Merge')) : null);
            })));
        }),
        M.node));
  }

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
    var bz = useState(''), busy = bz[0], setBusy = bz[1], box = React.useRef(null), lastIdx = React.useRef(0), M = useMerge(p.toast);
    // After an answer the row goes. Keep the focus inside the dialog, on the row that took its place.
    useEffect(function () { refocusRow(box.current, lastIdx.current); }, [list.map(function (r) { return r.id; }).join('|')]);
    var groups = window.OfficeVocab.requestGroups(list);
    // A group answer is one answer per request: each goes to the server by itself, so each is recorded by itself (#149).
    function answerGroup(g, allow) {
      var answers = window.OfficeVocab.groupAnswers(g, allow);
      lastIdx.current = list.indexOf(g.items[0]);
      setBusy(g.key);
      answers.reduce(function (chain, a) { return chain.then(function () { return api('/api/answer', a); }); }, Promise.resolve())
        .then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: g.items[0].tool, text: x.message }); });
    }
    function answer(r, allow) {
      lastIdx.current = list.indexOf(r);
      setBusy(r.id);
      api('/api/answer', { id: r.id, allow: allow }).then(function () { setBusy(''); }, function (x) { setBusy(''); p.toast({ tone: 'error', title: r.bot, text: x.message }); });
    }
    return h(React.Fragment, null,
        list.length ? h('p', { className: 'note' }, plural(list.length, 'request waits', 'requests wait') + ' for you, oldest first. This is every building.') : null,
        !list.length ? h(A.EmptyState, { icon: 'finished', compact: true, title: 'Nothing needs you', text: 'New requests show here when an agent asks.' }) : null,
        h('div', { ref: box }, h('ul', { className: 'past' }, groups.map(function (g) {
          if (g.groupable) return h(GroupRow, { key: g.key, g: g, busy: busy, onAnswer: answerGroup });
          var r = g.items[0];
          if (r.kind === 'plan') return h('li', { key: r.id, className: 'past-row' }, h('div', { className: 'past-main' }, h('div', { className: 'past-title' }, h(A.Icon, { name: 'plan', size: 16 }), h('b', null, r.text), h(Tag, null, r.buildingName))),
            h('div', { className: 'past-actions' }, h(A.Button, { variant: 'emphasis', icon: 'plan', onClick: function () { p.onManager(); } }, 'Open Manager board')));
          if (r.kind === 'merge') return h(MergeRow, { key: r.id, r: r, busy: M.busy, onMerge: function (x) { M.start(x); } });
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
      h('div', { className: 'form wide' }, h(QueueList, { toast: p.toast, onManager: p.onManager, onGo: p.onGo })));
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
    return h('div', { className: 'phone', role: 'region', 'aria-label': 'Agents' },
      h('div', { className: 'phone-head' },
        h('h1', { className: 'phone-title' }, 'Agent Office'),
        h(A.Button, { variant: 'quiet', icon: 'search', 'aria-label': 'Open the command palette', onClick: openPalette }, 'Commands')),
      h('section', { className: 'phone-sec', 'aria-label': 'Needs you' },
        h('h2', { className: 'phone-h' }, 'Needs you', ph.queue.count ? h(Tag, null, String(ph.queue.count)) : null),
        h(QueueList, { toast: p.toast, onManager: p.onManager, onGo: p.onGo })),
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

  Object.assign(O, { FlowDialog: FlowDialog, NeedsDialog: NeedsDialog, PHONE_MAX: PHONE_MAX, PhoneView: PhoneView,
      openPalette: openPalette });
})();
