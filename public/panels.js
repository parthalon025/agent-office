/* Agent Office for Claude Code x0.2: the panels and pinned screens (split out of office.js, #1 story 26).
   The room board, stats and notes panels, the Look card and bar, and the pinned screens laid over a screen in focus (#89): the
   desk (chat, terminal, timeline), the changes of a room and the question note. Plain functions over the page core and the
   dialogs (window.OfficePage); they put their names on it for office.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var F = O.F, ago = O.ago, client = O.client,
      clip = O.clip, exportSession = O.exportSession, modelWord = O.modelWord,
      plural = O.plural, statusOf = O.statusOf, useKinds = O.useKinds,
      useSnapshot = O.useSnapshot;

  // ---------- the room board, read up close ----------
  function BoardPanel(p) {
    var d = p.data;
    if (!d) return null;
    var word = window.OfficeVocab.toolShort;
    var call = function (c, kind) { return h(A.ToolCall, { key: c.id, call: { id: c.id, tool: word(c.name), kind: kind || 'api', ok: c.ok === null ? undefined : c.ok, ms: c.ms == null ? undefined : c.ms, args: c.detail ? { target: c.detail } : undefined, summary: c.err || (c.who ? 'by ' + c.who : undefined) } }); };
    return h('aside', { className: 'board-panel', 'aria-label': 'Board of ' + d.room },
      h(A.Panel, { title: d.room + (d.branch ? ' · ' + d.branch : ''), count: plural(d.sessions.length, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h(NeedsButton, { onGo: p.onGo }),
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
          d.pin ? h('p', { className: 'note board-pin' }, 'Note from ' + d.pin.by + ': ' + d.pin.text) : null,
          d.todos.length ? h(A.PlanCard, { title: 'To do', goal: d.goal ? clip(d.goal, 120) : undefined, steps: d.todos.map(function (t, i) { return { id: 't' + i, text: t.text, status: window.OfficeVocab.todoStatus(t) }; }) })
            : h(A.EmptyState, { icon: 'plan', compact: true, title: 'No to-do list', text: 'A session shows its plan here when it writes one.' }),
          h('h3', { className: 'ext-h' }, 'Browser', h('span', { className: 'ext-n' }, d.browser.length)),
          d.browser.length ? h('div', { className: 'board-calls' }, d.browser.slice().reverse().map(function (c) { return call(c, 'browser'); }))
            : h('p', { className: 'note' }, 'No browser steps yet. Playwright clicks, page loads and key presses show here.'),
          h('h3', { className: 'ext-h' }, 'Last steps', h('span', { className: 'ext-n' }, d.recent.length)),
          d.recent.length ? h('div', { className: 'board-calls' }, d.recent.slice().reverse().map(function (c) { return call(c, window.OfficeVocab.toolKind(c.name)); }))
            : h('p', { className: 'note' }, 'No tool calls yet.'),
          h('h3', { className: 'ext-h' }, 'Repository', d.tree && !d.tree.note ? h('span', { className: 'ext-n' }, plural(d.tree.total, 'file', 'files')) : null),
          d.tree && d.tree.note ? h('p', { className: 'note' }, d.tree.note + '.')   // board.js: a room outside git, or no file list
          : d.tree ? h('ul', { className: 'board-tree mono' }, d.tree.entries.map(function (e) {
            var hot = d.touched[e.name];
            return h('li', { key: e.name, className: hot ? 'is-hot' : '' }, h(A.Icon, { name: e.dir ? 'floor' : 'knowledge', size: 13 }), h('span', null, e.name + (e.dir ? '/' : '')), h('span', { className: 'ext-sub' }, (e.dir ? plural(e.files, 'file', 'files') : '') + (hot ? ' · ' + hot + ' touched' : '')));
          })) : h(A.Skeleton, { lines: 3, label: 'Loading' }))));
  }

  // The room's numbers, read beside the room when the camera faces the stats display.
  function StatsPanel(p) {
    var snap = useSnapshot();
    var info = p.mount.roomInfo(p.roomId, snap || undefined);
    var v = p.mount.figures(p.roomId, snap || undefined);
    var row = function (k, val) { return h('li', { key: k }, h('span', null, k), h('b', { className: 'mono' }, val)); };
    return h('aside', { className: 'board-panel', 'aria-label': 'Stats of ' + ((info.place && info.place.roomName) || 'this room') },
      h(A.Panel, { title: ((info.place && info.place.roomName) || 'Room') + ' · stats', count: plural(v.sessions, 'session', 'sessions') },
        h('div', { className: 'board-b' },
          h(NeedsButton, { onGo: p.onGo }),
          h('div', { className: 'inline-actions' }, h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onClose }, 'Back to the room'), h('span', { className: 'note' }, 'Esc also goes back.')),
          h('ul', { className: 'stats-list' },
            row('Working', String(v.working)), row('Needs you', String(v.waiting)), row('Tool calls', String(v.toolCalls)),
            row('Tokens', v.tokens ? F.tokens(v.tokens) : 'none reported'), row('Cost', F.cost(v.cost, v.unknown)), row('To do done', v.todosDone + ' of ' + v.todosTotal),
            row('Last event', v.lastEvent ? ago(v.lastEvent) : 'none')))));
  }

  // Where a caret at pos in text a goes when the text becomes b: the same place in the part both share.
  // Text kept before the caret keeps it in place; text added before it moves it on; a caret inside a changed part
  // goes to the end of that part.
  function mapCaret(a, b, pos) {
    var p = 0, s = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    if (pos <= p) return pos;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return pos >= a.length - s ? b.length - (a.length - pos) : b.length - s;
  }

  // The notes board, written on in place: a text box laid exactly over the board on screen.
  function NotesEditor(p) {
    var tx = useState(p.text || ''), text = tx[0], setText = tx[1];
    var rc = useState(null), rect = rc[0], setRect = rc[1];
    var sv = useState('saved'), state = sv[0], setState = sv[1];
    var ref = React.useRef(null), timer = React.useRef(0);
    var base = React.useRef(p.version || 0), latest = React.useRef(p.text || ''), fromSent = React.useRef(false);
    var edits = React.useRef(0), inflight = React.useRef(false), queued = React.useRef(null), caret = React.useRef(null);
    // Text from outside (an agent's line, a merged save) replaces the box's value. The browser then puts the caret
    // at the end, so the user's next keys would land after the agent's line. Keep the caret where the user was.
    function showText(next) {
      var el = ref.current;
      if (el && document.activeElement === el && el.value !== next) caret.current = [mapCaret(el.value, next, el.selectionStart), mapCaret(el.value, next, el.selectionEnd)];
      latest.current = next; setText(next);
    }
    React.useLayoutEffect(function () {
      var c = caret.current, el = ref.current;
      caret.current = null;
      if (c && el && document.activeElement === el) el.setSelectionRange(c[0], c[1]);
    }, [text]);
    useEffect(function () {
      var raf = 0;
      function follow() { var r = p.rect(); if (r) setRect(function (o) { return o && Math.abs(o.left - r.left) < 0.5 && Math.abs(o.top - r.top) < 0.5 && Math.abs(o.width - r.width) < 0.5 ? o : r; }); raf = requestAnimationFrame(follow); }
      follow();
      return function () { cancelAnimationFrame(raf); };
    }, []);
    // Closing the editor sends the last edit at once, not drops it.
    useEffect(function () { return function () { if (timer.current) { clearTimeout(timer.current); timer.current = 0; save(latest.current); } }; }, []);
    // The box takes focus when it shows, and again when the camera lands, so the keys typed right after the flight go to the notes.
    // A dialog or the palette on top keeps its focus.
    useEffect(function () {
      var raf = 0, shown = false, landed = false;
      function tick() {
        raf = requestAnimationFrame(tick);
        var el = ref.current;
        if (!el || (window.OfficeBoard && window.OfficeBoard.layerOpen())) return;   // a layer keeps its focus
        if (!shown) { shown = true; el.focus({ preventScroll: true }); }
        if (!landed && !p.flying()) { landed = true; if (document.activeElement !== el) el.focus({ preventScroll: true }); }
      }
      tick();
      return function () { cancelAnimationFrame(raf); };
    }, []);
    // An idle editor takes a change that came from outside (an agent added a line).
    useEffect(function () {
      var ver = p.version || 0;
      if (state !== 'saved' || ver <= base.current) return;   // a save is pending, or this is our own save or an older snapshot
      base.current = ver; fromSent.current = false;
      if ((p.text || '') !== latest.current) showText(p.text || '');
    }, [p.version, state]);
    // The server keeps the merge rules (notes.mjs). The editor sends its text and the version it started from.
    function done() {
      inflight.current = false;
      var q = queued.current; queued.current = null;
      if (q !== null) save(latest.current);
    }
    function save(v) {
      if (inflight.current) { queued.current = v; return; }   // one save at a time
      inflight.current = true;
      var mark = edits.current;
      latest.current = v;
      var wasSent = fromSent.current;
      return client.notesSave({ key: p.noteKey, text: v, base: base.current, sent: wasSent }).then(function (res) {
        var typedMore = edits.current !== mark;
        if (res.merged && res.text !== v) {
          // An agent changed the notes. The new base is the merged version. When the user typed on, the server keeps the
          // text we sent as the merge base of the next save (sent), so nothing is merged twice.
          base.current = res.version;
          if (typedMore) fromSent.current = true;
          else { fromSent.current = false; showText(res.text); }
          if (!wasSent) p.toast({ tone: 'info', title: 'Notes', text: 'An agent changed the notes. Your text is merged.' });
        } else { base.current = res.version; fromSent.current = false; }
        if (!typedMore) setState('saved');
        done();
      }, function (x) {
        setState('error'); p.toast({ tone: 'error', title: 'Notes', text: x.message });
        done();
      });
    }
    function change(v) {
      setText(v); setState('saving'); latest.current = v; edits.current++;
      clearTimeout(timer.current);
      timer.current = setTimeout(function () { timer.current = 0; save(v); }, 500);
    }
    if (!rect || rect.width < 40) return null;
    var fs = Math.max(16, rect.height / 14);   // never under 16 px
    return h('div', { className: 'notes-edit', style: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } },
      h('textarea', { ref: ref, className: 'notes-text', 'aria-label': 'Notes for this room', value: text, maxLength: 4000, placeholder: 'Write a reminder for this room. Agents in this room can read it.', style: { fontSize: fs + 'px' }, onChange: function (e) { change(e.target.value); },
        onKeyDown: function (e) { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } } }),
      h('div', { className: 'notes-bar' },
        h('span', { className: 'notes-state', role: 'status' }, state === 'saving' ? 'Saving' : state === 'error' ? 'Not saved' : 'Saved. Agents in this room can read the notes.'),
        h(A.Button, { variant: 'quiet', icon: 'approve', onClick: p.onClose }, 'Done')));
  }

  // ---------- requests: the paper and the note on the desk (#90, desk.js) ----------
  // A request is answered on the desk, in the scene: a permission request is a paper with Approve and Decline stamps, a question is a
  // note with a text field. The panels and the look bar carry one button, which goes to the oldest request.
  // The count is the one queue's (every building, #146), the same number the button goes to the oldest of.
  function useQueueCount() { var snap = useSnapshot(); return snap ? window.officeAdapter.queue(snap).count : 0; }
  function NeedsButton(p) {
    var count = useQueueCount();
    if (!(count > 0)) return null;
    return h('div', { className: 'needs-go' }, h(A.Button, { variant: 'emphasis', icon: 'waiting', onClick: p.onGo }, 'Needs you · ' + count + '. Go to the request'));
  }

  // ---------- a screen in the room, looked at up close (scene-host.js focus) ----------
  // The page's boxes over the 3D scene. The scene host frames a screen in the part of the view they leave free.
  var COVERS = '.ao-hud-top, .ao-hud-left, .ao-hud-right, .ao-hud-zoom, .ao-hud-use, .ao-hud-syl, .ao-hud-scrub, .ao-hud-cast, .ao-hud-log, .tour-card, .board-panel, .look-bar';
  function sceneCovers(skip) {
    return [].slice.call(document.querySelectorAll(COVERS)).filter(function (el) {
      if (el === skip) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    }).map(function (el) { return el.getBoundingClientRect(); });
  }
  // The remembered layer per place (ADR 0006, #145): a count per layer, kept in this browser. A place used at Inspect opens
  // there on the first tap. A place with no history opens at Glance and shows its Look card first.
  var layerMem = (function () { try { return window.OfficeVocab.layers.parse(localStorage.getItem('ao-layers')); } catch (x) { return {}; } })();
  function noteLayer(place, layer) {
    if (!place) return;
    layerMem = window.OfficeVocab.layers.remember(layerMem, place, layer);
    try { localStorage.setItem('ao-layers', JSON.stringify(layerMem)); } catch (x) { /* private window */ }
  }
  // The Look layer of a room: one sentence, steps and cost for the room, then one row per agent. A row opens that agent (Inspect).
  function LookCard(p) {
    var L = window.OfficeVocab.layers, r = L.lookRoom(p.agents), list = p.agents || [];
    if (!list.length) return null;
    return h('div', { className: 'look-card' },
      h('p', { className: 'look-intent' }, r.intent),
      h('p', { className: 'look-facts mono' }, [list.length + (list.length === 1 ? ' agent' : ' agents'), r.progress, r.cost].filter(Boolean).join(' · ')),
      list.length > 1 ? h('ul', { className: 'look-agents' }, list.map(function (s) {
        var l = L.look(s);
        return h('li', { key: s.uid }, h('button', { type: 'button', className: 'look-agent', onClick: function () { p.onInspect(s); } },
          h('b', null, s.name || 'Agent'), h('span', null, [clip(l.intent, 60), l.progress, l.cost].filter(Boolean).join(' · '))));
      })) : null);
  }
  var LOOK_ICON = { board: 'plan', notes: 'memory', stats: 'cost', terminal: 'terminal', desk: 'add', lobby: 'building' };
  // While the camera looks at a screen: back to the room, or the screen's second step (the same as a second click).
  // It sits at the bottom of the free part of the view, and the screen is framed above it.
  // The Needs you button in the bar (the one queue's count) shows while the page hides the HUD columns for the look (a Security screen
  // at 820 px and below, review M6), so an approval never hides. The bar is placed again when they change.
  function LookBar(p) {
    var ref = React.useRef(null);
    var ps = useState(null), pos = ps[0], setPos = ps[1];
    var askKey = String(useQueueCount());
    var placeRef = React.useRef(null);
    React.useLayoutEffect(function () {
      function place() {
        var el = ref.current, f = el && p.free(el);
        if (!f) return;
        var n = { left: Math.round(Math.max(f.left, (f.left + f.right - el.offsetWidth) / 2)), top: Math.round(f.bottom - el.offsetHeight) };
        setPos(function (o) { return o && o.left === n.left && o.top === n.top ? o : n; });
      }
      placeRef.current = place;
      place();
      window.addEventListener('resize', place);
      return function () { window.removeEventListener('resize', place); };
    }, [askKey]);
    // layout: the page hides HUD columns for this look (sec-look) in a layout effect of the same commit, which runs after this
    // bar's own. A passive effect runs after every layout effect, so the bar is placed again in the view the screen gets.
    useEffect(function () { if (placeRef.current) placeRef.current(); }, [p.layout]);
    useEffect(function () { if (pos) p.onPlaced(); }, [pos]);
    // A screen with no second step (a Security room screen: its cells take the clicks) has the Back button only.
    return h('div', { ref: ref, className: 'look-bar', role: 'group', 'aria-label': 'Screen in view', style: pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' } },
      p.agents ? h(LookCard, { agents: p.agents, onInspect: p.onInspect }) : null,
      p.layout ? h(NeedsButton, { onGo: p.onGo }) : null,   // only while the page hides the HUD columns (a Security screen at 820 px and below)
      h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back to the room'),
      p.verb ? h(A.Button, { variant: 'quiet', icon: p.icon, onClick: p.onOpen }, p.verb) : null);
  }

  // ---------- pinned screens (#89): a real DOM layer exactly over the screen in focus ----------
  // The scene host gives the screen's box (host.layer, host.onLayer) every frame it moves, and hides the layer while the
  // camera flies. The page puts the box on its element with setProperty, never a style attribute (the CSP), and renders
  // again only when the screen or its state changes, not on every move.
  var WANT_MS = 5000;   // a wait for a screen to settle (a flight, another building): a deadline in time, not a count of frames
  function px(v) { return Math.round(v * 10) / 10 + 'px'; }
  function putBox(el, r) {
    el.style.setProperty('--pin-x', px(r.left)); el.style.setProperty('--pin-y', px(r.top));
    el.style.setProperty('--pin-w', px(r.width)); el.style.setProperty('--pin-h', px(r.height));
  }
  // A small screen (a phone, a desk monitor seen from afar) gets the compact layout. It is React state, not a class set
  // by hand: a render that changes className would drop a class set from outside.
  function smallBox(r) { return r.width < 520 || r.height < 300; }
  function usePinBox(host, ref, put) {
    var sm = useState(false), small = sm[0], setSmall = sm[1];
    React.useLayoutEffect(function () {
      if (!host) return undefined;
      function at(l) { var el = ref.current; if (el && l && l.rect) { put(el, l.rect); setSmall(smallBox(l.rect)); } }
      at(host.layer());
      return host.onLayer(at);
    }, [host]);
    return small;
  }
  // The count of waiting requests on the bezel of the screen in focus. One tap goes to the oldest request (the page decides
  // where that is). inline: in the head of a pinned screen; else on the top right corner of the screen's frame.
  // compact (a small pinned screen): the icon and the count, with the whole name as the label, so the head keeps one row.
  function Bezel(p) {
    var ref = React.useRef(null);
    // the corner of the screen, kept inside the free part of the view (host.free), compact on a small screen
    var small = usePinBox(p.inline ? null : p.host, ref, function (el, r) {
      var b = window.OfficeSceneHost.pure.bezelAt(r, p.host.free(), 18);
      el.style.setProperty('--pin-x', px(b.x)); el.style.setProperty('--pin-y', px(b.y));
    });
    if (!(p.count > 0)) return null;
    var compact = p.compact || (!p.inline && small);
    return h('div', { ref: ref, className: 'bezel' + (p.inline ? ' is-inline' : ''), hidden: !p.inline && !p.shown },
      h(A.Button, { variant: 'emphasis', icon: 'waiting', label: compact ? 'Needs you · ' + p.count + '. Go to the oldest request' : null, title: 'Go to the oldest request', onClick: p.onGo }, compact ? String(p.count) : 'Needs you · ' + p.count));
  }
  // Focus moves into a pinned screen when it shows, and back to where it was when it goes (the DS Definition of done).
  function usePinFocus(shown, find) {
    var opener = React.useRef(null), entered = React.useRef(false);
    useEffect(function () {
      opener.current = document.activeElement;
      return function () { var o = opener.current; if (o && o.isConnected && o.focus) o.focus({ preventScroll: true }); };
    }, []);
    useEffect(function () {
      if (!shown || entered.current || (window.OfficeBoard && window.OfficeBoard.layerOpen())) return;
      var el = find();
      if (el && el.focus) { entered.current = true; el.focus({ preventScroll: true }); }
    });
  }

  Object.assign(O, { Bezel: Bezel, BoardPanel: BoardPanel,
      LOOK_ICON: LOOK_ICON, LookBar: LookBar, NotesEditor: NotesEditor, StatsPanel: StatsPanel,
      WANT_MS: WANT_MS, putBox: putBox, usePinBox: usePinBox, usePinFocus: usePinFocus, noteLayer: noteLayer, sceneCovers: sceneCovers, layerMemory: function () { return layerMem; } });
})();
