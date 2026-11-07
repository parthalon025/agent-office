// Start check (#192): the office needs Node 24.11 or newer, as Paperclip does (the office reads Paperclip with the global WebSocket
// and fetch of that Node, so it needs no dependency for it). server.mjs imports this file first, so on an older Node the
// message comes before any other module loads. Plain syntax only: it must parse on an old Node. Importing it runs the check.
export const MIN_NODE = '24.11.0';

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

// null when the version is good, else the message.
export function checkNode(version) {
  const have = parse(version);
  const need = parse(MIN_NODE);
  let ok = false;
  if (have) {
    for (let i = 0; i < 3; i++) {
      if (have[i] !== need[i]) { ok = have[i] > need[i]; break; }
      ok = true;
    }
  }
  if (ok) return null;
  return 'Agent Office needs Node 24.11 or newer.\n'
    + 'This is Node ' + (have ? have.join('.') : 'of an unknown version') + '.\n'
    + 'Install Node 24 from https://nodejs.org, then start the office again.\n';
}

export function enforceNode(version, write, exit) {
  const message = checkNode(version);
  if (message === null) return;
  write(message);
  exit(1);
}

enforceNode(process.versions.node, (t) => process.stderr.write(t), (c) => process.exit(c));
