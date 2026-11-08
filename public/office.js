/* Agent Office for Claude Code x0.2: page script.
   Mounts the DS office: the city, the App (scene mount, toasts, Ctrl+K page commands, the wiring of the dialogs and the pinned
   screens (#89) laid over the 3D scene). The parts it wires are in the other page files, which load first and share their names
   on window.OfficePage: page-core.js (helpers, kinds), dialogs.js (the session dialogs), the feature files (changes, schedules, extensions, hq, characters, reception), panels.js (board, stats,
   notes, Look and the pinned screens), needs.js (Needs you, paper flow, the phone list). Split out of this file in #1 story 26.
   There is no dock (#92): the office's actions are in the scene (open desks, the reception memo, the elevator) and in Ctrl+K.
   This file holds the city (CityView), the page commands in Ctrl+K (pageActions) and App. It loads last of the page files
   and mounts OfficeScene once. The page files load in this order from public/index.html: page-core.js, skills.js,
   dialogs.js, schedules.js, extensions.js, hq.js, characters.js, reception.js, panels.js, changes.js, screens.js, merge.js,
   needs.js, office.js. A new page file goes into index.html, STATIC_FILES, the kit/check.py list in CI and the Map in
   CLAUDE.md. A top-level var another file reads must never be reassigned (the other files hold a copy: layerMem is read
   through layerMemory()).

   Layout rules.
   - There is no dock. --strip-clear is a fixed value per width in office.css (above the DS broadcast bar and log lane);
     the DS chat, roster, Since you left card, the page panels and the toast stack use it as their bottom edge. Do not
     hard-code another bottom offset for them. The dock's actions live in the scene (open desks, the reception memo), in
     the Reception dialog (officeActions, so a touch screen reaches them) and in Ctrl+K.
   - The scene height is state here (win.h): a resize renders the page again, and the DS sets the new inline height. Do
     not override the .ao-office height in CSS (#55).
   - At 820 px and below the room card waits while the DS Since you left card shows (onSinceYouLeft sets syl), because
     both sit at the bottom (#66). The lobby tour card sits at the top (at the bottom below 820 px) and is a cover for
     framing (COVERS in panels.js) and for the toasts (KEEP).
   - One panel at a time: this file adds has-panel to #office while a pinned screen (the desk screen, the changes on the
     wall), the board or the stats panel is open, and office.css hides .ao-hud-right (the DS chat and roster) then. Every
     such panel must show a way to the open requests (the board and stats panels show NeedsButton; a pinned screen gets
     the waiting count and onGo), or an approval could hide behind the hidden chat. Every screen in focus shows the bezel count
     (Bezel, every request of every building; one click goes to the desk of the oldest).

   Commands and keys.
   - Ctrl+K page commands are built from App state each render and handed to the palette in an effect (pageActions). Room
     tools (board.open) and session commands (terminal, changes, Stop turn, Go to) are built by liveActions() at that
     moment, so the rooms of the floor on screen are current. The DS calls CommandPalette.actions on every scene render, so
     liveActions() runs on each scene event; keep it cheap. Do not mutate a module array during render.
   - Esc closes the top layer only. A dialog (.ao-dialog) or the palette (.ao-cmdk) takes it first; a DS Dialog is gone
     from the DOM before window bubble listeners run. So decide in the bubble phase with OfficeBoard.escTaken(e), which
     records the layer state in window capture. Do not move the handler to capture: chat-extras.js stops Esc for the /
     list there.

   Needs you and the inbox.
   - Needs you is officeAdapter.requests(snap), not a sum of the DS inboxes (they list one building). The page runs the
     one Notifier (the scene gets notifier: false): its count is the Needs you total, so the tab title counts every
     building, in the city too. The same count is the scene's top bar button (OfficeScene waitingCount and onWaiting, every
     width; #92 review: with no dock a request in another building showed only in the tab title) and the City panel's: one
     tap runs goOldest (needs[0], then openDesk: its session's building, floor and desk screen). Its notifications are
     officeAdapter.alerts(snap) (requests and errors of every building). The DS ao-alerts setting turns the alerts on. Do
     not mount a second Notifier with a title: two of them write the title over each other.
   - The Decisions inbox is page state: OfficeScene gets inbox and onInbox. A page panel that opens closes it
     (setInbox(false)); a new scene starts with it closed in its first render (the state carries its scene key). Do not read
     or click DS inbox class names. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect,
      useMemo = React.useMemo;
  var Bezel = O.Bezel, BoardPanel = O.BoardPanel, Changes = O.Changes,
      DEFAULT_KIND = O.DEFAULT_KIND, DeskScreen = O.Screens.Desk, ExtensionsDialog = O.Extensions.Dialog, F = O.F,
      FloorsDialog = O.FloorsDialog, FlowDialog = O.Merge.Flow, HooksDialog = O.HooksDialog, HqDialog = O.Hq.Hq,
      KindsDialog = O.KindsDialog, LOOK_ICON = O.LOOK_ICON, LookBar = O.LookBar, MODELS = O.MODELS, MODES = O.MODES,
      ManagerDialog = O.Hq.Manager, NeedsDialog = O.Needs.Dialog, NoteScreen = O.Screens.Note, NotesEditor = O.NotesEditor,
      OpenDialog = O.OpenDialog, OrientationDialog = O.Reception.Orientation, PHONE_MAX = O.Needs.PHONE_MAX, PastDialog = O.PastDialog, PersonasDialog = O.Characters.Dialog,
      PhoneView = O.Needs.Phone, RecapDialog = O.Reception.Recap, ReceptionDialog = O.Reception.Reception, RoomDialog = O.RoomDialog,
      SchedulesDialog = O.Schedules.Dialog, SessionsDialog = O.SessionsDialog, StatsPanel = O.StatsPanel,
      TourCard = O.Reception.TourCard, TrustDialog = O.Hq.Trust, WANT_MS = O.WANT_MS, client = O.client, clip = O.clip, cssMs = O.cssMs,
      getInfo = O.getInfo, kindOf = O.kindOf, layerMemory = O.layerMemory, noteLayer = O.noteLayer,
      openPalette = O.Needs.openPalette, plural = O.plural, reduced = O.reduced, resetText = O.resetText,
      sceneCovers = O.sceneCovers, orientationDue = O.Reception.orientationDue, sceneName = O.sceneName, setTourSeen = O.Reception.setTourSeen, tourSeen = O.Reception.tourSeen,
      useChatBot = O.useChatBot, useSnapshot = O.useSnapshot;

  // ---------- the city: every repository as a building ----------
  function cityData(snap) {
    var out = window.officeAdapter.buildings(snap).map(function (b) {
      var def = window.officeAdapter.preview(b.key, snap), bots = [];
      def.floors.forEach(function (f) { f.rooms.forEach(function (r) { (r.bots || []).forEach(function (x) { bots.push({ uid: x.uid, name: x.name, status: x.status, word: x.word, shape: x.shape, floor: f.name }); }); }); });
      return { key: b.key, name: b.name, sessions: b.sessions, waiting: b.waiting, state: b.state, floors: def.floors.map(function (f) { return { name: f.name, key: f.key }; }), bots: bots };
    });
    var hq = hqBuilding(snap);
    return hq ? [hq].concat(otherHqBuildings(snap), out) : out;
  }
  // Paperclip HQ (#76): its company as the first building, once the office has read it. A pip per Paperclip agent, in the
  // state Paperclip reports (hq.status: never waiting, a Paperclip approval is not an office request). It is not a repository:
  // a click opens the HQ dialog, not a scene. Its sign carries the company's budget for its runs.
  var HQ_KEY = 'paperclip:hq';
  function hqBuilding(snap) {
    var q = snap && snap.hq, H = window.OfficeVocab.hq;
    if (!q || !q.company) return null;
    // The floors follow the org chart (#197, hq-model.mjs floorsOf): Records, Lobby, then one per rank, the top role on top. A server that sends none gets one HQ floor.
    var floors = q.floors && q.floors.length ? q.floors : [{ name: 'HQ', key: 'hq', employees: [] }], at = {};
    floors.forEach(function (f) { (f.employees || []).forEach(function (e) { at[e.id] = f.name; }); });
    var bots = q.agents.map(function (a) { var st = H.status(a); return { uid: 'hq:' + a.id, name: a.name, status: st.key, word: st.word, floor: at[a.id] || floors[0].name }; });
    var money = q.budget ? (q.budget.limit > 0 ? F.money(q.budget.spent) + ' of ' + F.money(q.budget.limit) : F.money(q.budget.spent)) : '';
    return { key: HQ_KEY, hq: true, name: q.company.name, sub: 'HQ · ' + plural(q.agents.length, 'agent', 'agents') + (money ? ' · ' + money : ''),
      line: (q.state === 'on' ? 'Paperclip HQ' : 'Paperclip HQ, not live') + ' · ' + (H.glance(q) || plural(q.agents.length, 'agent', 'agents') + (q.budget ? ' · ' + H.budget(q.budget) : '')),
      sessions: 0, waiting: 0, live: q.state === 'on', floors: floors.map(function (f) { return { name: f.name, key: f.key }; }), bots: bots };
  }
  // More than one company (#221): each other company of the connected Paperclip is its own HQ building of the campus, with no floors read.
  // A click makes it the watched company (the office reads one company at a time) and opens its HQ.
  function otherHqBuildings(snap) {
    var q = snap && snap.hq;
    if (!q || !q.company || !q.others || !q.others.length) return [];
    return q.others.map(function (o) {
      return { key: HQ_KEY + ':' + o.id, hq: true, companyId: o.id, name: o.name, sub: 'HQ · another company', line: 'Another company in this Paperclip. Open it to watch it.',
        sessions: 0, waiting: 0, live: false, floors: [{ name: 'HQ', key: 'hq' }], bots: [] };
    });
  }
  // The themes come from the DS (AgentOffice.MODES); the page keeps no copy of the list and names no theme. With no theme set,
  // the first theme whose dark flag matches the system scheme (the DS engine reads the system scheme the same way).
  var CITY_MODES = A.MODES;
  function themeMode() {
    var t = document.documentElement.getAttribute('data-theme'), i;
    for (i = 0; i < CITY_MODES.length; i++) if (CITY_MODES[i].theme === t) return CITY_MODES[i].id;
    var os = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    for (i = 0; i < CITY_MODES.length; i++) if (!!CITY_MODES[i].dark === os) return CITY_MODES[i].id;
    return CITY_MODES[0].id;
  }
  // How many bots are in each state across all buildings (DS StatusCounts keys; a finished bot is at rest).
  function cityCounts(list) {
    var c = { working: 0, waiting: 0, error: 0, resting: 0 };
    list.forEach(function (b) { if (!b.hq) b.bots.forEach(function (x) { c[c[x.status] != null ? x.status : 'resting']++; }); });   // sessions only: HQ pips are Paperclip agents
    return c;
  }
  function CityView(p) {
    var snap = useSnapshot();
    var pal = useState(false), palOpen = pal[0], setPalOpen = pal[1];
    var md = useState(themeMode), mode = md[0], setMode = md[1];
    useEffect(function () {
      var mo = new MutationObserver(function () { setMode(themeMode()); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return function () { mo.disconnect(); };
    }, []);
    var ref = React.useRef(null), city = React.useRef(null), fitted = React.useRef(false);
    var hv = useState(null), hov = hv[0], setHov = hv[1];
    var list = snap ? cityData(snap) : [];
    useEffect(function () {
      if (!window.OfficeCity) return undefined;
      city.current = window.OfficeCity.mount(ref.current, { root: document.documentElement, onHover: setHov, onPick: function (d) { if (d.hq) p.onHq(d.companyId); else p.onEnter(d.key, city.current); } });
      return function () { if (city.current) city.current.dispose(); city.current = null; };
    }, []);
    useEffect(function () {
      if (!city.current || !snap) return;
      city.current.update(list);
      if (!fitted.current) { fitted.current = true; city.current.fit(true); }
    }, [snap]);
    var waiting = list.reduce(function (n, b) { return n + b.waiting; }, 0);
    var counts = cityCounts(list), total = counts.working + counts.waiting + counts.error + counts.resting;
    // Palette bots: the name the palette shows and returns must be unique over all buildings, and it maps back to a building and a session uid.
    var palBots = [], palPick = {};
    list.forEach(function (b) { if (!b.hq) b.bots.forEach(function (x) {   // HQ pips are Paperclip agents, not sessions to go to
      var nm = x.name, i = 2;
      while (palPick[nm]) nm = x.name + ' ' + i++;
      palPick[nm] = { key: b.key, uid: x.uid };
      palBots.push({ name: nm, status: x.status, shape: x.shape, room: b.name });
    }); });
    function enterBot(name) { var t = palPick[name]; if (t) p.onEnter(t.key, city.current, t.uid); }
    // Ctrl+K in the city: the page's own actions (they include Go to each building), the theme, and the city view.
    var palActions = A.CommandPalette.actions({ setMode: function (m) { if (city.current) city.current.setMode(m); } })
      .filter(function (a) { return a.id.indexOf('page-b-') !== 0 && a.id.indexOf('page-s-go-') !== 0 && a.id !== 'page-city'; })   // the page's Go to only picks the building, and the bot rows already go to a session
      .concat(list.map(function (b) { return b.hq ? { id: 'city-hq' + (b.companyId ? ':' + b.companyId : ''), label: b.companyId ? 'Open the HQ of ' + b.name : 'Open Paperclip HQ', icon: 'hq', group: 'Buildings', keywords: 'paperclip hq company agents budget heartbeats routines ' + b.name, run: function () { p.onHq(b.companyId); } }
        : { id: 'city-go-' + b.key, label: 'Go to ' + b.name, icon: 'building', group: 'Buildings', keywords: 'building repository ' + b.name, run: function () { p.onEnter(b.key, city.current); } }; }))
      .concat([{ id: 'city-fit', label: 'Show all buildings', icon: 'building', group: 'City', run: function () { if (city.current) city.current.fit(false); } }]);
    return h('div', { className: 'city' },
      h('div', { ref: ref, className: 'city-scene' }),
      h('div', { className: 'city-hud' },
        h(A.Panel, { title: 'City', count: plural(list.length, 'building', 'buildings') },
          h('div', { className: 'city-tools' },
            h(A.ModeToggle, { value: mode, options: CITY_MODES, label: 'Theme', onChange: function (id) { if (city.current) city.current.setMode(id); } }),
            total ? h('div', { className: 'city-counts', title: 'Sessions in every building, by state' }, h(A.StatusCounts, { counts: counts })) : null,
            p.needs > 0 ? h(A.Button, { variant: 'emphasis', icon: 'waiting', className: 'city-needs', label: 'Needs you: ' + plural(p.needs, 'decision', 'decisions') + '. Go to the oldest.', title: 'Go to the oldest request', onClick: p.onNeeds }, 'Needs you · ' + p.needs) : null,
            h(A.Button, { variant: 'quiet', icon: 'search', onClick: function () { setPalOpen(true); } }, 'Search actions', h('kbd', { className: 'ao-kbd city-kbd', 'aria-hidden': 'true' }, 'Ctrl+K'))),
          !list.length ? h(A.EmptyState, { icon: 'building', compact: true, title: 'No buildings yet', text: 'Open a session in a git repository to add its building.' }) : null,
          h('ul', { className: 'city-list' }, list.map(function (b) {
            return h('li', { key: b.key },
              h('button', { type: 'button', className: 'city-row' + (b.key === p.shown ? ' is-shown' : '') + (hov && hov.key === b.key ? ' is-hover' : '') + (b.hq ? ' is-hq' : ''), onClick: function () { if (b.hq) p.onHq(b.companyId); else p.onEnter(b.key, city.current); } },
                h('span', { className: 'city-main' },
                  h('span', { className: 'city-name' }, b.hq ? h(A.Icon, { name: 'hq', size: 14, label: 'Paperclip HQ' }) : null, b.name),
                  h('span', { className: 'city-sub mono' }, b.hq ? b.line : plural(b.floors.length, 'floor', 'floors') + ' · ' + plural(b.sessions, 'session', 'sessions')),
                  b.waiting ? h('span', { className: 'city-wait' }, plural(b.waiting, 'request', 'requests')) : null),
                b.bots.length ? h('span', { className: 'city-dots', role: 'img', 'aria-label': b.bots.map(function (x) { return x.name + ' ' + x.word; }).join(', ') },
                  b.bots.slice(0, 12).map(function (x, i) { return h('span', { key: i, className: 'city-dot', title: x.name + ' · ' + x.word }, h(A.StatusDot, { status: x.status })); }),
                  b.bots.length > 12 ? h('span', { className: 'city-sub mono' }, '+' + (b.bots.length - 12)) : null) : null));
          })),
          h('p', { className: 'note' }, 'Each building is a repository. Each floor is a function, from Engineering to Records. Click a building, or zoom in on it, to go inside. In a building, zoom out to come back.'),
          waiting ? h('p', { className: 'note' }, plural(waiting, 'request waits', 'requests wait') + '. Buildings with a request show a beacon and lit windows.') : null)),
      hov ? h('div', { className: 'city-tag', role: 'status' }, h('b', null, hov.name), hov.hq ? ' · ' + hov.line : ' · ' + plural(hov.floors.length, 'floor', 'floors') + ' · ' + plural(hov.sessions, 'session', 'sessions') + (hov.waiting ? ' · ' + plural(hov.waiting, 'request', 'requests') : '')) : null,
      h('div', { className: 'city-zoom', role: 'toolbar', 'aria-label': 'City zoom' },
        h(A.Button, { variant: 'quiet', icon: 'zoom-in', title: 'Zoom in', onClick: function () { if (city.current) city.current.zoomBy(1.35); } }, 'Zoom in'),
        h(A.Button, { variant: 'quiet', icon: 'zoom-out', title: 'Zoom out', onClick: function () { if (city.current) city.current.zoomBy(1 / 1.35); } }, 'Zoom out'),
        h(A.Button, { variant: 'quiet', icon: 'building', onClick: function () { if (city.current) city.current.fit(false); } }, 'Show all')),
      h(A.CommandPalette, { open: palOpen, onClose: function () { setPalOpen(false); }, onOpen: function () { setPalOpen(true); }, bots: palBots, floors: [], actions: palActions, onBot: enterBot }));
  }

  // ---------- page commands in the DS command palette (Ctrl+K) ----------
  // The HUD builds its palette list with AgentOffice.CommandPalette.actions(); the page adds its own.
  var pageActions = [];   // set by App in an effect: a function that builds the list when the palette draws it
  (function () {
    var base = A.CommandPalette && A.CommandPalette.actions;
    if (!base || base.__page) return;
    var wrapped = function (o) { return base(o).concat(typeof pageActions === 'function' ? pageActions() : pageActions); };
    wrapped.__page = true;
    A.CommandPalette.actions = wrapped;
  })();
  // ---------- app ----------
  function winSize() { return { w: window.innerWidth, h: window.innerHeight }; }
  function App() {
    var sel = useChatBot();
    // The Decisions inbox: open or closed. The page owns the state (OfficeScene inbox, onInbox), so it can close it.
    // The state is kept with the key of its scene (ibKey, set where sceneKey is known), so a new scene starts
    // with the inbox closed in its first render, as the DS does when it keeps the state itself.
    var ib = useState({ key: null, open: false }), ibKey = React.useRef(null);
    var setInbox = React.useCallback(function (v) { ib[1]({ key: ibKey.current, open: !!v }); }, []);
    var s2 = useState(null), dlg = s2[0], setDlg = s2[1];
    var s3 = useState({ recent: [], templates: [], schedules: [] }), info = s3[0], setInfo = s3[1];
    var ws = useState(winSize), win = ws[0], setWin = ws[1];   // the window size: the scene height follows it (#55)
    // The phone list (#148): below 820 px it covers the scene until the user opens an agent. The scene stays mounted under it (the palette and the dialogs live there).
    var pl0 = useState(true), phoneList = pl0[0], setPhoneList = pl0[1];
    var phoneOn = win.w <= PHONE_MAX && phoneList;
    useEffect(function () { if (win.w > PHONE_MAX) setPhoneList(true); }, [win.w > PHONE_MAX]);   // a narrow window opens on the list again
    // The DS Since you left card shows (OfficeScene onSinceYouLeft, #66).
    var sy = useState(false), syl = sy[0], setSyl = sy[1];
    // Toasts (toasts.js): an error or a toast with an action stays until closed; the others close after 8 s, and wait while the pointer or focus is on them, or while the stack has no room (is-off).
    var tt = useState([]), toasts = tt[0], setToasts = tt[1], tid = React.useRef(0), toastBox = React.useRef(null);
    // The HQ dialog; with a company id (a building of another company of the Paperclip, #221) the office first watches that company.
    function openHq(companyId) {
      var q = latestSnap.current && latestSnap.current.hq;
      if (!companyId || !q || !q.url) { setDlg({ name: 'hq' }); return; }
      O.client.paperclipConnect({ url: q.url, company: companyId }).then(function () { setDlg({ name: 'hq' }); },
        function (x) { toast({ tone: 'error', title: 'Company not opened', text: x.message }); });
    }
    function toast(t) {
      var id = ++tid.current;
      if (t.action) {   // a click on the action closes its toast
        var act = t.action;
        t = Object.assign({}, t, { action: { label: act.label, onClick: function () { setToasts(function (l) { return window.OfficeToasts.remove(l, id); }); act.onClick(); } } });
      }
      setToasts(function (l) { return window.OfficeToasts.add(l, t, id, Date.now()); });
      return id;
    }
    // No access (no launch code, a used one, or a server restart): one error toast that stays until access is back.
    useEffect(function () {
      var shown = null;
      return window.officeAdapter.onAuth(function (a) {
        var old = shown;
        if (old) setToasts(function (l) { return window.OfficeToasts.remove(l, old); });
        shown = a.ok ? null : toast({ tone: 'error', title: 'No access to the office', text: a.reason });
      });
    }, []);
    // Older replies that did not load (#80): the chat of that bot shows the newest ones. An error toast stays until closed.
    useEffect(function () {
      return window.officeAdapter.onProblem(function (text) { toast({ tone: 'error', title: 'Older replies', text: text }); });
    }, []);
    var timed = window.OfficeToasts.hasTimed(toasts);
    useEffect(function () {
      if (!timed) return undefined;
      // While the pointer or focus is on the stack, state does not change: the time held is added when it ends.
      var last = Date.now(), held = 0;
      var iv = setInterval(function () {
        var now = Date.now(), dt = now - last; last = now;
        var el = toastBox.current, paused = !!el && (el.matches(':hover') || el.contains(document.activeElement) || el.classList.contains('is-off'));
        if (paused) { held += dt; return; }
        var h0 = held; held = 0;
        setToasts(function (l) { if (h0) l = window.OfficeToasts.tick(l, now, now - h0, true); return window.OfficeToasts.tick(l, now, now, false); });
      }, 250);
      return function () { clearInterval(iv); };
    }, [timed]);
    // Where the stack stands, at every width and window height (#79): toasts.js place decides from the boxes measured here.
    // KEEP: never covered: the top controls, the elevator panel, the zoom column, the lobby tour, every request
    // bar (Approve, Decline), message box and Back button of a panel, a pinned screen or the chat, the bezel count, the
    // decisions inbox, the city controls.
    // AVOID: covered only when no band is free of them: the DS HUD boxes (chat, roster, room card, Since you left), the
    // pinned screens, the board, stats and notes panels, the welcome card. A new box goes in one of the two lists.
    // It measures again when a box appears, goes or changes size (ResizeObserver), when a toast comes or goes, when
    // --strip-clear changes, on resize, and when a box scrolls. With no free band the stack waits out of sight (is-off) and its clocks wait.
    var KEEP = '.ao-hud-top, .ao-hud-left, .ao-hud-zoom, .ao-hud-inbox, .ao-hud-cast, .tour-card, .needs-go, .pin-head, .pin .ao-tablist, .pin-input, .term-input, .term-note, .bezel, .board-b > .inline-actions, .look-bar, .city-hud, .city-zoom, .ao-hud-chat .ao-chat-h, .ao-hud-chat .ao-tablist, .ao-hud-chat .ao-act, .ao-hud-chat .ao-chips, .ao-hud-chat .ao-composer';
    var AVOID = '.ao-hud > *, .board-panel, .pin, .notes-edit, .welcome';
    var placeRef = React.useRef(null);
    useEffect(function () {
      var wait = 0, trail = 0, ro = null, watched = new Set();
      function seen(b) {   // the part of a box the user can see: not display none, not visibility hidden (a panel hides the DS column that way), cut by every scrolling or clipping parent
        var cs = getComputedStyle(b);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        var r = b.getBoundingClientRect(), o = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (var p = b.parentElement; p && p !== document.body; p = p.parentElement) {
          var ps = getComputedStyle(p);
          if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
          var q = p.getBoundingClientRect();
          o = { left: Math.max(o.left, q.left), top: Math.max(o.top, q.top), right: Math.min(o.right, q.right), bottom: Math.min(o.bottom, q.bottom) };
        }
        return o.right > o.left && o.bottom > o.top ? o : null;
      }
      function rects(sel, els) {
        var out = [];
        document.querySelectorAll(sel).forEach(function (b) { var r = seen(b); if (r) { out.push(r); els.push(b); } });
        return out;
      }
      function watch(els) {   // the observer follows the measured boxes and the stack
        if (!ro) return;
        var now = new Set(els);
        now.forEach(function (e) { if (!watched.has(e)) ro.observe(e); });
        watched.forEach(function (e) { if (!now.has(e)) ro.unobserve(e); });
        watched = now;
      }
      function set(el, k, v) { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); }   // the same value writes nothing: no loop with the observers
      function place() {
        wait = 0;
        var el = toastBox.current;
        if (!el) return;
        var cs = getComputedStyle(el), strip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--strip-clear'));
        var vw = document.documentElement.clientWidth, vh = window.innerHeight, els = [el];
        var keep = rects(KEEP, els), avoid = rects(AVOID, els);
        watch(els);
        var home = { x: parseFloat(cs.getPropertyValue('--toast-home')) || 16, y: isFinite(strip) ? vh - strip : vh };
        var p = window.OfficeToasts.place({ w: vw, h: vh }, { w: el.getBoundingClientRect().width }, home, keep, avoid);
        el.classList.toggle('is-off', !!p.hidden);
        if (p.hidden) return;
        set(el, '--toast-x', p.x + 'px'); set(el, '--toast-bottom', p.bottom + 'px'); set(el, '--toast-room', p.maxH + 'px');
      }
      function soon() {   // at most every 120 ms, and once more after a panel animation has ended
        if (!wait) wait = setTimeout(place, 120);
        clearTimeout(trail); trail = setTimeout(place, 500);
      }
      placeRef.current = place;
      if (window.ResizeObserver) ro = new ResizeObserver(soon);
      var mo = new MutationObserver(soon);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });   // --strip-clear
      window.addEventListener('resize', soon);
      document.addEventListener('scroll', soon, true);   // a scrolled chat log or panel moves its request bars
      place();
      return function () { placeRef.current = null; mo.disconnect(); if (ro) ro.disconnect(); window.removeEventListener('resize', soon); document.removeEventListener('scroll', soon, true); clearTimeout(wait); clearTimeout(trail); };
    }, []);
    // a new or closed toast is placed before it paints, not up to 120 ms later
    React.useLayoutEffect(function () { if (placeRef.current) placeRef.current(); }, [toasts]);
    function refresh() { return getInfo(shownPath).then(function (i) { setInfo(i); return i; }, function () { return info; }); }
    function show(name) { refresh().then(function () { setDlg({ name: name }); }); }
    // The changes of a session with no room in the scene on screen (a past session, another building): the dialog.
    function changesDialog(uid, name) {
      var s = window.officeAdapter.sessionByUid(uid);
      setDlg({ name: 'changes', uid: uid, label: name, ended: !s || s.status === 'ended' });
    }
    // The changes of a session: on the wall screen of its room (#89), the room's floor first. The board flies there when the
    // floor shows its decor; until then this tries again each frame (at most 5 s), and the dialog takes over after that.
    var chgWant = React.useRef(null);
    function changes(uid, name) {
      var s = window.officeAdapter.sessionByUid(uid), o = officeRef.current, host = hostRef.current, b = boardRef.current;
      var roomId = s && s.place && s.place.roomId;
      var here = !!(s && roomId && o && host && b && mount && cur2.view === 'office' && window.officeAdapter.buildingOf(s) === mount.repo);
      var fl = here && o.getBuilding ? (o.getBuilding().floors || []).filter(function (f) { return (f.rooms || []).some(function (r) { return r.id === roomId; }); })[0] : null;
      if (!fl) { changesDialog(uid, name); return; }
      setDlg(null);
      if (host.floorId() !== fl.id) { host.blur(); o.setFloor(fl.id); }
      setChg({ uid: uid, name: name, roomId: roomId, ended: s.status === 'ended' });   // after the blur: its focus event clears chg
      chgWant.current = { roomId: roomId, uid: uid, name: name, until: Date.now() + WANT_MS, host: host };
      requestAnimationFrame(wantChanges);
    }
    function wantChanges() {
      var w = chgWant.current, host = hostRef.current, b = boardRef.current;
      if (!w) return;
      if (host !== w.host) { chgWant.current = null; return; }   // the scene went: nothing to fly to
      if (host && b && host.settled() && b.open(w.roomId, 'changes')) { chgWant.current = null; return; }
      if (Date.now() > w.until) { chgWant.current = null; setChg(null); changesDialog(w.uid, w.name); return; }
      requestAnimationFrame(wantChanges);
    }
    // Which building (repository) the scene shows. The choice is kept in the browser.
    var snap = useSnapshot();
    var cs = useState(function () { try { return localStorage.getItem('ao-building'); } catch (x) { return null; } }), cur = cs[0], setCur = cs[1];
    function pick(key) { setCur(key); try { localStorage.setItem('ao-building', key); } catch (x) { /* private window */ } }
    var list = snap ? window.officeAdapter.buildings(snap) : [];
    var queue = snap ? window.officeAdapter.queue(snap) : null;
    var needs = queue ? queue.items : [];   // the one queue: every open request of every building, oldest first (Needs you)
    var hasCur = list.some(function (b) { return b.key === cur; });
    // Show the chosen building while it has sessions; when it empties, go where the work is.
    var shown = hasCur || (!list.length && cur != null) ? cur : (list.length ? list[0].key : '');
    // Compact view: the DS ambient bar, for a second screen. ?ambient=1 starts in it.
    var am = useState(function () { return /[?&]ambient=1\b/.test(location.search); }), ambient = am[0], setAmbient = am[1];
    var wantKey = shown + (ambient ? ':ambient' : '');
    // City or office. The office is the default; the choice is kept in the browser.
    var vw = useState(function () { try { return localStorage.getItem('ao-view') === 'city' ? 'city' : 'office'; } catch (x) { return 'office'; } }), view = vw[0], setView = vw[1];
    // Smooth changes: the shown scene fades out, then the next one mounts and fades in.
    // cur2.mount is the building adapter of the scene on screen (null in the city, or before the first snapshot).
    // A scene gets a new one when the building changes, and when the adapter says it is stale: the DS has no
    // event that removes a floor or a room, so a removal mounts the building again.
    var fd = useState({ key: wantKey, repo: shown, view: view, mount: null, floor: null }), cur2 = fd[0], setCur2 = fd[1];
    var floorMem = React.useRef(null), offFloor = React.useRef(null);
    var visitRef = React.useRef(null);   // the place and deepest layer of the screen visit in progress (noteLayer)
    if (!floorMem.current) floorMem.current = window.OfficeBuilding.floorMemory();   // the floors of the page: which one a scene opens on, and the user's last pick, per building (#111)
    var stale = !!snap && !!cur2.mount && cur2.mount.stale();
    var needsMount = !!snap && view === 'office' && !cur2.mount && cur2.view === 'office';
    var mount = cur2.mount, def = mount ? mount.def : null;
    var sceneKey = mount ? 'm' + mount.id : cur2.key;
    ibKey.current = sceneKey;
    var inbox = ib[0].open && ib[0].key === sceneKey;
    var fading = cur2.key !== wantKey || cur2.view !== view || stale || needsMount;
    useEffect(function () {
      if (!fading) return undefined;
      var t = setTimeout(function () {
        var snapNow = window.officeAdapter.latest();
        var next = view === 'office' && snapNow ? window.officeAdapter.mount(shown) : null;
        // The floor on screen in the scene we leave (a rebuild, another building, the city). Floor ids are new for each
        // mount, so every match is by floor key. All rules of the choice are in OfficeBuilding.floorMemory (#85, #111).
        var was = null;
        if (cur2.mount && cur2.view === 'office' && hostRef.current) {
          try { was = cur2.mount.floorKey(hostRef.current.floorId()); } catch (x) { was = null; }
          floorMem.current.see(cur2.repo, was);
        }
        if (offFloor.current) { offFloor.current(); offFloor.current = null; }
        // The new scene opens on the floor the memory names, always: the page never lets the DS pick its default floor.
        var start = null;
        if (next) { try { start = floorMem.current.start(next, snapNow, cur2.repo === shown ? was : null); } catch (x) { start = null; } }
        var floor = start ? start.id : null;
        setCur2({ key: wantKey, repo: shown, view: view, mount: next, floor: floor });
      }, reduced() ? 0 : cssMs('duration-base', 240));
      return function () { clearTimeout(t); };
    }, [wantKey, view, stale, needsMount, sceneKey]);
    var introNext = React.useRef(true);
    var intro = useMemo(function () { var i = introNext.current; if (def) introNext.current = false; return i && !ambient; }, [def]);
    function go(v) { setView(v); try { localStorage.setItem('ao-view', v); } catch (x) { /* private window */ } }
    // From the city: fly to the building, then enter it with the DS intro flythrough.
    function enter(key, city, uid) {   // uid: the session to select once inside (no intro then, as in goTo)
      var inside = function () { if (uid) pendingSel.current = uid; introNext.current = !uid; pick(key); go('office'); };
      if (city) city.focus(key, inside); else inside();
    }
    var week = snap && snap.plan && snap.plan.week;
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-plan', !!week); }, [!!week]);
    var officeRef = React.useRef(null), focusRef = React.useRef(false);
    // the room board the camera faces, if any (board.js)
    var boardRef = React.useRef(null);
    var bs = useState(null), board = bs[0], setBoard = bs[1];
    var latestSnap = React.useRef(null); latestSnap.current = snap;
    // the desk monitors (terminal.js): each is a pinned screen with the chat and the terminal of its session
    var terminalRef = React.useRef(null);
    var personaRef = React.useRef(null);   // body language of the bots that have a persona (#150)
    // the scene host (scene-host.js): the one reader of the DS stage; board, terminal, streets and birds are its adapters
    var hostRef = React.useRef(null);
    // the Security room's wall screens (security.js): the user picks the permission rules on them
    var securityRef = React.useRef(null);
    useEffect(function () { if (securityRef.current) securityRef.current.refresh(); }, [snap]);
    // the lobby and the desks (lobby.js): open desks, the reception memo, the directory board, the nameplates (#92)
    var lobbyRef = React.useRef(null);
    useEffect(function () { if (lobbyRef.current) lobbyRef.current.refresh(); }, [snap]);
    var deskRef = React.useRef(null);   // the desk objects: approval papers, question notes, pause keys (desk.js, #90)
    useEffect(function () { if (deskRef.current) deskRef.current.refresh(); }, [snap]);
    // the screen the camera looks at (step 1 of a screen: scene-host.js focus), or null
    var lk = useState(null), look = lk[0], setLook = lk[1];
    // The pinned layer of the screen in focus (scene-host.js layer, #89): its screen, state and waiting count, not its box
    // (the screens put the box on themselves). deskTab: the tab of the desk screen. chg: the session whose changes the wall shows.
    var ly = useState(null), layer = ly[0], setLayer = ly[1];
    var dt = useState('chat'), deskTab = dt[0], setDeskTab = dt[1];
    var cg = useState(null), chg = cg[0], setChg = cg[1];
    var needsRef = React.useRef(0); needsRef.current = needs.length;
    function blurScene() { if (hostRef.current) hostRef.current.blur(); }   // fly back from a screen; nothing when none is in focus
    function closeBoard() { blurScene(); setBoard(null); }
    // The desk screen of a session (the dock, Ctrl+K, the bezel count): the scene goes to its building and floor, then
    // the camera flies to its monitor. It tries again each frame (at most 5 s) until the desk is on screen.
    var deskWant = React.useRef(null);
    function openDesk(uid, tab) {
      var s = window.officeAdapter.sessionByUid(uid);
      if (!s) return;
      setDeskTab(tab || 'chat'); setBoard(null);
      var nm = window.officeAdapter.botName(uid), o = officeRef.current;
      if (cur2.view !== 'office' || window.officeAdapter.buildingOf(s) !== shown || !o || !nm) goTo(s);
      else o.select(nm);   // its floor, and the dock's actions for it
      var t0 = Date.now();
      deskWant.current = { uid: uid, until: t0 + WANT_MS, hard: t0 + 6 * WANT_MS, ready: false };
      requestAnimationFrame(wantDesk);
    }
    function wantDesk() {
      var w = deskWant.current, t = terminalRef.current, host = hostRef.current;
      if (!w) return;
      var f = host && host.focused();
      if (f && f.kind === 'terminal' && f.item && f.item.uid === w.uid) { deskWant.current = null; return; }
      if (host) host.skipIntro();   // the intro is decoration; a slow renderer would hold the desk behind it (#189)
      if (t && host && host.settled() && t.open(w.uid)) { deskWant.current = null; return; }
      // the WANT_MS clock starts once the scene is up and settled (a loaded machine mounts and introduces it slowly, #189)
      var c = window.OfficeSceneHost.pure.wantClock(w, Date.now(), !!(t && host && host.settled()), WANT_MS);
      deskWant.current = Object.assign({}, w, c.w);
      if (c.expired) {
        deskWant.current = null;
        var s = window.officeAdapter.sessionByUid(w.uid);
        toast({ tone: 'info', title: s ? s.name : 'Desk', text: 'The desk of this session is not on screen.' });
        return;
      }
      requestAnimationFrame(wantDesk);
    }
    // Needs you (the scene's top bar, the city panel, the bezel count of a screen in focus): one tap goes to the oldest open request
    // of every building (needs is officeAdapter.queue(snap).items, oldest first, the count of the one Notifier), at the desk screen of its
    // session (#89), where the request shows with Approve and Decline.
    // The oldest request: the camera looks at its paper or note on the desk. When that desk is not on screen yet, the scene goes
    // there (its monitor) and the next press finds the paper.
    function goOldest() {
      openQueueItem(queue && queue.oldest);
    }
    // Every surface opens a request through here (the top bar, the panels, the bezel, a toast): the queue says how it opens.
    function openQueueItem(r) {
      var way = queue && queue.reach(r);
      if (!way) return;
      if (way.via === 'list') { setDlg({ name: 'needs' }); return; }   // a Ready to merge decision has no desk (#93)
      if (deskRef.current && way.id && cur2.view === 'office' && deskRef.current.show(way.id, false)) return;
      openDesk(way.uid, 'chat');
    }
    function noteKey(roomId) { return mount ? mount.noteKey(roomId) : ''; }   // the server's key for the room (place.mjs)
    useEffect(function () { return function () {
      if (boardRef.current) { boardRef.current.dispose(); boardRef.current = null; }
      if (terminalRef.current) { terminalRef.current.dispose(); terminalRef.current = null; }
      if (personaRef.current) { personaRef.current.dispose(); personaRef.current = null; }
      if (securityRef.current) { securityRef.current.dispose(); securityRef.current = null; }
      if (lobbyRef.current) { lobbyRef.current.dispose(); lobbyRef.current = null; }
      if (deskRef.current) { deskRef.current.dispose(); deskRef.current = null; }
      if (hostRef.current) { hostRef.current.dispose(); hostRef.current = null; }
      setBoard(null); setLook(null); setLayer(null); setChg(null);
    }; }, [sceneKey, cur2.view]);
    // doors: a session that comes into a room or leaves it of the shown building.
    // Room ids come from the board's rooms; the adapter says who sits in each.
    var doorsRef = React.useRef(null);
    // every room of the shown building, from the scene itself (DS room ids, all floors)
    function roomIds() {
      var o = officeRef.current, bl = o && o.getBuilding && o.getBuilding(), out = [];
      ((bl && bl.floors) || []).forEach(function (f) { (f.rooms || []).forEach(function (r) { out.push(r.id); }); });
      return out;
    }
    function roomsNow2(sn) {
      var b = boardRef.current, out = {};
      if (!b || !mount || mount.repo !== shown) return null;
      roomIds().forEach(function (id) {
        var inf = mount.roomInfo(id, sn);
        var rn = (inf.place && inf.place.roomName) || 'Room';
        inf.sessions.forEach(function (x) { if (x.status !== 'ended' && x.place) out[x.uid] = { room: id, name: x.name, roomName: rn }; });
      });
      return out;
    }
    useEffect(function () {
      if (!snap || cur2.view !== 'office') { doorsRef.current = null; return; }
      var now = roomsNow2(snap);
      if (!now) { doorsRef.current = null; return; }
      var prev = doorsRef.current;
      doorsRef.current = { shown: shown, sessions: now };
      if (!prev || prev.shown !== shown) return;
      var b = boardRef.current;
      Object.keys(now).forEach(function (u) {
        if (prev.sessions[u] && prev.sessions[u].room === now[u].room) return;
        if (b && b.doorPulse) b.doorPulse(now[u].room, 'in');
      });
      Object.keys(prev.sessions).forEach(function (u) {
        if (now[u] && now[u].room === prev.sessions[u].room) return;
        if (b && b.doorPulse) b.doorPulse(prev.sessions[u].room, 'out');
      });
    }, [snap]);
    // One panel at a time: while a pinned screen (the desk chat and terminal, the room's changes), the board or the stats panel
    // is open, the DS right column (chat or roster) is hidden. The pinned screens show the open requests as the bezel count.
    var pinned = !!(layer && layer.pin);
    var deskUid = pinned && layer.kind === 'terminal' && layer.item ? layer.item.uid : null;
    var panelOpen = pinned || !!(board && (board.kind === 'board' || board.kind === 'stats'));
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('has-panel', panelOpen); }, [panelOpen]);
    // The spare room of an empty building takes no bots and no message: the DS broadcast bar is hidden then (office.css).
    var spareNow = !!(mount && mount.spare && mount.spare());
    useEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('no-rooms', spareNow); }, [spareNow]);
    // A side panel changes the free part of the view: the screen in focus is framed again beside it. The window too.
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [panelOpen]);
    // A Security room screen in focus (review M6): at 820 px and below office.css hides the floor list and the room card (the
    // Decisions inbox stays), so the screen gets the height of the view; it is framed again when that changes. The look bar
    // then shows the open requests (LookBar asks).
    var secLook = !!(look && look.kind === 'security');
    // A pinned desk or changes screen needs the height too (review 89: at 400x640 a request needs 140-170 px): the same columns go.
    var hideHud = secLook || pinned;
    React.useLayoutEffect(function () { var el = document.getElementById('office'); if (el) el.classList.toggle('sec-look', hideHud); }, [hideHud]);
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [hideHud]);
    // The scene is as tall as the window. The DS sets its height inline from the height prop, so a resize renders
    // the page again with the new size (once per frame), and then frames the screen in focus again (#55).
    useEffect(function () {
      var raf = 0;
      function onResize() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; setWin(winSize()); }); }
      window.addEventListener('resize', onResize);
      return function () { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
    }, []);
    useEffect(function () { if (hostRef.current) hostRef.current.refit(); }, [win]);
    // Esc flies back from a screen (a look or an open panel). Esc closes the top layer only: a dialog or the palette
    // on top takes it (board.js escTaken), and so does an open panel's own handler that ran first.
    useEffect(function () {
      function onKey(e) {
        var host = hostRef.current, B = window.OfficeBoard;
        if (e.key !== 'Escape' || !host || !host.focused() || (B && B.escTaken ? B.escTaken(e) : e.defaultPrevented)) return;
        e.preventDefault(); host.blur();
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, []);
    // When the office opens something new in the right column (the Decisions inbox, or the chat of another bot),
    // the page panel steps aside. The bot of the desk in focus is not new: the desk selects it. A desk the page is
    // flying to (openDesk) is not new either. The desk in focus is read from the host now, not from the last render.
    var lastSel = React.useRef(sel);
    var selSess = sel ? window.officeAdapter.session(sel) : null;
    useEffect(function () {
      var prev = lastSel.current; lastSel.current = sel;
      if (!panelOpen) return;
      var f = hostRef.current && hostRef.current.focused(), fu = f && f.kind === 'terminal' && f.item ? f.item.uid : null;
      var mine = selSess && (selSess.uid === fu || (deskWant.current && deskWant.current.uid === selSess.uid));
      if (inbox || (sel && sel !== prev && !mine)) {
        blurScene();
        setBoard(null);
      }
    }, [sel, inbox]);
    // The newest surface wins: a page panel that opens while the Decisions inbox is open closes the inbox.
    var wasPanel = React.useRef(false);
    useEffect(function () {
      var was = wasPanel.current; wasPanel.current = panelOpen;
      if (panelOpen && !was && inbox) setInbox(false);
    }, [panelOpen]);
    // zoom out to leave: scrolling out at the widest zoom goes floor -> building -> city
    useEffect(function () {
      if (cur2.view !== 'office') return undefined;
      // One gesture leaves one level (wheel-gate.js): a pause after each change, three pushes at the building level.
      var gate = window.OfficeWheelGate.create();
      function onWheel(e) {
        var o = officeRef.current, st = o && o.inspect && o.inspect().stage;
        var host = hostRef.current, level = host && host.inBuilding() ? 'building' : 'floor';
        // a screen in focus (or a flight to it or back) holds the floor: Esc or Back leaves it first
        var held = !!(host && (host.focused() || host.flying()));
        var now = Date.now(), inScene = !!(e.target.closest && e.target.closest('.ao-scene'));
        var ok = !!(st && st.ctl && e.deltaY > 0 && inScene && !held && st.cam.zoom <= st.ctl.minZoom * 1.03);
        var leave = gate.push(level, now, ok);
        // keep the DS camera feel from clearing the framing the level change started
        if (inScene && (leave || gate.holding(now))) { e.preventDefault(); e.stopPropagation(); }
        if (!leave) return;
        if (level === 'building') go('city'); else o.setView('building');
      }
      window.addEventListener('wheel', onWheel, { passive: false, capture: true });
      return function () { window.removeEventListener('wheel', onWheel, true); };
    }, [cur2.view]);
    // notifier: false: the page runs the one Notifier (alerts and the tab title for every building, below).
    // Since you left shows on every scene: the adapter seeds the state it sends again, so the card counts only news.
    var scene = cur2.view === 'city' ? h(CityView, { key: 'city', shown: shown, onEnter: enter, needs: needs.length, onNeeds: goOldest, onHq: openHq }) : def ? h(A.OfficeScene, { key: sceneKey, building: def, adapter: mount.adapter, floor: cur2.floor == null ? undefined : cur2.floor, height: win.h, quality: 'auto', intro: intro, editable: false, simulate: false, toasts: false,
      inbox: inbox, onInbox: setInbox, notifier: false, onSinceYouLeft: setSyl, floorsTitle: 'Elevator',
      // Needs you in the top bar, at every width (#92 review: with no dock, a request in another building showed only in the tab title)
      waitingCount: needs.length, onWaiting: goOldest,
      // The scene's live request and error toasts go to the page stack, where they stay until closed. Seeded events
      // (a scene mounted again) send none: an open request stays in Needs you, the inbox and the tab title.
      onNotify: function (n) {
        if (n.kind !== 'request' && n.kind !== 'error') return;
        var ns = mount ? mount.session(n.bot) : null;   // the session, so the toast and its Open outlive a scene change
        toast({ tone: n.kind === 'error' ? 'error' : 'warning', title: n.bot, text: n.text, bot: n.bot, req: n.kind === 'request', uid: ns ? ns.uid : '', action: { label: 'Open', onClick: function () { var qi = n.kind === 'request' && window.officeAdapter.queue().find(n.id); if (qi) openQueueItem(qi); else if (ns) goTo(ns); else if (officeRef.current) officeRef.current.select(n.bot); } } });
      },
      ambient: ambient, onAmbientOpen: function () { setAmbient(false); }, onReady: function (o) {
        officeRef.current = o; readyKey.current = sceneKey;
        selectPending(o);
        window.officeScene = o;   // the mounted office API, for the console and tests
        var st = o.inspect && o.inspect().stage;
        if (boardRef.current) boardRef.current.dispose();
        if (terminalRef.current) terminalRef.current.dispose();
        if (personaRef.current) personaRef.current.dispose();
        if (securityRef.current) { securityRef.current.dispose(); securityRef.current = null; }
        if (hostRef.current) hostRef.current.dispose();
        // waiting: the bezel of the screen in focus counts every request of every building (Needs you)
        var host = hostRef.current = window.OfficeSceneHost && st ? window.OfficeSceneHost.attach(o, { covers: sceneCovers, waiting: function () { return needsRef.current; } }) : null;
        window.officeHost = host;   // the scene host (focus, flights), for the console and tests
        // The pinned layer: the page renders again when its screen, state or count changes; the box moves without a render.
        if (host) host.onLayer(function (l) {
          setLayer(function (p) { return p && l && p.key === l.key && p.shown === l.shown && p.pin === l.pin && p.waiting === l.waiting && p.item === l.item ? p : l; });
        });
        // The floor the user looks at, for the memory of floors: a floor other than the one the page opened is a move (#111).
        if (offFloor.current) { offFloor.current(); offFloor.current = null; }
        if (host && mount) {
          var seenRepo = cur2.repo, seenMount = mount;
          offFloor.current = host.frame(function () { floorMem.current.see(seenRepo, seenMount.floorKey(host.floorId())); });
        }
        // A screen in focus: a look shows the look bar; a look, a look at another screen or a way back closes the panels.
        // The second step opens a panel through the board's onOpen. A pinned screen (a desk monitor, the room's changes) has
        // no look bar: its layer is the screen, with its own Back. A desk in focus selects its bot (the dock's actions for it).
        // A Security room screen keeps the look bar in focus: every click on it is a click on a cell, never a panel.
        if (host) host.onFocus(function (f) {
          // The layer used here is remembered per place; a place used at Inspect or deeper opens on the first tap.
          var Ly = window.OfficeVocab.layers, rid = f && f.item && f.item.roomId, fs = f && f.kind === 'terminal' && f.item && f.item.uid ? window.officeAdapter.sessionByUid(f.item.uid) : null;
          var place = rid || (fs && fs.place && fs.place.roomId);
          // Only the deepest layer a visit reached counts, when the visit ends: a look that went on to Inspect is not also a Look.
          var at = f && place ? (f.kind === 'security' ? 'deep' : f.open || f.pin ? 'inspect' : 'look') : '';
          if (at) { var v = visitRef.current; if (v && v.place !== place) noteLayer(v.place, v.at); visitRef.current = v && v.place === place && Ly.order.indexOf(v.at) >= Ly.order.indexOf(at) ? v : { place: place, at: at }; }
          else if (!f && visitRef.current) { noteLayer(visitRef.current.place, visitRef.current.at); visitRef.current = null; }
          if (f && !f.open && !f.pin && rid && f.kind !== 'security' && Ly.opensAt(Ly.layerFor(layerMemory(), rid))) setTimeout(function () { if (hostRef.current && hostRef.current.focused()) hostRef.current.open(); }, 0);
          setLook(f && !f.pin && (!f.open || f.kind === 'security') ? f : null);
          if (!f || !f.open) setBoard(null);
          if (!f || f.kind !== 'changes') setChg(null);
          if (f && f.pin && f.kind === 'terminal' && f.item && f.item.name) o.select(f.item.name);
        });
        if (st && host && window.OfficeBoard) {
          boardRef.current = window.OfficeBoard.attach(o, {
            host: host,
            room: function (id) { return mount.roomInfo(id); },
            usable: function (id) { return mount.usable(id); },
            note: function (id) { var n = latestSnap.current && latestSnap.current.notes && latestSnap.current.notes[noteKey(id)]; return n ? n.text : ''; },
            tree: function (root) { return client.tree({ root: root }); },
            stats: function (id) { return mount.figures(id); },
            goals: function (id, building) { return window.OfficeVocab.plan.board(latestSnap.current && latestSnap.current.plans, building).groups; },   // the Manager board on the wall (#157)
            view: function (id) { return window.OfficeVocab.wall.viewOf(latestSnap.current && latestSnap.current.screens, noteKey(id)); },   // the blackboard view the user chose for this room (#152)
            pin: function (id) { var n = latestSnap.current && latestSnap.current.pins && latestSnap.current.pins[noteKey(id)]; return n && n.text ? { text: n.text, by: n.by } : null; },
            onDoor: function (id) { setDlg({ name: 'room', roomId: id }); },
            state: function (id) { return mount.rollup().rooms[id] || null; },
            onOpen: function (id, kind) { if (kind !== 'changes') setBoard({ id: id, kind: kind }); }
          });
        }
        if (st && host && window.OfficeSecurity) {
          var secMount = mount;
          securityRef.current = window.OfficeSecurity.attach(o, {
            host: host,
            roomId: function () { return secMount.securityRoom(); },
            // the rules, what each agent kind enforces and the Spend figures (snap.security), for this building
            data: function () { var sn = latestSnap.current; return sn && sn.security ? { sec: sn.security, building: secMount.repo, buildingName: (def && def.name) || '', hq: sn.hq || null } : null; },
            post: function (cmd, body) { return client.send(cmd, body); },
            onError: function (text) { toast({ tone: 'error', title: 'Security', text: text }); }
          });
          window.officeSecurity = securityRef.current;   // the Security room screens (open a screen), for the console and tests
        }
        if (st && host && window.OfficeLobby) {
          var lobMount = mount;
          if (lobbyRef.current) lobbyRef.current.dispose();
          lobbyRef.current = window.OfficeLobby.attach(o, {
            host: host,
            layout: function () { var sn = latestSnap.current; return (sn && sn.layouts && sn.layouts[lobMount.repo]) || null; },
            since: function () { try { var sm = o.summary ? o.summary() : null; return ((sm && sm.top) || []).map(function (x) { return typeof x === 'string' ? x : String(x && x.text || ''); }); } catch (x) { return []; } },
            // the building's changes (folders, tray, pipeline) for the pipeline board and the paper props (#93)
            changes: function () { var sn = latestSnap.current; return sn ? window.OfficeBuilding.changes(sn, lobMount.repo) : null; },
            floors: function () { return lobMount.floors(); },
            states: function () { return lobMount.rollup().floors; },
            agents: function () { return lobMount.agentsByFloor(); },
            session: function (botName) { return lobMount.session(botName); },
            onDesk: function (roomId) { deskStart(roomId); },
            // the tour's monitor stop: an agent's monitor on the floor first (terminal.js look), else an open desk's
            monitor: function () { return !!(terminalRef.current && terminalRef.current.look && terminalRef.current.look()); },
            onReception: function (part) { if (part === 'directory') openPalette(); else if (part === 'pipeline') setDlg({ name: 'flow' }); else setDlg({ name: 'reception' }); }
          });
          window.officeLobby = lobbyRef.current;   // the lobby (open desks, memo, directory, nameplates), for the console and tests
        }
        if (st && host && window.OfficeTerminal) {
          terminalRef.current = window.OfficeTerminal.attach(o, {
            host: host,
            session: function (botName) { return mount.session(botName); },
            // a click on the monitor in focus outside its layer: the desk screen shows its chat
            onOpen: function () { setDeskTab('chat'); }
          });
        }
        if (st && host && window.OfficePersona) {
          if (personaRef.current) personaRef.current.dispose();
          personaRef.current = window.OfficePersona.attach(o, { host: host, session: function (botName) { return mount.session(botName); }, off: function () { return focusRef.current; } });
          window.officePersona = personaRef.current;   // for the console and tests
        }
        if (st && host && window.OfficeDesk) {
          var deskMount = mount;
          if (deskRef.current) deskRef.current.dispose();
          deskRef.current = window.OfficeDesk.attach(o, {
            host: host,
            targets: function () { return deskMount.deskTargets(latestSnap.current); },
            sessions: function () { return ((latestSnap.current && latestSnap.current.sessions) || []).filter(function (x) { return deskMount.botName(x.uid); }).map(function (x) { return Object.assign({}, x, { botName: deskMount.botName(x.uid) }); }); },
            onAnswer: function (paper, act) {
              client.answer({ id: paper.id, allow: act.allow, always: !!act.always }).then(function () {
                if (act.always) toast({ tone: 'success', title: paper.bot, text: 'Allowed from now on: ' + paper.always });
              }, function (x) { toast({ tone: 'error', title: paper.bot, text: x.message }); });
            },
            onPause: function (uid) { client.interrupt({ uid: uid }).catch(function (x) { toast({ tone: 'error', title: 'Pause', text: x.message }); }); }
          });
          window.officeDesk = deskRef.current;   // the desk objects, for the console and tests
        }
        if (!st || !host || !window.OfficeCity) return;
        window.OfficeCity.cameraFeel(st);
        // birds over the tower in the building view; none inside a floor
        // the host knows the view from the floor groups, not from the page markup
        var outside = function () { return host.inBuilding(); };
        window.OfficeCity.streetsAround(st, { visible: outside, host: host });
        window.OfficeCity.birds(st, { count: 6, radius: 13, size: 0.6, visible: outside, host: host,
          center: function () { var fl = (o.getBuilding && o.getBuilding().floors.length) || 1; return [0, fl * 4.2 + 4, 0]; } });
      },
      reset: week ? resetText(week.resetsAt) : undefined }) : null;

    // A session opened from this page that sits in another building: offer the way there.
    var seen = React.useRef(null);
    useEffect(function () {
      if (!snap) return;
      if (!seen.current) { seen.current = {}; snap.sessions.forEach(function (s) { seen.current[s.uid] = true; }); return; }
      snap.sessions.forEach(function (s) {
        if (seen.current[s.uid] || !s.place) return;
        seen.current[s.uid] = true;
        var key = window.officeAdapter.buildingOf(s);
        if (s.status !== 'ended' && key !== shown) toast({ tone: 'info', title: s.name, text: 'Opened in ' + s.place.building + '.', action: { label: 'Go there', onClick: function () { pick(key); } } });
      });
    }, [snap]);

    // the folder of the shown building, for Open session to start in
    var shownRepo = snap && (snap.repos || []).filter(function (r) { return r.key === shown; })[0];
    var shownPath = shownRepo ? shownRepo.path : '';
    // An open desk (#92): the Open dialog starts the agent with the desk's floor as its role, in the room's folder
    // (the building's folder for a room of open desks). Phase 2 (#90) starts it at the desk with no dialog.
    // The second click on an open desk (#90): an agent of the default kind starts at once, in that room's workspace, with the role
    // of the floor. There is no form: Open session in Ctrl+K keeps the form for another kind, model or folder. A kind that asks
    // the cost question (not the default one) is not started from a desk.
    function deskStart(roomId) {
      var fn = mount ? mount.roomFloor(roomId) : null, pl = mount ? mount.roomInfo(roomId).place : null;
      var cwd = (pl && pl.path) || shownPath || ((info && info.recent) || [])[0] || '';
      client.open({ cwd: cwd, provider: DEFAULT_KIND, where: 'office', isolation: 'same', role: fn || undefined }).then(function () {}, function (x) {
        toast({ tone: 'error', title: 'Start agent', text: x.message });
      });
    }
    // Orientation (#196): opens once for a new user (the server's seen flag and this browser's key), before the tour. null until read.
    var oz = useState(null), orient = oz[0], setOrient = oz[1];
    useEffect(function () {
      client.get('orientation').then(function (j) { var due = orientationDue(j); setOrient(!due); if (due) setDlg({ name: 'orientation' }); }, function () { setOrient(true); });
    }, []);
    // The lobby tour: once per browser, on the Lobby of the first building shown; Replay from the Reception or Ctrl+K.
    var tr = useState(false), touring = tr[0], setTouring = tr[1];
    function startTour() {
      var o = officeRef.current;
      if (o && mount && o.setFloor) { var lid = mount.floorId('lobby'); if (lid != null) o.setFloor(lid); }
      setTouring(true);
    }
    function endTour() {
      setTourSeen(); setTouring(false);
      var el = document.getElementById('office'); if (el) el.classList.remove('tour-elevator');
      if (hostRef.current) hostRef.current.blur();
    }
    function tourStep(key) {
      var el = document.getElementById('office'); if (el) el.classList.toggle('tour-elevator', key === 'elevator');
      if (lobbyRef.current) lobbyRef.current.tour(key);
    }
    var readyFor = mount ? mount.id : null;
    useEffect(function () {
      if (!readyFor || orient !== true || ambient || touring || !window.OfficeLobby || !window.OfficeLobby.pure.tourDue(tourSeen(), cur2.view === 'office')) return undefined;
      // after the intro flight, once the scene and its lobby are ready (at most 10 s)
      var n = 0, t = setInterval(function () { if (lobbyRef.current && lobbyRef.current.idle()) { clearInterval(t); startTour(); } else if (++n > 40) clearInterval(t); }, reduced() ? 50 : 250);
      return function () { clearInterval(t); };
    }, [readyFor, orient]);

    // A request toast goes once its request is answered.
    var needIds = needs.map(function (r) { return r.uid; }).join('|');
    useEffect(function () {
      setToasts(function (l) {
        // by session uid, against the requests of every building (not the scene on screen); a toast with no uid goes when nothing waits
        var keep = l.filter(function (t) { if (!t.req) return true; return needs.some(function (r) { return !t.uid || r.uid === t.uid; }); });
        return keep.length === l.length ? l : keep;
      });
    }, [needIds]);
    function close() { setDlg(null); }
    function alertsOn() { try { return localStorage.getItem('ao-alerts') === '1'; } catch (x) { return false; } }
    function extensions(uid, name) { setDlg({ name: 'ext', uid: uid, label: name }); }
    // Go to a session: show its building (inside, from the city), then select its bot once that scene is ready.
    var pendingSel = React.useRef(null);
    function goTo(s) {
      var key = window.officeAdapter.buildingOf(s);
      pendingSel.current = s.uid; pick(key); setDlg(null);
      if (view !== 'office') { introNext.current = false; go('office'); }   // a bot is the target: the intro would end by clearing its selection
      else if (key === shown && officeRef.current) selectPending(officeRef.current);   // the scene is already up
    }
    // The bot is seated a moment after the scene is ready, so this runs again on each snapshot until it is found.
    // It stops when the session is gone.
    var readyKey = React.useRef(null);
    function selectPending(o, tries) {
      var uid = pendingSel.current;
      if (!uid) return;
      var n = window.officeAdapter.botName(uid);
      if (n) { pendingSel.current = null; o.select(n); return; }
      var s = window.officeAdapter.sessionByUid(uid);
      if (!s || s.status === 'ended') { pendingSel.current = null; return; }
      // not seated yet: look again next frame (at most 120 frames), unless the scene went away
      if ((tries || 0) < 120) requestAnimationFrame(function () { if (officeRef.current === o) selectPending(o, (tries || 0) + 1); });
    }
    useEffect(function () { if (pendingSel.current && officeRef.current && readyKey.current === sceneKey) selectPending(officeRef.current); }, [snap, sceneKey]);
    // The sessions of a room, plus the bot whose chat is open when it sits in another room: its requests stay in view.
    function roomAndSel(roomId, onlyExtra) {
      var inRoom = mount ? mount.roomInfo(roomId, snap || undefined).sessions : [];
      var extra = selSess && !inRoom.some(function (x) { return x.uid === selSess.uid; }) ? [selSess] : [];
      return onlyExtra ? extra : inRoom.concat(extra);
    }
    var d = dlg && dlg.name;
    // Focus mode (#151): the server keeps it and the snapshot carries it. It turns off sound, the bots' body language, the merged moment and the stand-up.
    var focusOn = !!(snap && snap.rituals && snap.rituals.focus);
    focusRef.current = focusOn;
    useEffect(function () { if (focusOn && officeRef.current && officeRef.current.setSound) officeRef.current.setSound(false); }, [focusOn]);

    // the page's own commands in Ctrl+K, built from this render's state and handed to the palette after the render
    var actions = [];
    [['open', 'Open a session', 'add', function () { show('open'); }], ['sessions', 'All sessions', 'identity', function () { setDlg({ name: 'sessions' }); }],
     ['city', 'City view', 'building', function () { go('city'); }], ['office', 'Office view', 'floor', function () { go('office'); }], ['floors', 'Branches and worktrees', 'floor', function () { setDlg({ name: 'floors' }); }],
     ['past', 'Past sessions', 'session', function () { show('past'); }], ['schedules', 'Schedules', 'schedule', function () { show('schedules'); }],
     ['hooks', 'Attach sessions', 'terminal', function () { show('hooks'); }], ['kinds', 'Agent kinds', 'bot', function () { setDlg({ name: 'kinds' }); }], ['personas', 'Agent characters', 'bot', function () { setDlg({ name: 'personas' }); }], ['recap', 'Weekly recap and while you were away', 'schedule', function () { setDlg({ name: 'recap' }); }], ['compact', 'Compact view', 'zoom-out', function () { setAmbient(true); }],
     ['reception', 'Reception: floors and the kind of building', 'building', function () { setDlg({ name: 'reception' }); }], ['orientation', 'Orientation: set up the office', 'approve', function () { setDlg({ name: 'orientation' }); }], ['tour', 'Replay the lobby tour', 'chevron-right', function () { startTour(); }]]
      .forEach(function (a) { actions.push({ id: 'page-' + a[0], label: a[1], icon: a[2], group: 'Office', run: a[3] }); });
    var selKind = selSess ? kindOf(window.officeAdapter.kinds(), selSess.provider) : null;
    if (selSess && (!selKind || selKind.control)) actions.push({ id: 'page-ext', label: 'Extensions of ' + selSess.name, icon: 'connector', group: 'Office', run: function () { extensions(selSess.uid, selSess.name); } });
    actions.push({ id: 'page-focus', label: focusOn ? 'Turn off Focus mode' : 'Turn on Focus mode', icon: 'sound-off', group: 'Office', keywords: 'quiet sound motion rituals calm', run: function () { client.settingsFocus({ on: !focusOn }).then(function () { toast({ tone: 'info', title: !focusOn ? 'Focus mode is on' : 'Focus mode is off', text: !focusOn ? 'Sound, motion and rituals are off.' : 'Rituals are back.' }); }, function (x) { toast({ tone: 'error', title: 'Focus mode', text: x.message }); }); } });
    var trustN = snap && snap.security && snap.security.trust ? snap.security.trust.proposals.length : 0;
    actions.push({ id: 'page-trust', label: trustN ? 'Earned trust (' + trustN + (trustN === 1 ? ' proposal)' : ' proposals)') : 'Earned trust', icon: 'security', group: 'Office', keywords: 'trust proposals rules allow withdraw grant security approvals', run: function () { setDlg({ name: 'trust' }); } });
    actions.push({ id: 'page-needs', label: needs.length ? 'Needs you (' + needs.length + ')' : 'Needs you', icon: 'waiting', group: 'Office', keywords: 'requests approve decline questions decisions', run: function () { setDlg({ name: 'needs' }); } });
    actions.push({ id: 'page-flow', label: 'Changes: pipeline and Ready to merge', icon: 'pull-request', group: 'Office', keywords: 'pull request pr merge pipeline folder review checks tray', run: function () { setDlg({ name: 'flow' }); } });
    var planWaits = snap ? window.OfficeVocab.plan.waits(snap.plans) : [], planAll = snap ? window.OfficeVocab.plan.board(snap.plans) : { groups: [], unreadable: [] };
    if (planAll.groups.length || planAll.unreadable.length) actions.push({ id: 'page-manager', label: planWaits.length ? 'Manager board (' + planWaits.length + ' waits for you)' : 'Manager board', icon: 'plan', group: 'Office', keywords: 'manager plan goal steps paperclip office tasks approve', run: function () { setDlg({ name: 'manager' }); } });
    planWaits.forEach(function (w, i) { actions.push({ id: 'page-plan-' + i, label: w.text, icon: 'waiting', group: 'Office', keywords: 'manager plan goal approve retry step', run: function () { setDlg({ name: 'manager' }); } }); });
    if (snap && snap.hq && snap.hq.company) actions.push({ id: 'page-hire', label: 'Hire an employee', icon: 'add', group: 'Office', keywords: 'hire hr desk employee agent role budget onboarding paperclip', run: function () { setDlg({ name: 'hire' }); } });
    if (snap && snap.hq && snap.hq.company && snap.hq.taskWrite) actions.push({ id: 'page-new-task', label: 'New Paperclip task', icon: 'plus', group: 'Office', keywords: 'task mailroom create assign comment status issue paperclip', run: function () { setDlg({ name: 'hq', focus: { kind: 'mailroom', id: 'new' } }); } });
    actions.push({ id: 'page-hq', label: 'Paperclip HQ', icon: 'hq', group: 'Office', keywords: 'paperclip hq company lobby org chart floors agents budget heartbeats routines supervise runtime install', run: function () { setDlg({ name: 'hq' }); } });
    // Ctrl+K searches Paperclip (#214): an employee, floor, task, goal, approval or routine opens the HQ at it.
    window.OfficeVocab.hq.searchItems(snap && snap.hq).forEach(function (x) { actions.push({ id: 'page-' + x.id, label: x.label, hint: x.hint, icon: x.icon, group: x.group, keywords: x.keywords, run: function () { setDlg({ name: 'hq', focus: x.ref }); } }); });
    list.forEach(function (b) { if (b.key !== shown) actions.push({ id: 'page-b-' + b.key, label: 'Go to ' + b.name, icon: 'building', group: 'Buildings', keywords: 'building repository ' + b.name, run: function () { pick(b.key); } }); });
    // The Reception lists the office's own actions (the dock had them before #92), so a touch screen reaches them with no keyboard.
    var officeActions = actions.filter(function (a) { return ['page-orientation', 'page-open', 'page-needs', 'page-flow', 'page-sessions', 'page-past', 'page-schedules', 'page-hooks', 'page-kinds', 'page-floors', 'page-city', 'page-compact'].indexOf(a.id) >= 0; })
      .concat([{ id: 'page-search', label: 'Search actions', icon: 'search', run: openPalette }]);

    // Room tools and sessions are built when the palette draws, so the rooms of the floor on screen are current.
    function liveActions() {
      var out = [], b = boardRef.current, sn = latestSnap.current, sec = securityRef.current;
      // Permissions: fly to the Security room of the building on screen (its floor first), at its Files screen
      if (sec && mount && cur2.view === 'office' && mount.repo === shown && mount.securityRoom()) {
        out.push({ id: 'page-permissions', label: 'Permissions', icon: 'security', group: 'Office', keywords: 'security room rules ask allow deny agents spend limit',
          run: function () { if (!sec.open('files')) toast({ tone: 'info', title: 'Permissions', text: 'This building shows no Security room yet.' }); } });
      }
      if (b && mount && cur2.view === 'office' && mount.repo === shown) {
        var tools = [['board', 'Board of ', 'plan', 'blackboard overview plan steps'], ['notes', 'Notes of ', 'memory', 'whiteboard notes reminder'],
          ['stats', 'Stats of ', 'cost', 'numbers tokens cost calls'], ['door', 'Agents in ', 'team', 'door add remove agents']];
        b.rooms().forEach(function (id) {
          var rn = (mount.roomInfo(id).place || {}).roomName || 'Room';
          tools.forEach(function (k) { out.push({ id: 'page-room-' + id + '-' + k[0], label: k[1] + rn, icon: k[2], group: 'Rooms', keywords: 'room ' + k[3], run: function () { b.open(id, k[0]); } }); });
        });
      }
      // The desk objects of the building on screen (#90, desk.js ACTIONS): an open desk on each floor, the approval papers, the
      // question notes and the pause keys. Each is the keyboard path of the same click, through the same rules (high risk: Approve,
      // then Confirm).
      if (mount && cur2.view === 'office' && mount.repo === shown && window.OfficeDesk && sn) {
        var dt = mount.deskTargets(sn), dk = deskRef.current;
        dt.empty.forEach(function (e) { var f = mount.floors().filter(function (x) { return x.key === e.floorKey; })[0]; e.name = f ? f.name : e.floorKey; e.wing = f ? f.wingName : ''; });
        var dsess = (sn.sessions || []).filter(function (x) { return x.status !== 'ended' && mount.botName(x.uid); }).map(function (x) { return Object.assign({}, x, { botName: mount.botName(x.uid) }); });
        window.OfficeDesk.pure.paletteActions(dt, dk ? dk.stages() : {}, dsess).forEach(function (a) {
          var icon = a.action === 'desk-start' ? 'add' : a.action === 'paper-decline' ? 'decline' : a.action === 'pause' ? 'pause' : a.action === 'note-answer' ? 'chat' : 'approve';
          out.push({ id: 'page-desk-' + a.id, label: a.label, icon: icon, group: a.action === 'desk-start' ? 'Floors' : 'Needs you', keywords: 'desk paper stamp question note pause agent start role floor ' + (a.ref && a.ref.wing || ''),
            run: function () {
              if (a.action === 'desk-start') return deskStart(a.ref.roomId);
              if (!dk || !dk.act(a.action, a.ref.id || a.ref.uid)) toast({ tone: 'info', title: 'Desk', text: 'That request is not on this floor. Use Needs you to go there.' });
            } });
        });
      }
      ((sn && sn.sessions) || []).filter(function (s) { return s.status !== 'ended'; }).forEach(function (s) {
        var where = ((s.place && s.place.building) || '') + (s.place && s.place.room ? ' · ' + s.place.room : ''), kw = 'session ' + where, nm = sceneName(s);
        // the dock's per-agent actions (#92): Always allow, the model and the permission mode
        var ask = window.OfficeVocab.alwaysOffer(s), skd = kindOf(window.officeAdapter.kinds(), s.provider), steer = s.headless && (!skd || skd.control);
        if (ask) out.push({ id: 'page-s-always-' + s.uid, label: 'Always allow ' + clip(ask.always, 40) + ' for ' + nm, icon: 'approve', group: 'Sessions', hint: where, keywords: kw + ' permission rule approve',
          run: function () { client.answer({ id: ask.id, allow: true, always: true }).then(function () { toast({ tone: 'success', title: s.name, text: 'Allowed from now on: ' + ask.always }); }, function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } });
        if (steer) MODELS.slice(1).forEach(function (mo) { if (mo.value !== s.model) out.push({ id: 'page-s-model-' + mo.value + '-' + s.uid, label: 'Model of ' + nm + ': ' + mo.label, icon: 'bot', group: 'Sessions', hint: where, keywords: kw + ' model lane',
          run: function () { client.control({ uid: s.uid, action: 'model', value: mo.value }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } }); });
        if (steer) MODES.forEach(function (md) { if (md.value && md.value !== s.mode) out.push({ id: 'page-s-mode-' + md.value + '-' + s.uid, label: 'Permissions of ' + nm + ': ' + md.label, icon: 'security', group: 'Sessions', hint: where, keywords: kw + ' permission mode',
          run: function () { client.control({ uid: s.uid, action: 'mode', value: md.value }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } }); });
        out.push({ id: 'page-s-go-' + s.uid, label: 'Go to session ' + nm, icon: 'chevron-right', group: 'Sessions', hint: where, keywords: kw, run: function () { goTo(s); } });
        out.push({ id: 'page-s-term-' + s.uid, label: 'Terminal of ' + nm, icon: 'terminal', group: 'Sessions', hint: where, keywords: kw + ' output', run: function () { openDesk(s.uid, 'terminal'); } });
        out.push(Changes.paletteAction(s, nm, where, kw, changes));
        if (s.headless && (s.status === 'working' || s.status === 'waiting')) out.push({ id: 'page-s-stop-' + s.uid, label: 'Stop turn of ' + nm, icon: 'pause', group: 'Sessions', hint: where, keywords: kw + ' interrupt', run: function () { client.interrupt({ uid: s.uid }).catch(function (x) { toast({ tone: 'error', title: s.name, text: x.message }); }); } });
      });
      return out;
    }
    useEffect(function () { pageActions = function () { return actions.concat(liveActions()); }; return function () { pageActions = []; }; });

    return h(React.Fragment, null,
      h('div', { className: 'view' + (fading ? ' is-fading' : '') }, scene),
      phoneOn ? h(PhoneView, { toast: toast, onHq: function () { setDlg({ name: 'hq' }); }, onManager: function () { setDlg({ name: 'manager' }); }, onGo: function (r) { var x = snap && snap.sessions.filter(function (y) { return y.uid === r.uid; })[0]; if (x) { setPhoneList(false); goTo(x); } },
        onOpenAgent: function (uid) { var x = window.officeAdapter.sessionByUid(uid); if (x) { setPhoneList(false); goTo(x); } } }) : null,
      win.w <= PHONE_MAX && !phoneList ? h('div', { className: 'phone-back' }, h(A.Button, { variant: 'emphasis', icon: 'chevron-right', onClick: function () { blurScene(); setBoard(null); setPhoneList(true); } }, 'Back to the list')) : null,
      !ambient && touring && cur2.view === 'office' ? h(TourCard, { onStep: tourStep, onDone: endTour }) : null,
      d === 'orientation' ? h(OrientationDialog, { info: info.port ? info : null, toast: toast, onSecurity: function () { var sec = securityRef.current; if (!sec || !sec.open('files')) toast({ tone: 'info', title: 'Permissions', text: 'This building shows no Security room yet.' }); }, onTour: startTour, onClose: function () { setOrient(true); close(); } }) : null,
      d === 'reception' ? h(ReceptionDialog, { repo: shown, actions: officeActions, onTour: startTour, onClose: close }) : null,
      d === 'open' ? h(OpenDialog, { shownPath: shownPath, kind: dlg.kind, role: dlg.role, roleName: dlg.roleName, folder: dlg.folder, spendLimit: info.spendLimit, recent: info.recent || [], templates: info.templates || [], onTemplates: refresh, onClose: close }) : null,
      d === 'personas' ? h(PersonasDialog, { toast: toast, folder: shownPath || (info.recent || [])[0] || '', onClose: close }) : null,
      d === 'recap' ? h(RecapDialog, { toast: toast, onClose: close }) : null,
      d === 'trust' ? h(TrustDialog, { toast: toast, onClose: close }) : null,
      d === 'kinds' ? h(KindsDialog, { onOpen: function (kind) { refresh().then(function () { setDlg({ name: 'open', kind: kind }); }); }, onClose: close }) : null,
      d === 'flow' ? h(FlowDialog, { toast: toast, onClose: close }) : null,
      d === 'past' ? h(PastDialog, { onClose: close, onChanges: changes, toast: toast }) : null,
      d === 'schedules' ? h(SchedulesDialog, { recent: info.recent, spendLimit: info.spendLimit, onInfo: setInfo, toast: toast, onClose: close }) : null,
      d === 'changes' ? h(Changes.Dialog, { uid: dlg.uid, name: dlg.label, ended: dlg.ended, toast: toast, onClose: close }) : null,
      d === 'hooks' ? h(HooksDialog, { info: info, snap: snap, onSaved: refresh, toast: toast, onHq: function () { setDlg({ name: 'hq' }); }, onClose: close }) : null,
      d === 'floors' ? h(FloorsDialog, { repo: shown, toast: toast, onClose: close }) : null,
      d === 'room' && mount ? h(RoomDialog, { mount: mount, roomId: dlg.roomId, toast: toast, onClose: close }) : null,
      d === 'ext' ? h(ExtensionsDialog, { uid: dlg.uid, name: dlg.label, toast: toast, onClose: close }) : null,
      // The pinned screens (#89): the desk monitor in focus shows the chat and terminal of its session, the room's wall
      // screen its changes. They mount with the look (hidden while the camera flies) and show once it lands.
      deskUid && hostRef.current ? h(DeskScreen, { key: 'desk-' + deskUid, uid: deskUid, bot: layer.item.name, name: sceneName({ uid: deskUid, name: layer.item.name }), host: hostRef.current, office: officeRef.current,
        shown: layer.shown, tab: deskTab, onTab: setDeskTab, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene,
        onRules: function () { var d2 = window.officeAdapter.sessionByUid(deskUid); if (d2 && d2.place) noteLayer(d2.place.roomId, 'deep'); blurScene(); setTimeout(function () { if (securityRef.current && !securityRef.current.open('files')) toast({ tone: 'info', title: 'Permissions', text: 'This building shows no Security room yet.' }); }, 0); } }) : null,
      pinned && layer.kind === 'changes' && chg && hostRef.current ? h(Changes.Screen, { key: 'chg-' + chg.uid, uid: chg.uid, name: chg.name, ended: chg.ended, host: hostRef.current,
        shown: layer.shown, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene }) : null,
      pinned && layer.kind === 'note' && layer.item && layer.item.data && hostRef.current ? h(NoteScreen, { key: 'note-' + layer.item.id, note: layer.item.data, host: hostRef.current,
        shown: layer.shown, waiting: layer.waiting, onGo: goOldest, toast: toast, onBack: blurScene }) : null,
      // The bezel count of a screen in focus that is not pinned (a board, the notes, the stats, a Security screen).
      layer && !pinned && hostRef.current ? h(Bezel, { host: hostRef.current, shown: layer.shown, count: layer.waiting, onGo: goOldest }) : null,
      board && boardRef.current && board.kind === 'board' ? h(BoardPanel, { data: boardRef.current.dataOf(board.id), sessions: roomAndSel(board.id), onGo: goOldest, toast: toast, onClose: closeBoard }) : null,
      board && boardRef.current && board.kind === 'stats' && mount ? h(StatsPanel, { mount: mount, extra: roomAndSel(board.id, true), onGo: goOldest, toast: toast, roomId: board.id, onClose: closeBoard }) : null,
      board && boardRef.current && board.kind === 'notes' ? h(NotesEditor, { key: board.id, noteKey: noteKey(board.id), text: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).text || '', version: ((snap && snap.notes && snap.notes[noteKey(board.id)]) || {}).v || 0, toast: toast,
        rect: function () { return hostRef.current ? hostRef.current.rect() : null; }, flying: function () { return hostRef.current ? hostRef.current.flying() : false; },
        onClose: function () { if (boardRef.current) boardRef.current.refresh(); blurScene(); } }) : null,
      look && !board && hostRef.current ? h(LookBar, { key: look.key, verb: look.verb, agents: look.item && look.item.roomId && look.kind !== 'security' && mount ? roomAndSel(look.item.roomId) : null, onInspect: goTo, icon: LOOK_ICON[look.kind] || 'zoom-in', toast: toast, layout: secLook,
        onGo: goOldest,
        free: function (el) { return hostRef.current ? hostRef.current.free(sceneCovers(el)) : null; },
        onPlaced: function () { if (hostRef.current) hostRef.current.refit(); },
        onBack: blurScene, onOpen: function () { if (hostRef.current) hostRef.current.open(); } }) : null,
      d === 'sessions' ? h(SessionsDialog, { onClose: close, onGo: goTo }) : null,
      d === 'manager' ? h(ManagerDialog, { toast: toast, onClose: close, onGo: function (x) { goTo(x); }, onHq: function () { setDlg({ name: 'hq' }); } }) : null,
      d === 'hire' ? h(O.Hq.Hire, { toast: toast, onClose: close }) : null,
      d === 'hq' ? h(HqDialog, { snap: snap, focus: dlg.focus, toast: toast, onAttach: function () { show('hooks'); }, onClose: close }) : null,
      d === 'needs' ? h(NeedsDialog, { toast: toast, onClose: close, onManager: function () { setDlg({ name: 'manager' }); }, onHq: function () { setDlg({ name: 'hq' }); }, onGo: function (r) { var s = snap && snap.sessions.filter(function (x) { return x.uid === r.uid; })[0]; if (s) goTo(s); else close(); } }) : null,
      // The one Notifier (the scene has notifier: false). The tab title counts every request of every building, in the
      // city too. Browser alerts for the requests and errors of every building; the DS alert toggle decides, and they
      // show only while the page is hidden. A click goes to the session.
      snap ? h(A.Notifier, { enabled: alertsOn(), count: needs.length, notifications: window.officeAdapter.alerts(snap),
        onClick: function (n) { var s = n.uid ? window.officeAdapter.sessionByUid(n.uid) : null; if (s) goTo(s); } }) : null,
      h('div', { className: 'page-toasts', ref: toastBox },
        h(A.ToastStack, { toasts: toasts, onClose: function (id) { setToasts(function (l) { return window.OfficeToasts.remove(l, id); }); } })));
  }

  ReactDOM.createRoot(document.getElementById('office')).render(h(App));
})();
