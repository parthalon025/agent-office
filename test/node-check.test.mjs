// Start check (#192): the office needs Node 24.11 or newer, and says so plainly when it starts on an older one.
// Pure rules with an injected version; no server and no port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNode, enforceNode, MIN_NODE } from '../src/node-check.mjs';

test('minimum is 24.11', () => assert.equal(MIN_NODE, '24.11.0'));

test('older versions are refused', () => {
  for (const v of ['22.18.0', '23.9.0', '24.10.9', '24.0.0', '20.1.1', '9.0.0']) assert.match(checkNode(v), /Node 24\.11/, v);
});
test('24.11 and newer pass', () => {
  for (const v of ['24.11.0', '24.11.1', '24.12.0', '25.0.0', '26.13.0', '100.0.0']) assert.equal(checkNode(v), null, v);
});
test('the message names the found version and the fix, in short sentences', () => {
  const m = checkNode('22.18.0');
  assert.match(m, /22\.18\.0/);
  assert.match(m, /nodejs\.org/);
  assert.doesNotMatch(m, /!|please|oops|sorry/i);
});
test('a version that is not read is refused', () => {
  assert.ok(checkNode(''));
  assert.ok(checkNode(undefined));
  assert.ok(checkNode('x.y.z'));
});
test('enforceNode writes the message and exits 1 on an old Node', () => {
  const out = []; let code = null;
  enforceNode('22.18.0', (t) => out.push(t), (c) => { code = c; });
  assert.equal(code, 1);
  assert.match(out.join(''), /Node 24\.11/);
});
test('enforceNode does nothing on a good Node', () => {
  const out = []; let code = null;
  enforceNode('24.11.0', (t) => out.push(t), (c) => { code = c; });
  assert.equal(code, null);
  assert.deepEqual(out, []);
});
