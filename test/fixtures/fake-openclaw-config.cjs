// A stand-in for `openclaw config get <path> --json` and `openclaw config validate`, for test/mcp-routes.test.mjs. The test's
// openclaw.exe is node.exe, so the office's config reads run `node config get ...`. The test sets NODE_OPTIONS to preload this
// file; it acts only when the script node was asked to run is called `config`, so the server and the fake ACP agent are
// untouched. FAKE_OPENCLAW_CONFIG is a JSON file (path -> value) that the test can change between reads. Like the real
// program: a key with no value exits 1, validate exits 0. No OpenClaw, no network.
const fs = require('node:fs');
const path = require('node:path');

if (path.basename(process.argv[1] || '') === 'config') {
  const [sub, key] = process.argv.slice(2);
  let table = {};
  try { table = JSON.parse(fs.readFileSync(process.env.FAKE_OPENCLAW_CONFIG, 'utf8')); } catch { /* an empty config */ }
  if (sub === 'validate') process.exit(0);
  if (sub === 'get' && Object.prototype.hasOwnProperty.call(table, key)) { process.stdout.write(JSON.stringify(table[key]) + '\n'); process.exit(0); }
  process.exit(1);
}
