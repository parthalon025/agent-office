/* Agent Office for Claude Code x0.2: the extensions feature (#184, the page features of #168).
   Extensions: connectors (MCP servers) and plugins of a session's folder. One Module: its Interface is window.OfficePage.Extensions = { Dialog: ExtensionsDialog }.
   Plain functions over the page core (window.OfficePage); office.js calls the Interface and holds none of the parts. */
(function () {
  'use strict';
  var O = window.OfficePage;
  var h = React.createElement, A = window.AgentOffice, useState = React.useState, useEffect = React.useEffect;
  var Busy = O.Busy, F = O.F, Pair = O.Pair, client = O.client, clip = O.clip, plural = O.plural;

  // ---------- extensions: connectors (MCP servers) and plugins ----------
  var MCP_WORD = { connected: ['finished', 'Connected'], pending: ['working', 'Connecting'], failed: ['error', 'Failed'], 'needs-auth': ['waiting', 'Needs sign-in'], disabled: ['resting', 'Off'] };
  // Connectors in the order a person looks for them: this folder first, then the account.
  var MCP_GROUPS = [{ id: 'folder', label: 'This folder' }, { id: 'plugin', label: 'From plugins' }, { id: 'user', label: 'Your Claude Code' }, { id: 'claudeai', label: 'claude.ai connectors' }, { id: 'other', label: 'Other' }];
  function groupOf(m) {
    if (m.source === 'plugin') return 'plugin';
    if (m.scope === 'local' || m.scope === 'project') return 'folder';
    if (m.scope === 'user') return 'user';
    if (m.scope === 'claudeai' || m.source === 'claudeai') return 'claudeai';
    return 'other';
  }
  var SCOPES = [{ value: 'local', label: 'This folder only (local)' }, { value: 'project', label: 'Shared in the repository (project)' }];
  function ExtensionsDialog(p) {
    var tb = useState('connectors'), tab = tb[0], setTab = tb[1];
    var dt = useState(null), data = dt[0], setData = dt[1];
    var er = useState(''), err = er[0], setErr = er[1];
    var nt = useState(''), note = nt[0], setNote = nt[1];
    var bz = useState(''), busy = bz[0], setBusy = bz[1];
    var ad = useState(null), add = ad[0], setAdd = ad[1];
    var cf = useState(null), confirm = cf[0], setConfirm = cf[1];
    var qq = useState(''), q = qq[0], setQ = qq[1];
    var pq = useState(''), pfind = pq[0], setPfind = pq[1];
    function load() { setErr(''); client.extList({ uid: p.uid }).then(setData, function (x) { setErr(x.message); setData({ servers: null, plugins: [] }); }); }
    useEffect(load, [p.uid]);
    function act(key, body, done) {
      setBusy(key); setErr(''); setNote('');
      client.ext(Object.assign({ uid: p.uid }, body)).then(function (r) {
        setBusy(''); if (r.restart) setNote('Saved. New sessions in this folder get the change. Close and reopen this session to use it now.');
        var said = { 'mcp-add': ['success', 'Connector added', body.name], 'mcp-remove': ['info', 'Connector removed', body.name], 'plugin-install': ['success', 'Plugin installed', body.id],
          'plugin-uninstall': ['info', 'Plugin removed', body.id], 'plugin-enable': ['success', 'Plugin on', body.id], 'plugin-disable': ['info', 'Plugin off', body.id],
          toggle: [body.enabled ? 'success' : 'info', body.enabled ? 'Connector on' : 'Connector off', body.name] }[body.action];
        if (said && p.toast) p.toast({ tone: said[0], title: said[1], text: String(said[2]) });
        if (done) done(); load();
      }, function (x) { setBusy(''); setErr(x.message); });
    }
    if (confirm) {
      return h(A.Dialog, { open: true, title: confirm.title, onClose: function () { setConfirm(null); }, actions: [
        h(A.Button, { key: 'c', variant: 'quiet', onClick: function () { setConfirm(null); } }, 'Keep it'),
        h(A.Button, { key: 'r', variant: 'danger', icon: 'remove', loading: busy === 'confirm', onClick: function () { act('confirm', confirm.body, function () { setConfirm(null); }); } }, confirm.button)] },
        h('div', { className: 'form' }, h('p', { className: 'note' }, confirm.text), err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null));
    }
    var servers = data && data.servers, seenPl = {};
    var allPlugins = ((data && data.plugins) || []).filter(function (pl) { if (seenPl[pl.id]) return false; seenPl[pl.id] = true; return true; });
    var pt = pfind.trim().toLowerCase();
    var plugins = allPlugins.filter(function (pl) { return !pt || (pl.id + ' ' + (pl.scope || '')).toLowerCase().indexOf(pt) >= 0; });
    var persistent = function (scope) { return scope === 'local' || scope === 'project'; };
    var match = function (m) { var t = q.trim().toLowerCase(); return !t || (m.name + ' ' + m.status + ' ' + m.source + ' ' + m.scope).toLowerCase().indexOf(t) >= 0; };
    var shownServers = (servers || []).filter(match);

    var connectors = h('div', { className: 'form' },
      data && !data.live ? h('p', { className: 'note' }, 'This session runs in a terminal. Turn connectors on and off there with /mcp. You can still add and remove them for this folder.') : null,
      add && add.kind === 'mcp' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-name', label: 'Name', value: add.name, placeholder: 'sentry', onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } }),
          h(A.Select, { id: 'x-scope', label: 'Save for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h(A.TextInput, { id: 'x-target', label: 'URL or command', value: add.target, placeholder: 'https://mcp.sentry.dev/mcp  or  npx -y @scope/server', hint: 'A URL adds an HTTP connector. A command adds a local one that the session starts.', onChange: function (v) { setAdd(Object.assign({}, add, { target: v })); } }),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.name.trim() || !add.target.trim(), onClick: function () { act('add', { action: 'mcp-add', name: add.name.trim(), target: add.target.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Add connector'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      data && !add ? h(A.AddButton, { label: 'Add a connector', onClick: function () { setErr(''); setAdd({ kind: 'mcp', name: '', target: '', scope: 'local' }); } }) : null,
      !data ? h('p', { className: 'note', role: 'status' }, 'Asking the session for its connectors. A session that just opened can take half a minute while they start.') : null,
      h(Busy, { on: !data }),
      servers && !servers.length ? h(A.EmptyState, { icon: 'connector', compact: true, title: 'No connectors', text: 'Add one to give the session more tools.' }) : null,
      servers && servers.length > 6 ? h(A.TextInput, { id: 'x-filter', label: 'Find', value: q, placeholder: 'Name, status or source', onChange: setQ }) : null,
      MCP_GROUPS.map(function (g) {
        var rows = shownServers.filter(function (m) { return groupOf(m) === g.id; });
        if (!rows.length) return null;
        return h('section', { key: g.id, className: 'ext-group' },
          h('h3', { className: 'ext-h' }, g.label, h('span', { className: 'ext-n' }, rows.length)),
          h('ul', { className: 'ext-list' }, rows.map(function (m) {
            var w = MCP_WORD[m.status] || ['resting', m.status], off = m.status === 'disabled', own = m.name === 'office';
            return h('li', { key: m.name, className: 'ext-row' },
              h(A.StatusDot, { status: w[0] }),
              h('div', { className: 'ext-main' },
                h('div', { className: 'ext-name' }, m.name.replace(/^claude\.ai /, '').replace(/^plugin:([^:]+):.*/, '$1')),
                h('div', { className: 'ext-sub' }, w[1] + (m.tools != null && m.status === 'connected' ? ' · ' + plural(m.tools, 'tool', 'tools') : '') + (own ? ' · the office uses it' : '')),
                m.error ? h('div', { className: 'ext-err', title: m.error }, clip(m.error, 110)) : null),
              h('div', { className: 'ext-actions' },
                m.status === 'failed' ? h(A.Button, { variant: 'quiet', icon: 'retry', loading: busy === 'r:' + m.name, onClick: function () { act('r:' + m.name, { action: 'reconnect', name: m.name }); } }, 'Reconnect') : null,
                own ? null : h(A.Button, { variant: 'quiet', icon: off ? 'resume' : 'pause', disabled: !data.live, loading: busy === 't:' + m.name, onClick: function () { act('t:' + m.name, { action: 'toggle', name: m.name, enabled: off }); } }, off ? 'Turn on' : 'Turn off'),
                persistent(m.scope) && !own ? h(A.Button, { variant: 'ghost', icon: 'remove', title: 'Remove ' + m.name, onClick: function () { setConfirm({ title: 'Remove the connector ' + m.name, text: 'Removes ' + m.name + ' from the ' + m.scope + ' settings of this folder. Other folders keep their own settings.', button: 'Remove connector', body: { action: 'mcp-remove', name: m.name, scope: m.scope } }); } }, 'Remove') : null));
          })));
      }),
      servers && q && !shownServers.length ? h('p', { className: 'note' }, 'No connector matches.') : null,
      servers && servers.length ? h('p', { className: 'note' }, 'Turn off and Turn on change this session only. To change account and claude.ai connectors for good, use /mcp in Claude Code or claude.ai settings.') : null);

    var pluginList = h('div', { className: 'form' },
      add && add.kind === 'plugin' ? h('div', { className: 'past-row' }, h('div', { className: 'form' },
        Pair(h(A.TextInput, { id: 'x-pid', label: 'Plugin', value: add.id, placeholder: 'name@marketplace', onChange: function (v) { setAdd(Object.assign({}, add, { id: v })); } }),
          h(A.Select, { id: 'x-pscope', label: 'Install for', options: SCOPES, value: add.scope, onChange: function (v) { setAdd(Object.assign({}, add, { scope: v })); } })),
        h('div', { className: 'inline-actions' },
          h(A.Button, { variant: 'primary', icon: 'add', loading: busy === 'add', disabled: !add.id.trim(), onClick: function () { act('add', { action: 'plugin-install', id: add.id.trim(), scope: add.scope }, function () { setAdd(null); }); } }, 'Install plugin'),
          h(A.Button, { variant: 'quiet', onClick: function () { setAdd(null); } }, 'Cancel')))) : null,
      data && !add ? h(A.AddButton, { label: 'Install a plugin', onClick: function () { setErr(''); setAdd({ kind: 'plugin', id: '', scope: 'local' }); } }) : null,
      h(Busy, { on: !data }),
      data && !allPlugins.length ? h(A.EmptyState, { icon: 'skill', compact: true, title: 'No plugins', text: 'Install one from a marketplace.' }) : null,
      allPlugins.length > 6 ? h(A.TextInput, { id: 'x-pfilter', label: 'Find', value: pfind, placeholder: 'Plugin name or marketplace', onChange: setPfind }) : null,
      allPlugins.length && pt && !plugins.length ? h('p', { className: 'note' }, 'No plugin matches.') : null,
      [{ on: true, label: 'On in this folder' }, { on: false, label: 'Off in this folder' }].map(function (g) {
        var rows = plugins.filter(function (pl) { return pl.enabled === g.on; });
        if (!rows.length) return null;
        return h('section', { key: String(g.on), className: 'ext-group' },
          h('h3', { className: 'ext-h' }, g.label, h('span', { className: 'ext-n' }, rows.length)),
          h('ul', { className: 'ext-list' }, rows.map(function (pl) {
            var name = pl.id.split('@')[0], from = pl.id.split('@')[1] || '';
            return h('li', { key: pl.id + pl.scope, className: 'ext-row' },
              h(A.StatusDot, { status: pl.enabled ? 'finished' : 'resting' }),
              h('div', { className: 'ext-main' },
                h('div', { className: 'ext-name' }, name),
                h('div', { className: 'ext-sub' }, (from ? from + ' · ' : '') + 'installed for ' + (pl.scope === 'user' ? 'you' : 'this folder') + ' · ' + pl.version)),
              h('div', { className: 'ext-actions' },
                h(A.Button, { variant: 'quiet', icon: pl.enabled ? 'pause' : 'resume', loading: busy === 'p:' + pl.id, onClick: function () { act('p:' + pl.id, { action: pl.enabled ? 'plugin-disable' : 'plugin-enable', id: pl.id, scope: 'local' }); } }, pl.enabled ? 'Turn off' : 'Turn on'),
                persistent(pl.scope) ? h(A.Button, { variant: 'ghost', icon: 'remove', title: 'Remove ' + name, onClick: function () { setConfirm({ title: 'Remove the plugin ' + name, text: 'Uninstalls ' + pl.id + ' from the ' + pl.scope + ' scope of this folder.', button: 'Remove plugin', body: { action: 'plugin-uninstall', id: pl.id, scope: pl.scope } }); } }, 'Remove') : null));
          })));
      }),
      h('p', { className: 'note' }, 'Turn on and Turn off save a setting for this folder only. The session reloads its plugins at once.'));

    return h(A.Dialog, { open: true, title: 'Extensions for ' + p.name, onClose: p.onClose, actions: [
      h(A.Button, { key: 'rf', variant: 'quiet', icon: 'retry', onClick: load }, 'Refresh'),
      h(A.Button, { key: 'd', variant: add ? 'quiet' : 'primary', onClick: p.onClose }, 'Done')] },
      h('div', { className: 'form wide' },
        data && data.folder ? h('p', { className: 'note mono', title: data.folder }, F.shortPath(data.folder)) : null,
        err ? h('p', { className: 'ao-err', role: 'alert' }, err) : null,
        note ? h('p', { className: 'note', role: 'status' }, note) : null,
        h(A.Tabs, { value: tab, onChange: function (v) { setTab(v); setAdd(null); }, label: 'Extension types',
          tabs: [{ id: 'connectors', label: 'Connectors', icon: 'connector', count: servers ? servers.length : undefined }, { id: 'plugins', label: 'Plugins', icon: 'skill', count: allPlugins.length }],
          render: function (id) { return id === 'plugins' ? pluginList : connectors; } })));
  }

  O.Extensions = { Dialog: ExtensionsDialog };
})();
