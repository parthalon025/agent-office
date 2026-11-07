/* Agent Office for Claude Code x0.2: the Skills feature (#184, the Changes pattern of #183).
   One Module for the skills an agent writes for itself (Hermes, #72). Its Interface is window.OfficePage.Skills = { Dialog }.
   The room dialog (dialogs.js) opens it for an agent kind that declares skills. Loads after page-core.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, Tag = O.Tag, ago = O.ago, client = O.client;


  // ---------- skills an agent writes (#72) ----------
  // The room panel opens this for an agent kind that declares skills (Hermes). The user reads, edits and deletes. A write is held:
  // the server answers 409 with confirm: 'skill' and the question, the dialog asks, and the same call goes again with confirmed: true.
  function SkillsDialog(p) {
    var ls = useState(null), list = ls[0], setList = ls[1];
    var ed = useState(null), edit = ed[0], setEdit = ed[1];       // { name, text, orig }: the skill in the editor
    var cf = useState(null), ask = cf[0], setAsk = cf[1];         // { action, name, text, question }: waiting for the user's yes
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    function load() { client.skillsList({ provider: p.kind }).then(function (j) { setList(j); }, function (x) { setList({ skills: [] }); setErr(x.message); }); }
    useEffect(load, []);
    function openEdit(name) {
      setBusy(name); setErr('');
      client.skillsRead({ provider: p.kind, name: name }).then(function (j) { setBusy(''); setEdit({ name: name, text: j.text, orig: j.text }); }, function (x) { setBusy(''); setErr(x.message); });
    }
    // action: 'save' or 'delete'. The first call asks; the call with confirmed: true writes.
    function write(action, name, text, confirmed) {
      setBusy(action + name); setErr('');
      client.send('skills' + action.charAt(0).toUpperCase() + action.slice(1), { provider: p.kind, name: name, text: text, confirmed: confirmed === true }).then(function () {
        setBusy(''); setAsk(null); setEdit(null);
        p.toast({ tone: 'success', title: p.agent, text: action === 'delete' ? 'Skill ' + name + ' deleted' : 'Skill ' + name + ' saved' });
        load();
      }, function (x) {
        setBusy('');
        var q = window.OfficeAsk.asked(x, 'skill', confirmed);
        if (q) { setAsk({ action: action, name: name, text: text, question: q.text }); return; }
        setErr(x.message);
      });
    }
    if (ask) {
      var back = function () { setAsk(null); setErr(''); };
      var del = ask.action === 'delete';
      return h(A.Dialog, { key: 'ask', open: true, title: (del ? 'Delete ' : 'Save ') + ask.name, onClose: back, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: back }, 'Keep it as it is'),
        h(A.Button, { key: 'y', variant: del ? 'danger' : 'primary', icon: del ? 'remove' : 'approve', loading: busy === ask.action + ask.name, onClick: function () { write(ask.action, ask.name, ask.text, true); } }, del ? 'Delete skill' : 'Save skill')] },
        h('div', { className: 'form' }, h('p', { className: 'note' }, ask.question), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    if (edit) {
      var changed = edit.text !== edit.orig, leave = function () { setEdit(null); setErr(''); };
      return h(A.Dialog, { key: 'edit', open: true, title: 'Skill ' + edit.name, onClose: leave, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: leave }, 'Back to the list'),
        h(A.Button, { key: 's', variant: 'primary', icon: 'approve', disabled: !changed, loading: busy === 'save' + edit.name, onClick: function () { write('save', edit.name, edit.text, false); } }, 'Save skill')] },
        h('div', { className: 'form wide' },
          h('p', { className: 'note' }, p.agent + ' follows this skill in later sessions. Saving asks you first.'),
          h(Area, { id: 'sk-text', label: 'SKILL.md', value: edit.text, rows: 14, onChange: function (v) { setEdit(Object.assign({}, edit, { text: v })); }, error: err || undefined })));
    }
    var skills = list ? list.skills : null, cat = O.HqCatalog.use();
    return h(A.Dialog, { key: 'list', open: true, title: 'Skills of ' + p.agent, onClose: p.onClose, actions: [h(A.Button, { key: 'd', variant: 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        h('p', { className: 'note' }, 'Skills that ' + p.agent + ' wrote for itself. You can read, edit and delete them. It makes new ones on its own.'),
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        h(Busy, { on: skills === null }),
        skills && !skills.length ? h(A.EmptyState, { icon: 'skill', title: 'No skills yet', text: p.agent + ' has not written a skill.' }) : null,
        h('ul', { className: 'past' }, (skills || []).map(function (k) {
          return h('li', { key: k.name, className: 'past-row' },
            h('div', { className: 'past-main' },
              h('div', { className: 'past-title' }, h('b', null, k.title), h(Tag, null, k.name)),
              k.description ? h('div', { className: 'past-snip' }, k.description) : null,
              h('div', { className: 'past-meta mono' }, ago(k.at) + ' · ' + k.bytes + ' bytes')),
            h('div', { className: 'past-actions' },
              h(A.Button, { variant: 'quiet', icon: 'tool', loading: busy === k.name, onClick: function () { openEdit(k.name); } }, 'Edit'),
              h(A.Button, { variant: 'quiet', icon: 'remove', onClick: function () { write('delete', k.name, '', false); } }, 'Delete')));
        })),
        h(O.HqCatalog.Skills, { cat: cat, quiet: true })));
  }

  O.Skills = { Dialog: SkillsDialog };
})();
