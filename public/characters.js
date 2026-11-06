/* Agent Office for Claude Code x0.2: the characters feature (#184, the page features of #168).
   Agent characters (#150): the personas dialog. One Module: its Interface is window.OfficePage.Characters = { Dialog: PersonasDialog }.
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Area = O.Area, Busy = O.Busy, Pair = O.Pair, client = O.client, look = O.look, useSnapshot = O.useSnapshot;

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
    function load() { client.get('personas').then(function (j) { setList(j.personas || {}); setTeams(j.teams || {}); }, function (x) { setList({}); setErr(x.message); }); }
    useEffect(load, []);
    // Start an agent from a character, or a squad from a team template (#152). Each agent gets its own room. A cost question or a refusal is shown, never skipped.
    function startAgent(r) {
      setBusy(true); setErr('');
      client.open({ persona: r.name, cwd: folder }).then(function () { setBusy(false); p.toast({ tone: 'success', title: 'Agent started', text: r.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function startSquad(t) {
      setBusy(true); setErr('');
      client.teamStart({ team: t.name, cwd: folder }).then(function (j) {
        setBusy(false);
        var bad = (j.started || []).filter(function (m) { return m.error; });
        p.toast({ tone: bad.length ? 'error' : 'success', title: bad.length ? 'Squad started with problems' : 'Squad started', text: bad.length ? bad[0].name + ': ' + bad[0].error : t.name });
      }, function (x) { setBusy(false); setErr(x.message); });
    }
    function addStarters() {
      setBusy(true); setErr('');
      client.personaStarters({}).then(function (j) { setBusy(false); load(); p.toast({ tone: 'success', title: j.added ? 'Starters added' : 'No new starters', text: j.added ? 'Reviewer, Fixer, Researcher and a team.' : 'You have them all.' }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function saveTeam() {
      setBusy(true); setErr('');
      var members = String(tform.members || '').split(',').map(function (m) { return m.trim(); }).filter(Boolean);
      client.teamSave({ name: tform.name, members: members }).then(function () { setBusy(false); setTform(null); load(); p.toast({ tone: 'success', title: 'Team saved', text: tform.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function delTeam(name) {
      setBusy(true); setErr('');
      client.teamDelete({ name: name }).then(function () { setBusy(false); load(); }, function (x) { setBusy(false); setErr(x.message); });
    }
    // Export and import: one JSON file of the setup (characters, teams, floor layouts, wall screens). It holds no Security rules.
    function exportSetup() {
      client.text('customExport').then(function (t) {
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
      f.text().then(function (t) { return client.customImport({ data: JSON.parse(t) }); }).then(function (j) {
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
      client.personaSave(form).then(function () { setBusy(false); setForm(null); load(); p.toast({ tone: 'success', title: 'Character saved', text: form.name }); },
        function (x) { setBusy(false); setErr(x.message); });
    }
    function del(name) {
      setBusy(true); setErr('');
      client.personaDelete({ name: name }).then(function () { setBusy(false); setForm(null); load(); p.toast({ tone: 'success', title: 'Character removed', text: name }); },
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

  O.Characters = { Dialog: PersonasDialog };
})();
