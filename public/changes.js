/* Agent Office for Claude Code x0.2: the Changes feature (#183, the pilot of the page features of #168).
   One Module for the changes of a session: the data hook (diff, pull request, worktree removal), the body, the confirm dialog,
   the fallback dialog, the pinned wall screen of a room and the Ctrl+K action. Its Interface is window.OfficePage.Changes:
   { Dialog, Screen, use, Body, Confirm, actions, paletteAction }. office.js keeps the page state (which dialog or screen is
   shown) and the flight to the wall screen; it calls this Module and holds none of its parts. Loads after panels.js, which
   gives it the pinned-screen helpers (Bezel, usePinBox, usePinFocus, putBox).
   use(uid, toast) is the data hook: the diff, the pull request and the worktree removal. Both always ask first.
   Dialog is for a session with no room on screen; Screen is the room's pinned wall screen (#89); paletteAction(s, nm,
   where, kw, open) is the Ctrl+K action.
   Tested in test/changes-feature.test.mjs (the page file in a VM with the DS bundle and a fake client). */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Bezel = O.Bezel, Busy = O.Busy, Tag = O.Tag, client = O.client, putBox = O.putBox, usePinBox = O.usePinBox,
      usePinFocus = O.usePinFocus;

  // ---------- changes (diff, pull request, worktree) ----------
  function DiffView(p) {
    var lines = p.text.split('\n').slice(0, 1800);
    return h('pre', { className: 'diff', tabIndex: 0, 'aria-label': 'Diff' }, lines.map(function (l, i) {
      var c = l.charAt(0), cls = l.indexOf('+++') === 0 || l.indexOf('---') === 0 || l.indexOf('diff ') === 0 || l.indexOf('index ') === 0 ? 'meta' : c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : '';
      return h('span', { key: i, className: 'dl ' + cls }, l === '' ? ' ' : l);
    }));
  }
  // The changes of one session (its folder): the diff, and the pull request and worktree removal behind a confirm dialog.
  // The room's wall screen (ChangesScreen, pinned) and the fallback dialog (ChangesDialog) share it.
  function useChanges(uid, toast) {
    var d = useState(null), data = d[0], setData = d[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var rs = useState(null), result = rs[0], setResult = rs[1];
    function load() { setErr(''); client.changes({ uid: uid }).then(setData, function (x) { setErr(x.message); setData({ files: [], diff: '', branch: '', stat: '' }); }); }
    useEffect(load, [uid]);
    function run(fn) {
      setBusy(true); setErr('');
      fn().then(function (r) {
        setBusy(false); setConfirm(null); setResult(r); load();
        if (toast && r && r.url) toast({ tone: 'success', title: 'Pull request created', text: r.url });
        if (toast && r && r.removed) toast({ tone: 'info', title: 'Worktree removed', text: r.branchKept ? 'The branch was kept.' : 'The folder is gone.' });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    return { data: data, err: err, setErr: setErr, confirm: confirm, setConfirm: setConfirm, busy: busy, result: result, load: load, wt: data && data.worktree,
      pr: function () { run(function () { return client.pr({ uid: uid }); }); },
      remove: function (force) { run(function () { return client.worktreeRemove({ uid: uid, force: force }); }); } };
  }
  // The confirm dialog of a pull request or a worktree removal, or null. Push, pull request and removal always ask here.
  function ChangesConfirm(p) {
    var c = p.c, wt = c.wt;
    if (c.confirm === window.OfficeAsk.local('pr')) {
      return h(A.Dialog, { open: true, title: 'Create a pull request', onClose: function () { c.setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { c.setConfirm(null); } }, 'Cancel'),
        h(A.Button, { key: 'p', variant: 'primary', icon: 'send', loading: c.busy, onClick: c.pr }, 'Create pull request')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'This sends your changes to the remote repository. It does these steps in order:'),
          h('pre', { className: 'code' }, '1. git add -A and git commit\n2. git push -u origin ' + (wt ? wt.branch : '') + '\n3. gh pr create --fill'),
          c.err ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null));
    }
    if (c.confirm === window.OfficeAsk.local('rm')) {
      var dirty = /uncommitted/i.test(c.err);
      return h(A.Dialog, { open: true, title: 'Remove the worktree', onClose: function () { c.setConfirm(null); c.setErr(''); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { c.setConfirm(null); c.setErr(''); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: c.busy, onClick: function () { c.remove(dirty); } }, dirty ? 'Remove and discard changes' : 'Remove worktree')] },
        h('div', { className: 'form' },
          h('p', { className: 'note' }, 'Deletes the folder ' + (wt ? wt.root : '') + '. The branch ' + (wt ? wt.branch : '') + ' stays if it has commits that are not merged.'),
          c.err ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null));
    }
    return null;
  }
  // The buttons of the changes: Refresh, Remove worktree (a closed session only), Create pull request. Each of the last two opens its confirm.
  function changesActions(c, ended) {
    var data = c.data, wt = c.wt;
    return [
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: c.load }, 'Refresh'),
      wt ? h(A.Button, { key: 'rm', variant: 'quiet', icon: 'remove', disabled: !ended, title: ended ? '' : 'Close the session first', onClick: function () { c.setConfirm(window.OfficeAsk.local('rm')); } }, 'Remove worktree') : null,
      wt ? h(A.Button, { key: 'pr', variant: 'primary', icon: 'send', disabled: !data || (!data.files.length && !data.ahead), onClick: function () { c.setConfirm(window.OfficeAsk.local('pr')); } }, 'Create pull request') : null];
  }
  function ChangesBody(p) {
    var c = p.c, data = c.data, result = c.result;
    return h(React.Fragment, null,
      c.err && !c.confirm ? h('p', { className: 'ao-err', role: 'alert' }, c.err) : null,
      result && result.url ? h('p', { className: 'note' }, 'Pull request created: ', /^https:\/\//i.test(result.url) ? h('a', { href: result.url, target: '_blank', rel: 'noreferrer' }, result.url) : result.url) : null,
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
      data && !data.files.length && !c.err ? h(A.EmptyState, { icon: 'checkpoint', compact: true, title: 'Nothing changed yet', text: 'Changes show here as the session edits files.' }) : null);
  }
  // The changes of a session that has no room in the scene on screen (a past session, another building). In the office the
  // changes show on the room's wall screen (ChangesScreen).
  function ChangesDialog(p) {
    var c = useChanges(p.uid, p.toast);
    if (c.confirm) return h(ChangesConfirm, { c: c });
    return h(A.Dialog, { open: true, title: 'Changes in ' + (p.name || 'this session'), onClose: p.onClose, actions: changesActions(c, p.ended).concat([
      h(A.Button, { key: 'd', variant: c.wt ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')]) },
      h('div', { className: 'form wide' }, h(ChangesBody, { c: c })));
  }

  // The changes of a room on its wall screen, pinned (#89). Pull request and worktree removal keep their confirm dialog.
  function ChangesScreen(p) {
    var c = useChanges(p.uid, p.toast);
    var ref = React.useRef(null);
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && el.querySelector('.diff, .pin-body'); });
    return h(React.Fragment, null,
      h('section', { ref: ref, className: 'pin pin-changes' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Changes in ' + (p.name || 'this session') },
        h('div', { className: 'pin-head' },
          h('b', { className: 'pin-name' }, 'Changes in ' + (p.name || 'this session')),
          h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
          changesActions(c, p.ended),
          h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
        h('div', { className: 'pin-body', tabIndex: -1 }, h(ChangesBody, { c: c }))),
      h(ChangesConfirm, { c: c }));
  }

  // The Ctrl+K action of one session: s the session, nm its scene name, open(uid, name) the page's way to show it.
  function paletteAction(s, nm, where, kw, open) {
    return { id: 'page-s-chg-' + s.uid, label: 'Changes of ' + nm, icon: 'trace', group: 'Sessions', hint: where, keywords: kw + ' diff files', run: function () { open(s.uid, nm); } };
  }

  O.Changes = { Dialog: ChangesDialog, Screen: ChangesScreen, use: useChanges, Body: ChangesBody, Confirm: ChangesConfirm,
      actions: changesActions, paletteAction: paletteAction };
})();
