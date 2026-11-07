/* Agent Office for Claude Code x0.2: the reception feature (#184, the page features of #168).
   The weekly recap with Focus mode (#151), the Reception and the lobby tour (#92). One Module: its Interface is window.OfficePage.Reception = { Recap: RecapDialog, Reception: ReceptionDialog, TourCard: TourCard, tourSeen: tourSeen, setTourSeen: setTourSeen }.
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Busy = O.Busy, F = O.F, call = O.call, client = O.client, money = O.money, useSnapshot = O.useSnapshot;

  // ---------- weekly recap, while you were away, Focus mode (#151) ----------
  var AWAY_KEY = 'ao_away_since';
  function awaySince() { try { var v = Number(localStorage.getItem(AWAY_KEY)); return v > 0 ? v : Date.now() - 24 * 3600000; } catch (x) { return Date.now() - 24 * 3600000; } }
  function awayMark() { try { localStorage.setItem(AWAY_KEY, String(Date.now())); } catch (x) { /* the list then starts 24 hours back */ } }
  function RecapDialog(p) {
    var ls = useState(null), r = ls[0], setR = ls[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var since = useState(awaySince)[0];
    useEffect(function () { client.get('recap', { since: since }).then(setR, function (x) { setErr(x.message); }); }, []);
    function close() { awayMark(); p.onClose(); }
    function focus(on) { setBusy(true); client.settingsFocus({ on: on }).then(function () { setBusy(false); setR(Object.assign({}, r, { focus: on })); p.toast({ tone: 'info', title: on ? 'Focus mode is on' : 'Focus mode is off', text: on ? 'Sound, motion and rituals are off.' : 'Rituals are back.' }); }, function (x) { setBusy(false); setErr(x.message); }); }
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
  // (the layout command). A rename shows in place; a switch, an added, hidden or moved floor builds the scene again.
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
      client.layout(Object.assign({ building: p.repo }, body)).then(function () { setBusy(''); if (done) done(); }, function (x) { setBusy(''); setErr(x.message); });
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
  // Orientation opens by itself once: when the server has not seen it closed and this browser has not closed it either (the gate and a returning browser set the key).
  function orientationDue(v) { try { return !!v && v.seen !== true && localStorage.getItem('ao-orientation') !== '1'; } catch (x) { return !!v && v.seen !== true; } }
  function orientationMark() { try { localStorage.setItem('ao-orientation', '1'); } catch (x) { /* private window: the server's seen flag still holds */ } }
  function tourSeen() { try { return localStorage.getItem('ao-tour') === '1'; } catch (x) { return false; } }
  function setTourSeen() { try { localStorage.setItem('ao-tour', '1'); } catch (x) { /* private window */ } }

  // ---------- Orientation (#196): the first-run walk through the office ----------
  // The steps, their words and the saved progress come from the server (src/orientation.mjs); this draws the controls of each step.
  // Every step can be skipped and is reachable again from the Reception and Ctrl+K. The memory step is a placeholder.
  function KindsStep() {
    var K = O.useKinds();   // the shared provider read (page-core.js): the kept answer, never a fresh round
    if (K.checking) return h(Busy, { on: true });
    return h('ul', { className: 'past' }, K.list.map(function (k) {
      return h('li', { key: k.kind, className: 'past-row' }, h('div', { className: 'past-main' },
        h('div', { className: 'past-title' }, h('b', null, k.label)),
        h('div', { className: 'past-meta' }, k.ready ? 'Ready' : (k.needs && k.needs[0]) || 'Not ready')));
    }));
  }
  function SpendStep(p) {
    var i = p.info || {};
    var sl = useState(O.limitText(i.spendLimit)), limit = sl[0], setLimit = sl[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var sv = useState(false), saved = sv[0], setSaved = sv[1];
    function save() {
      setBusy(true); setErr('');
      client.settingsSpend({ limit: O.limitSent(limit, true), confirmed: true }).then(function () { setBusy(false); setSaved(true); p.onDone(); }, function (x) { setBusy(false); setErr(x.message); });
    }
    return h('div', null,
      h(A.TextInput, { id: 'o-spend', label: 'Spend limit in dollars. Empty means no limit.', value: limit, onChange: function (t) { setLimit(t); setSaved(false); } }),
      err ? h('p', { className: 'note reception-err', role: 'alert' }, err) : null,
      h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', loading: busy, onClick: save }, saved ? 'Saved' : 'Save the limit')));
  }
  function StartupStep(p) {
    var su = useState((p.info && p.info.startup) || null), st = su[0], setSt = su[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    if (!st || !st.available) return h('p', { className: 'note' }, 'This computer has no Startup folder, so the office cannot start with Windows.');
    if (st.canChange === false) return h('p', { className: 'note' }, (st.enabled ? 'Start with Windows is on. ' : 'Start with Windows is off. ') + (st.reason || ''));
    function toggle() {
      setBusy(true); setErr('');
      client.startup({ enabled: !st.enabled }).then(function (r) { setSt(r); setBusy(false); if (r.enabled) p.onDone(); }, function (x) { setBusy(false); setErr(x.message); });
    }
    return h('div', null,
      h('p', { className: 'note' }, st.enabled ? 'The office starts when you sign in.' : 'The office adds one file to your Startup folder. It needs no admin rights.'),
      err ? h('p', { className: 'note reception-err', role: 'alert' }, err) : null,
      h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', loading: busy, onClick: toggle }, st.enabled ? 'Turn off start with Windows' : 'Turn on start with Windows')));
  }
  function RemoteStep(p) {
    var r = (p.info && p.info.remote) || {};
    if (r.state === 'on') return h('p', { className: 'note' }, 'Remote access is on at ' + r.host + '.');
    return h('p', { className: 'note' }, 'Remote access is off.' + (r.reason ? ' ' + r.reason : '') + (r.missing && r.missing.length ? ' Missing: ' + r.missing.join(', ') + '.' : '') + ' The steps are in docs/remote-access.md.');
  }
  // The company step (#199): install or connect Paperclip (the runtime panel of the HQ, one place), then create the company. The first account
  // and the board key approval are the user's: the panel shows their two links and this step waits. The server sends the write through the HQ writer (#198): the write grid, then the ask-first 'write'.
  function CompanyStep(p) {
    var snap = useSnapshot(), rt = snap && snap.paperclipRuntime, co = snap && snap.hq && snap.hq.company;
    var cat = (snap && snap.catalog) || { archetypes: [] };
    var nm = useState(''), name = nm[0], setName = nm[1];
    var ar = useState('general'), arch = ar[0], setArch = ar[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var qs = useState(''), ask = qs[0], setAsk = qs[1];
    if (co) return h('div', null, h('p', { className: 'note', role: 'status' }, 'Your company "' + co.name + '" is in Paperclip. The office watches it.'),
      h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'approve', onClick: p.onDone }, 'Mark this step done')));
    if (!rt) return h(Busy, { on: true });
    var ready = rt.state === 'connected' || (rt.state === 'running' && rt.bootstrap !== 'pending' && rt.key && rt.key.state === 'ready');
    function create(confirmed) {
      setBusy(true); setErr('');
      client.paperclipCompany({ name: name, archetype: arch, confirmed: confirmed === true ? true : undefined }).then(function () { setBusy(false); setAsk(''); p.onDone(); }, function (x) {
        setBusy(false);
        var a = window.OfficeAsk.asked(x, 'write', confirmed === true);
        if (a) { setAsk(a.text); return; }
        setErr(x.message);
      });
    }
    var opts = cat.archetypes.map(function (x) { return { value: x.id, label: x.name }; });
    return h('div', null,
      O.PaperclipRuntime ? h(O.PaperclipRuntime, { runtime: rt, toast: p.toast }) : null,
      ready ? h('div', { className: 'form' },
        h('h3', { className: 'ext-h' }, 'Create your company'),
        h(A.TextInput, { id: 'o-company', label: 'Company name', value: name, onChange: function (t) { setName(t); setAsk(''); } }),
        opts.length ? h(A.Select, { id: 'o-company-kind', label: 'Kind of building', options: opts, value: arch, onChange: setArch }) : null,
        ask ? h('p', { className: 'note', role: 'alert' }, ask) : null,
        err ? h('p', { className: 'note reception-err', role: 'alert' }, err) : null,
        h('div', { className: 'inline-actions' },
          ask ? h(A.Button, { variant: 'primary', icon: 'approve', loading: busy, onClick: function () { create(true); } }, 'Create company') : h(A.Button, { variant: 'quiet', icon: 'add', disabled: !name.trim(), loading: busy, onClick: function () { create(false); } }, 'Create company'),
          ask ? h(A.Button, { variant: 'quiet', onClick: function () { setAsk(''); } }, 'Do not create') : null))
        : h('p', { className: 'note' }, 'The company comes after Paperclip runs, the first account exists and the board key is approved. Skip this step for now if you want. You can come back from the Reception.'));
  }
  // The first hire (#201): the HR desk form of the HQ (one place), inside the step. Once the company has an employee the step can be marked done.
  function HireStep(p) {
    var snap = useSnapshot(), q = snap && snap.hq;
    if (!q || !q.company) return h('p', { className: 'note' }, 'The first hire comes after your company exists. Do the Company step first, or skip this step. You can come back from the Reception.');
    return h('div', null, O.Hq && O.Hq.HireForm ? h(O.Hq.HireForm, { toast: p.toast, onDone: p.onDone }) : null);
  }
  function StepBody(p) {
    var id = p.step.id;
    if (p.step.later) return h('p', { className: 'note' }, 'This step comes later. Skip it for now. You can come back from the Reception.');
    if (id === 'kinds') return h(KindsStep);
    if (id === 'company') return h(CompanyStep, { onDone: p.onDone, toast: p.toast });
    if (id === 'hire') return h(HireStep, { onDone: p.onDone, toast: p.toast });
    if (id === 'security') return h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'security', onClick: function () { p.onSecurity(); } }, 'Open the Security room'));
    if (id === 'spend') return h(SpendStep, { info: p.info, onDone: p.onDone });
    if (id === 'startup') return h(StartupStep, { info: p.info, onDone: p.onDone });
    if (id === 'remote') return h(RemoteStep, { info: p.info });
    if (id === 'tour') return h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', onClick: function () { p.onTour(); } }, 'Start the tour'));
    return null;
  }
  var STATUS_WORD = { done: 'Done', skipped: 'Skipped', open: 'Not yet' };
  function OrientationDialog(p) {
    var ls = useState(null), v = ls[0], setV = ls[1];
    var ix = useState(null), at = ix[0], setAt = ix[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var inf = useState(p.info || null), info = inf[0], setInfo = inf[1];
    useEffect(function () {
      client.get('orientation').then(function (j) { setV(j); setAt(j.next || j.steps[0].id); }, function (x) { setErr(x.message); });
      if (!p.info) O.getInfo().then(setInfo, function () { /* the steps that read it say so */ });
    }, []);
    function send(body) { return client.orientationStep(body).then(function (j) { setV(j); return j; }, function (x) { setErr(x.message); }); }
    function close() { orientationMark(); send({ seen: true }); p.onClose(); }
    var steps = v ? v.steps : [], ixAt = steps.findIndex(function (s) { return s.id === at; }), step = steps[ixAt];
    function mark(status) {
      send({ step: step.id, status: status }).then(function () { if (ixAt < steps.length - 1) setAt(steps[ixAt + 1].id); });
    }
    var actions = [h(A.Button, { key: 'c', variant: 'quiet', onClick: close }, 'Close')];
    if (step) {
      if (ixAt > 0) actions.unshift(h(A.Button, { key: 'b', variant: 'quiet', onClick: function () { setAt(steps[ixAt - 1].id); } }, 'Back'));
      actions.unshift(h(A.Button, { key: 's', variant: 'quiet', onClick: function () { mark('skipped'); } }, 'Skip this step'));
      actions.push(h(A.Button, { key: 'd', variant: 'primary', icon: 'approve', onClick: function () { mark('done'); } }, step.status === 'done' ? 'Next step' : 'Mark done'));
    }
    return h(A.Dialog, { open: true, title: 'Orientation', onClose: close, actions: actions },
      h('div', { className: 'form orient' },
        h(Busy, { on: !v && !err }),
        err ? h('p', { className: 'note reception-err', role: 'alert' }, err) : null,
        v ? h('ol', { className: 'orient-steps', 'aria-label': 'Steps' }, steps.map(function (s, n) {
          return h('li', { key: s.id }, h('button', { type: 'button', className: 'orient-step is-' + s.status + (s.id === at ? ' is-at' : ''), 'aria-current': s.id === at ? 'step' : undefined, onClick: function () { setAt(s.id); } },
            h('span', { className: 'mono' }, String(n + 1)), h('span', null, s.title), h('span', { className: 'orient-state' }, STATUS_WORD[s.status])));
        })) : null,
        step ? h('div', { className: 'orient-body' },
          h('h3', { className: 'reception-h' }, step.title),
          h('p', null, step.text),
          h(StepBody, { key: step.id, step: step, info: info, toast: p.toast, onDone: function () { send({ step: step.id, status: 'done' }); }, onSecurity: function () { close(); p.onSecurity(); }, onTour: function () { close(); p.onTour(); } })) : null,
        v && v.finished ? h('p', { className: 'note' }, v.skipped.length ? 'You skipped ' + F.plural(v.skipped.length, 'step', 'steps') + '. Open Orientation from the Reception to finish them.' : 'Orientation is finished.') : null));
  }

  O.Reception = { Recap: RecapDialog, Reception: ReceptionDialog, Orientation: OrientationDialog, orientationDue: orientationDue, TourCard: TourCard, tourSeen: tourSeen, setTourSeen: setTourSeen };
})();
