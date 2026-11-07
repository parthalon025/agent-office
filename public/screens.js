/* Agent Office for Claude Code x0.2: the pinned desk screens (#184, the Changes pattern of #183).
   One Module for the two pinned screens of a desk (#89, #90): the desk monitor of a session (chat, terminal, timeline) and the
   question note. Its Interface is window.OfficePage.Screens = { Desk, Note }. panels.js gives it the pinned-screen helpers
   (Bezel, usePinBox, usePinFocus, putBox); office.js keeps the page state and the flight to the screen. Loads after panels.js. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Bezel = O.Bezel, client = O.client, exportSession = O.exportSession, modelWord = O.modelWord, putBox = O.putBox,
      statusOf = O.statusOf, useKinds = O.useKinds, usePinBox = O.usePinBox, usePinFocus = O.usePinFocus, useSnapshot = O.useSnapshot;

  // The chat of the bot at the desk: the DS chat messages (office.chatOf, the same mirror as the HUD chat) and the DS composer.
  var CHAT_QUICK = [['Status', 'What is your status?', 'info'], ['Summarize', 'Summarize your work today.', 'chat']];
  function ChatTab(p) {
    var ms = useState(function () { return p.office && p.office.chatOf ? p.office.chatOf(p.bot) : []; }), msgs = ms[0], setMsgs = ms[1];
    var log = React.useRef(null), stick = React.useRef(true);
    useEffect(function () {
      function read() {
        var l = p.office && p.office.chatOf ? p.office.chatOf(p.bot) : [];
        setMsgs(function (o) { return o.length === l.length && o[o.length - 1] === l[l.length - 1] ? o : l; });
      }
      read();
      var iv = setInterval(read, 400);
      return function () { clearInterval(iv); };
    }, [p.office, p.bot]);
    useEffect(function () { var v = log.current; if (v && stick.current) v.scrollTop = v.scrollHeight; }, [msgs.length]);
    function onScroll() { var v = log.current; if (v) stick.current = v.scrollHeight - v.scrollTop - v.clientHeight < 24; }
    function act(t) { var o = p.office; if (!o) return; if (t === 'approve') o.approve(p.bot); else if (t === 'decline') o.decline(p.bot); else o.send({ type: t, bot: p.bot }); }
    function send(t, att) { if (p.office) { stick.current = true; p.office.message(p.bot, t, att); } }
    return h('div', { className: 'pin-chat' },
      h('div', { className: 'pin-log', ref: log, onScroll: onScroll, role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', tabIndex: 0 },
        msgs.length ? msgs.map(function (m, i) { return h(A.ChatMessage, { key: i, message: m, onAction: act }); })
          : h(A.EmptyState, { compact: true, icon: 'chat', title: 'No messages yet', text: 'Send a message to ' + p.name + '. Try: what is your status?' })),
      h('div', { className: 'pin-input' },
        h('div', { className: 'pin-chips' }, CHAT_QUICK.map(function (q) { return h(A.Button, { key: q[0], variant: 'quiet', icon: q[2], onClick: function () { send(q[1]); } }, q[0]); })),
        h(A.Composer, { id: 'pin-chat-input', placeholder: 'Message ' + p.name, label: 'Message ' + p.name, onSend: send, attach: true })));
  }

  // The desk monitor of one session, pinned (#89): its chat, its terminal and the timeline of its tool calls, Export, Stop turn
  // and Back. The requests are on the desk (the paper and the note, desk.js); the bezel count in the head goes to the oldest one.
  // On a small screen the head takes one row (the bezel shows its icon and count, Stop turn and Export their icon).
  // The context of a Paperclip run (#206): why it woke, fresh or resumed (and why), the instructions and skills, the context in use.
  // Rows come from OfficeVocab.hq.desk, which reads what the run carried; no row for a session that is not such a run.
  function RunContext(p) {
    var rows = window.OfficeVocab.hq.desk(p.s);
    if (!rows.length) return null;
    return h('details', { className: 'desk-run' },
      h('summary', null, 'Run context'),
      h('ul', { className: 'stats-list', 'aria-label': 'Run context of ' + p.s.name }, rows.map(function (r) { return h('li', { key: r[0] }, h('span', null, r[0]), h('b', null, r[1])); })));
  }
  var DESK_TABS = [{ id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'terminal', label: 'Terminal', icon: 'terminal' }, { id: 'timeline', label: 'Timeline', icon: 'trace' }];
  // A session that is a run of the office adapter (#200) has a fourth tab: the transcript Paperclip reads (#211).
  var RUN_TAB = { id: 'run', label: 'Run', icon: 'plan' };
  function DeskScreen(p) {
    var snap = useSnapshot(), kinds = useKinds();
    var s = snap ? snap.sessions.filter(function (x) { return x.uid === p.uid; })[0] : null;
    var ref = React.useRef(null);
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && (el.querySelector('#pin-chat-input, .term-field') || el.querySelector('.ao-tab[aria-selected="true"]')); });
    var working = s && (s.status === 'working' || s.status === 'waiting');
    function stop() { client.interrupt({ uid: s.uid }).catch(function (x) { p.toast({ tone: 'error', title: s.name, text: x.message }); }); }
    var tab = p.tab || 'chat';
    // small: the button shows its icon, and its name is its label (and its tooltip)
    function act(icon, text, title, onClick) { return h(A.Button, { variant: 'quiet', icon: icon, label: small ? text : null, title: small ? (title || text) : title, onClick: onClick }, small ? null : text); }
    return h('section', { ref: ref, className: 'pin pin-desk' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Desk screen of ' + p.name },
      h('div', { className: 'pin-head' },
        h(A.StatusDot, { status: s ? statusOf(s) : 'resting' }),
        h('b', { className: 'pin-name' }, p.name),   // the scene's name of the bot (unique in the building), as on its desk
        h('span', { className: 'pin-sub mono' }, s ? window.officeAdapter.kindWord(s) + ' · ' + modelWord(kinds.list, s) : ''),
        h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
        s && s.headless && working ? act('pause', 'Stop turn', null, stop) : null,
        s ? act('copy', 'Export', 'Save this session as a Markdown file', function () { exportSession(s.uid, p.toast); }) : null,
        p.onRules ? act('security', 'Rules', 'Open the Security room: the rules behind this agent', p.onRules) : null,
        h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
      s ? h(RunContext, { s: s }) : null,
      h(A.Tabs, { label: 'Desk screen', tabs: s && s.paperclipRun ? DESK_TABS.concat([RUN_TAB]) : DESK_TABS, value: tab === 'run' && !(s && s.paperclipRun) ? 'chat' : tab, onChange: p.onTab, render: function (id) {
        if (id === 'run') return h(RunTab, { s: s });
        if (id === 'chat') return h(ChatTab, { office: p.office, bot: p.bot, name: p.name });
        return h(TermTab, { s: s, name: p.name, toast: p.toast, timeline: id === 'timeline' });
      } }));
  }

  // The question note of a desk, pinned (#90): the question and a text field over the note in the scene. The answer goes to the
  // agent as its next message (the server gives a pending question the next message, the message command).
  function NoteScreen(p) {
    var ref = React.useRef(null), tx = useState(''), text = tx[0], setText = tx[1], bz = useState(false), busy = bz[0], setBusy = bz[1];
    var small = usePinBox(p.host, ref, putBox);
    usePinFocus(p.shown, function () { var el = ref.current; return el && el.querySelector('#pin-note-input'); });
    function send(t) {
      var v = String(t == null ? text : t).trim();
      if (!v || busy) return;
      setBusy(true);
      client.message({ uid: p.note.uid, text: v }).then(function () { setBusy(false); setText(''); p.onBack(); }, function (x) { setBusy(false); p.toast({ tone: 'error', title: p.note.bot, text: x.message }); });
    }
    return h('section', { ref: ref, className: 'pin pin-note' + (small ? ' is-small' : ''), hidden: !p.shown, 'aria-label': 'Question from ' + p.note.bot },
      h('div', { className: 'pin-head' },
        h('b', { className: 'pin-name' }, p.note.bot + ' asks'),
        h(Bezel, { inline: true, count: p.waiting, onGo: p.onGo, compact: small }),
        h(A.Button, { variant: 'quiet', icon: 'chevron-right', className: 'btn-back', onClick: p.onBack }, 'Back')),
      h('div', { className: 'pin-body note-body', tabIndex: -1 },
        h('p', { className: 'note-q' }, p.note.text),
        h('div', { className: 'note-field' }, h(A.Composer, { id: 'pin-note-input', placeholder: 'Type your answer', label: 'Answer to ' + p.note.bot, onSend: send })),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { send('Yes.'); } }, 'Answer yes'),
          h(A.Button, { variant: 'quiet', disabled: busy, onClick: function () { send('No.'); } }, 'Answer no'))));
  }

  // The transcript of a Paperclip run on the desk (#211): the log the office hands to Paperclip, read from the server (the snapshot does not
  // carry it). It reads again when the session changes, and shows what the plugin shows: replies, calls, failures, requests that wait.
  function RunTab(p) {
    var s = p.s, st = useState(null), t = st[0], setT = st[1], er = useState(''), err = er[0], setErr = er[1];
    var vw = React.useRef(null), sig = s ? [s.status, s.turns, (s.calls || []).length, (s.replies || []).length, (s.pending || []).length, s.endedAt].join() : '';
    useEffect(function () {
      if (!s) return undefined;
      var gone = false;
      client.get('paperclipTranscript', { uid: s.uid }).then(function (r) { if (!gone) { setT(r); setErr(''); } }, function (x) { if (!gone) setErr(x.message); });
      return function () { gone = true; };
    }, [s && s.uid, sig]);
    useEffect(function () { var v = vw.current; if (v) v.scrollTop = v.scrollHeight; }, [t]);
    var lines = (t && t.lines) || [];
    return h('div', { className: 'pin-term' },
      err ? h('p', { className: 'term-note', role: 'alert' }, err) : null,
      h('div', { className: 'term-view', ref: vw, role: 'log', 'aria-live': 'off', 'aria-label': 'Run transcript', tabIndex: 0 },
        lines.length ? lines.map(function (l, i) { return h('div', { key: i, className: 'term-line tone-' + (l.stream === 'stderr' ? 'err' : /^\[agent-office\]/.test(l.text) ? 'muted' : 'prompt') }, l.text || ' '); })
          : h('div', { className: 'term-line tone-muted' }, t ? 'The run has no log yet.' : 'Loading the transcript.')),
      h('p', { className: 'term-note' }, t && t.done ? 'This run ended. Paperclip has this log.' : 'Paperclip reads this log while the run goes on.'));
  }

  // ---------- one session as a full terminal (the Terminal and Timeline tabs of the desk screen) ----------
  function TermTab(p) {
    var s = p.s;
    var vw = React.useRef(null), stick = React.useRef(true), probe = React.useRef(null);
    var cl = useState(60), cols = cl[0], setCols = cl[1];
    var tx = useState(''), text = tx[0], setText = tx[1];
    var bz = useState(false), busy = bz[0], setBusy = bz[1];
    useEffect(function () {
      function measure() {
        var v = vw.current, pr = probe.current;
        if (!v || !pr) return;
        var pw = pr.getBoundingClientRect().width;
        if (!pw) return;
        var cs = getComputedStyle(v), cw = pw / 10, inner = v.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        if (cw > 0 && inner > 0) setCols(function (c) { var n = Math.max(20, Math.floor(inner / cw)); return n === c ? c : n; });
      }
      measure();
      var ro = window.ResizeObserver ? new ResizeObserver(measure) : null;
      if (ro && vw.current) ro.observe(vw.current);
      window.addEventListener('resize', measure);
      // a theme change or a font swap changes the character width but not the box
      var mo = new MutationObserver(measure);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      var fonts = document.fonts;
      if (fonts && fonts.addEventListener) fonts.addEventListener('loadingdone', measure);
      return function () {
        if (ro) ro.disconnect(); mo.disconnect();
        window.removeEventListener('resize', measure);
        if (fonts && fonts.removeEventListener) fonts.removeEventListener('loadingdone', measure);
      };
    }, []);
    // The Timeline tab lists the tool calls with their times (#72); Export (in the head) saves the whole session as Markdown.
    var showTimeline = !!p.timeline;
    var OT = window.OfficeTerminal;
    var rows = OT ? (showTimeline ? OT.timeline(s, cols) : OT.lines(s, cols)) : [{ text: 'The terminal view is not loaded.', tone: 'muted' }];
    if (!showTimeline && s && s.headless && rows.length && rows[rows.length - 1].text === '> ') rows = rows.slice(0, -1);
    useEffect(function () { var v = vw.current; if (v && stick.current) v.scrollTop = v.scrollHeight; });
    function onScroll() { var v = vw.current; if (v) stick.current = v.scrollHeight - v.scrollTop - v.clientHeight < 24; }
    function send() {
      var t = text.trim();
      if (!t || !s || busy) return;
      setBusy(true);
      client.message({ uid: s.uid, text: t }).then(function () { setBusy(false); setText(''); stick.current = true; }, function (x) { setBusy(false); p.toast({ tone: 'error', title: s.name, text: x.message }); });
    }
    var ended = !s || s.status === 'ended';
    return h('div', { className: 'pin-term' },
      h('div', { className: 'term-view', ref: vw, onScroll: onScroll, role: 'log', 'aria-live': 'off', 'aria-label': showTimeline ? 'Timeline' : 'Terminal', tabIndex: 0 },
        h('span', { className: 'term-probe', ref: probe, 'aria-hidden': 'true' }, 'MMMMMMMMMM'),
        rows.map(function (r, i) { return h('div', { key: i, className: 'term-line tone-' + r.tone + (r.ask ? ' is-ask' : '') }, r.text || '\u00a0'); })),
      showTimeline ? null : s && s.headless && !ended
        ? h('div', { className: 'term-input pin-input' },
            h('span', { className: 'term-caret mono', 'aria-hidden': 'true' }, '>'),
            h('input', { className: 'term-field', type: 'text', value: text, placeholder: 'Message ' + s.name, 'aria-label': 'Message ' + s.name, autoComplete: 'off', spellCheck: false,
              onChange: function (e) { setText(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } } }))
        : s && !s.headless && !ended ? h('p', { className: 'term-note' }, 'This session runs in its own terminal window. Type there, or use the Chat tab.') : null);
  }

  O.Screens = { Desk: DeskScreen, Note: NoteScreen };
})();
