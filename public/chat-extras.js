/* Page extras for the Agent Office DS (x0.1):
   0. Theme: mirrors the office's theme (Day, Night, Sublevel or Fluent) to the page, so the control strip and dialogs match.
   1. Resize: drag the left edge, bottom edge or bottom-left corner of the chat. Arrow keys work on a focused grip,
      double-click resets. The size is remembered in this browser.
   2. Slash commands: type "/" in the chat box to pick one of the session's commands or skills.
      Only sessions that run inside the office report their commands. */
(function () {
  var KEY = 'office-chat-size';

  // ---------- resize ----------
  var size = { w: null, b: null };
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function chatEl() { return document.querySelector('.ao-hud-chat'); }
  function apply() {
    var chat = chatEl();
    if (!chat) return;
    chat.style.width = size.w == null ? '' : size.w + 'px';
    chat.style.bottom = size.b == null ? '' : size.b + 'px';
  }
  function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(size)); } catch (e) { /* private mode */ }
  }
  function setW(w) { size.w = clamp(w, 300, Math.min(900, window.innerWidth - 380)); apply(); }
  function setB(b) { size.b = clamp(b, 12, Math.max(12, window.innerHeight - 280)); apply(); }
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof saved.w === 'number') size.w = saved.w;
    if (typeof saved.b === 'number') size.b = saved.b;
  } catch (e) { /* ignore */ }

  var GRIPS = [
    { kind: 'l', label: 'Resize chat width', orient: 'vertical' },
    { kind: 'b', label: 'Resize chat height', orient: 'horizontal' },
    { kind: 'bl', label: 'Resize chat width and height', orient: 'vertical' }
  ];
  function addGrips(chat) {
    GRIPS.forEach(function (g) {
      var el = document.createElement('div');
      el.className = 'ao-grip ao-grip-' + g.kind;
      el.setAttribute('role', 'separator');
      el.setAttribute('aria-orientation', g.orient);
      el.setAttribute('aria-label', g.label);
      el.tabIndex = 0;
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        var r = chat.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, w0 = r.width, b0 = window.innerHeight - r.bottom;
        function move(ev) {
          if (g.kind.indexOf('l') >= 0) setW(w0 + (sx - ev.clientX));
          if (g.kind.indexOf('b') >= 0) setB(b0 - (ev.clientY - sy));
        }
        function up() { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); remember(); }
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
      el.addEventListener('keydown', function (e) {
        var step = e.shiftKey ? 48 : 16, r = chat.getBoundingClientRect(), used = false;
        if (g.kind.indexOf('l') >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { setW(r.width + (e.key === 'ArrowLeft' ? step : -step)); used = true; }
        if (g.kind.indexOf('b') >= 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { setB(window.innerHeight - r.bottom + (e.key === 'ArrowUp' ? step : -step)); used = true; }
        if (used) { e.preventDefault(); remember(); }
      });
      el.addEventListener('dblclick', function () { size.w = null; size.b = null; apply(); remember(); });
      chat.appendChild(el);
    });
  }

  // ---------- slash commands ----------
  var pop = null, items = [], index = 0, field = null;
  function hide() { if (pop) { pop.remove(); pop = null; } items = []; field = null; }
  function setNative(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function accept(i) {
    var pick = items[i];
    if (!pick || !field) return;
    var input = field;
    hide();
    setNative(input, '/' + pick.name + ' ');
    input.focus();
  }
  function paint() {
    Array.prototype.forEach.call(pop.children, function (c, i) { c.setAttribute('aria-selected', String(i === index)); });
    var cur = pop.children[index];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function show(input, info, query) {
    var skills = {};
    info.skills.forEach(function (s) { skills[s] = true; });
    var starts = [], has = [];
    info.commands.forEach(function (c) {
      var n = c.toLowerCase();
      if (n.indexOf(query) === 0) starts.push(c); else if (query && n.indexOf(query) >= 0) has.push(c);
    });
    items = starts.concat(has).slice(0, 40).map(function (c) { return { name: c, skill: !!skills[c] }; });
    if (!items.length) return hide();
    var chat = input.closest('.ao-hud-chat');
    if (!pop) { pop = document.createElement('div'); pop.className = 'ao-slash'; pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', 'Commands and skills'); }
    if (pop.parentNode !== chat) chat.appendChild(pop);
    var c = chat.getBoundingClientRect(), f = input.closest('.ao-composer').getBoundingClientRect();
    pop.style.bottom = (c.bottom - f.top + 6) + 'px';
    pop.replaceChildren.apply(pop, items.map(function (it, i) {
      var row = document.createElement('div');
      row.className = 'ao-slash-row';
      row.setAttribute('role', 'option');
      var n = document.createElement('span'); n.className = 'ao-slash-name'; n.textContent = '/' + it.name;
      row.appendChild(n);
      if (it.skill) { var t = document.createElement('span'); t.className = 'ao-slash-tag'; t.textContent = 'skill'; row.appendChild(t); }
      row.addEventListener('mousedown', function (e) { e.preventDefault(); accept(i); });
      return row;
    }));
    field = input; index = 0; paint();
  }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!(t && t.matches && t.matches('.ao-hud-chat .ao-input'))) return;
    var v = t.value;
    if (v.charAt(0) !== '/' || /\s/.test(v)) return hide();
    var bot = (t.placeholder || '').replace(/^Message\s+/, '');
    var info = window.officeAdapter && window.officeAdapter.lookup && window.officeAdapter.lookup(bot);
    if (!info || !info.commands.length) return hide();
    show(t, info, v.slice(1).toLowerCase());
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!pop || e.target !== field) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; paint(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { accept(index); }
    else if (e.key === 'Escape') { hide(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('focusout', function (e) { if (e.target === field) setTimeout(hide, 120); }, true);

  // ---------- attach to the chat panel whenever the office draws it ----------
  // The office sets its theme on its own container. Mirror it to the page so the strip and dialogs follow.
  function syncTheme() {
    var office = document.querySelector('.ao-office');
    var theme = office && office.getAttribute('data-theme');
    if (theme && document.documentElement.getAttribute('data-theme') !== theme) document.documentElement.setAttribute('data-theme', theme);
  }

  function scan() {
    syncTheme();
    var chat = document.querySelector('.ao-hud-chat');
    if (chat && !chat.querySelector('.ao-grip')) addGrips(chat);
    if (chat && size.w != null && !chat.style.width) apply();
    if (!chat) hide();
  }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme'] });
  scan();
})();
