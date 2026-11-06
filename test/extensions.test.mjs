// Extensions (audit #27, M4): the argument lists for `claude mcp` and `claude plugin`. No user value may be read as
// an option, so the scope stays local or project. Pure, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXT_SCOPES, mcpAddArgs, mcpRemoveArgs, pluginArgs } from '../src/extensions.mjs';

const refused = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));

/** The options part (before the first `--`) has exactly one --scope, ours, and nothing from the user. */
function scopeIsOurs(args, scope, userValues) {
  const end = args.indexOf('--');
  assert.ok(end > 0, 'a -- ends the options');
  const opts = args.slice(0, end);
  assert.deepEqual(opts.filter((a) => a === '--scope' || /^-s/.test(a)), ['--scope']);
  assert.equal(opts[opts.indexOf('--scope') + 1], scope);
  for (const v of userValues) assert.ok(!opts.includes(v), `${v} is not in the options`);
}

test('mcp add: a command, with -- before the name, so its flags stay its own', () => {
  const args = mcpAddArgs({ scope: 'local', name: 'my-srv', target: '  npx -y @x/server --scope user  ' });
  assert.deepEqual(args, ['mcp', 'add', '--scope', 'local', '--', 'my-srv', 'npx', '-y', '@x/server', '--scope', 'user']);
  scopeIsOurs(args, 'local', ['my-srv', 'npx', '-y']);
});

test('mcp add: a URL is an http connector, or sse when asked', () => {
  assert.deepEqual(mcpAddArgs({ scope: 'project', name: 'sentry', target: 'https://mcp.example.com/mcp' }),
    ['mcp', 'add', '--scope', 'project', '--transport', 'http', '--', 'sentry', 'https://mcp.example.com/mcp']);
  const sse = mcpAddArgs({ scope: 'local', name: 'a.b_c', target: 'HTTP://x/sse', transport: 'sse' });
  assert.deepEqual(sse, ['mcp', 'add', '--scope', 'local', '--transport', 'sse', '--', 'a.b_c', 'HTTP://x/sse']);
  scopeIsOurs(sse, 'local', ['a.b_c']);
  assert.equal(mcpAddArgs({ scope: 'local', name: 'x', target: 'https://x', transport: 'stdio' })[5], 'http', 'only http or sse');
});

test('mcp add: a name must start with a letter or a digit (-suser would be --scope user)', () => {
  for (const name of ['-suser', '-s', '--scope', '-', '.x', '_x', '', ' ', 'a b', 'a/b', 'x'.repeat(65)]) {
    refused(() => mcpAddArgs({ scope: 'local', name, target: 'node x.js' }), /Start with a letter or a digit/);
  }
  assert.equal(mcpAddArgs({ scope: 'local', name: 'x'.repeat(64), target: 'node' })[5], 'x'.repeat(64));
  assert.equal(mcpAddArgs({ scope: 'local', name: ' 9lives ', target: 'node' })[5], '9lives', 'the name is trimmed');
});

test('mcp add: only scope local or project, and a target is required', () => {
  for (const scope of ['user', 'USER', 'Local', '', undefined, '-suser', 'local ']) {
    refused(() => mcpAddArgs({ scope, name: 'x', target: 'node' }), /scope local or project/);
  }
  refused(() => mcpAddArgs({ scope: 'local', name: 'x', target: '   ' }), /URL or a command/);
  refused(() => mcpAddArgs({ scope: 'local', name: 'x' }), /URL or a command/);
  assert.deepEqual([...EXT_SCOPES].sort(), ['local', 'project']);
});

test('mcp remove: -- before the listed name; a dash name is refused', () => {
  const args = mcpRemoveArgs({ scope: 'project', name: 'claude.ai Gmail' });
  assert.deepEqual(args, ['mcp', 'remove', '--scope', 'project', '--', 'claude.ai Gmail']);
  scopeIsOurs(args, 'project', ['claude.ai Gmail']);
  assert.deepEqual(mcpRemoveArgs({ scope: 'local', name: 'plugin:x:y@m' }).slice(-2), ['--', 'plugin:x:y@m']);
  for (const name of ['-suser', '--scope', ' x', '', undefined, 'a\nb']) refused(() => mcpRemoveArgs({ scope: 'local', name }), /Unknown connector/);
  refused(() => mcpRemoveArgs({ scope: 'user', name: 'x' }), /scope local or project/);
});

test('plugin verbs: --scope comes last, an id never starts with a dash', () => {
  assert.deepEqual(pluginArgs({ verb: 'install', scope: 'project', id: ' name@market ' }), ['plugin', 'install', 'name@market', '--scope', 'project']);
  for (const verb of ['enable', 'disable', 'uninstall']) assert.equal(pluginArgs({ verb, scope: 'local', id: 'p' }).at(-1), 'local');
  for (const id of ['-suser', '--scope', '@x', '', 'a b']) refused(() => pluginArgs({ verb: 'enable', scope: 'local', id }), /plugin id/);
  refused(() => pluginArgs({ verb: 'list', scope: 'local', id: 'p' }), /Unknown action/);
  refused(() => pluginArgs({ verb: 'install', scope: 'user', id: 'p' }), /scope local or project/);
});
