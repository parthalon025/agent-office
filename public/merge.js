/* Agent Office for Claude Code x0.2: the Merge feature (#184, the Changes pattern of #183).
   One Module for the paper flow: merge a ready change (it asks first), the decision row of Ready to merge and the pipeline board.
   Its Interface is window.OfficePage.Merge = { use, Row, Flow }. needs.js uses use and Row in the Needs you list;
   office.js opens Flow. Loads after page-core.js and before needs.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState;
  var Tag = O.Tag, client = O.client, plural = O.plural, useSnapshot = O.useSnapshot;

  // ---------- paper flow (#93): Ready to merge, the pipeline board and the PR cards ----------
  // The server reads `gh` (read-only); building.js changes() turns it into folders. Merge is the one write and asks first: the first
  // call is 409 with confirm: 'merge' and the question, and the Merge dialog sends the same call again with confirmed: true.
  function useMerge(toast) {
    var st = useState(null), ask = st[0], setAsk = st[1], bz = useState(''), busy = bz[0], setBusy = bz[1], er = useState(''), err = er[0], setErr = er[1];
    function send(r, confirmed) {
      setBusy(r.id || ('pr:' + r.number)); setErr('');
      return client.merge({ repo: r.repo, number: r.number, confirmed: confirmed === true }).then(function () {
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

  O.Merge = { use: useMerge, Row: MergeRow, Flow: FlowDialog };
})();
