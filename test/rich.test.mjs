// DS RichText: remote images in chat load only after a click (audit #27 M1). An agent reply can hold
// ![x](https://host/?data=...): a plain <img> would send that request the moment the message shows.
// This is the first test that runs the DS bundle in Node: components/bundle.js loads in a VM context with the
// vendored React (public/vendor), and a small shallow renderer calls one component with stand-in hooks
// (the method react-test-renderer/shallow uses). No DOM, no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const sb = { console, URL };
sb.window = sb.self = sb; // the UMD build registers React on self
vm.createContext(sb);
vm.runInContext(src('public/vendor/react.production.min.js'), sb, { filename: 'react.production.min.js' });
vm.runInContext(src('components/bundle.js'), sb, { filename: 'bundle.js' });
const React = sb.React, AO = sb.AgentOffice, rich = AO.rich;
const DISPATCHER = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;

/** One component instance: render() calls it with hooks that keep state between calls. Effects do not run. */
function shallow(Comp, props) {
  const slots = [];
  let i = 0;
  const hooks = {
    useState(init) { const k = i++; if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init; return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }]; },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useContext(ctx) { return ctx._currentValue; },
    useMemo(f) { i++; return f(); },
    useCallback(f) { i++; return f; },
    useEffect() { i++; },
    useLayoutEffect() { i++; },
  };
  return {
    render() {
      i = 0;
      const prev = DISPATCHER.current;
      DISPATCHER.current = hooks;
      try { return Comp(props); } finally { DISPATCHER.current = prev; }
    },
  };
}
/** Every React element in a tree (not into child components: they are not rendered). */
function elements(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out; }
  if (node && typeof node === 'object' && node.$$typeof) { out.push(node); elements(node.props.children, out); }
  return out;
}
const text = (node) => (Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && node.props ? text(node.props.children) : '');
const imgs = (tree) => elements(tree).filter((e) => e.type === 'img');
const loadButton = (tree) => elements(tree).find((e) => e.type === AO.Button && e.props.className === 'ao-rt-load');
const imageElements = (tree) => elements(tree).filter((e) => e.type === rich.Image);

test('remoteHost gives the host the browser would ask for an http(s) image, and null for data: and blob:', () => {
  assert.equal(rich.remoteHost('https://Img.Example.COM/a.png'), 'img.example.com');
  assert.equal(rich.remoteHost('http://user:pw@evil.example:8080/x.png?d=secret'), 'evil.example', 'user info is not the host');
  assert.equal(rich.remoteHost('https://trusted.example@evil.example/x.png'), 'evil.example');
  assert.equal(rich.remoteHost('https://bücher.example/a.png'), 'xn--bcher-kva.example', 'punycode: the name the request really goes to');
  assert.equal(rich.remoteHost(' https://img.example/a.png'), 'img.example');
  for (const u of ['data:image/png;base64,iVBORw0KGgo=', 'blob:http://127.0.0.1:4317/1f0c', '/local.png', '', null, undefined]) assert.equal(rich.remoteHost(u), null, String(u));
  assert.equal(rich.imageShown('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(rich.imageShown('https://img.example/never-clicked.png'), false);
});

test('an agent reply with a remote image shows "Load image from <host>" and no <img> until the click', () => {
  const url = 'https://img.example/c.png?d=secret-from-the-repo';
  const msg = shallow(AO.ChatMessage, { message: { from: 'Scout', text: `Here is the chart:\n\n![Build chart](${url})` } }).render();
  // ChatMessage -> RichText -> Image: follow the real path of a chat message.
  const rt = elements(msg).find((e) => e.type === AO.RichText);
  assert.ok(rt, 'the reply goes through RichText');
  const found = imageElements(shallow(AO.RichText, rt.props).render());
  assert.equal(found.length, 1);
  assert.equal(found[0].props.src, url);
  const img = shallow(rich.Image, found[0].props);
  let tree = img.render();
  assert.deepEqual(imgs(tree), [], 'no <img> before the click');
  assert.equal(tree.type, rich.LoadCard);
  tree = rich.LoadCard(tree.props); // render the card (no hooks)
  assert.deepEqual(imgs(tree), []);
  const btn = loadButton(tree);
  assert.ok(btn, 'a DS Button loads the image');
  assert.equal(text(btn), 'Load image from img.example');
  assert.equal(btn.props.title, url, 'the full URL shows on hover');
  assert.ok(text(tree).includes('Build chart'), 'the card shows the alt text');
  assert.equal(rich.imageShown(url), false);
  btn.props.onClick();
  assert.equal(rich.imageShown(url), true, 'the click counts for this URL');
  tree = img.render();
  assert.deepEqual(imgs(tree).map((e) => e.props.src), [url], 'the image loads after the click');
  assert.equal(imgs(tree)[0].props.referrerPolicy, 'no-referrer', 'the request does not carry the page address');
  // The same URL in another message (or after the chat remounts) shows at once until the page reloads.
  assert.deepEqual(imgs(shallow(rich.Image, { src: url, alt: 'again' }).render()).map((e) => e.props.src), [url]);
  // Another URL on the same host still asks: the click is per image, not per host.
  const other = shallow(rich.Image, { src: 'https://img.example/other.png' }).render();
  assert.deepEqual(imgs(other), []);
  assert.equal(other.type, rich.LoadCard);
});

test('data: images show at once; a remote image inside a link shows its alt text only', () => {
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  const [d] = imageElements(rich.parse(`![dot](${data})`));
  assert.deepEqual(imgs(shallow(rich.Image, d.props).render()).map((e) => e.props.src), [data]);
  const [inLink] = imageElements(rich.parse('[![Logo](https://img.example/logo.png)](https://example.com)'));
  assert.equal(inLink.props.plain, true);
  const card = shallow(rich.Image, inLink.props).render();
  assert.equal(card.type, rich.LoadCard);
  const t = rich.LoadCard(card.props);
  assert.deepEqual(imgs(t), []);
  assert.equal(loadButton(t), undefined, 'no button inside a link');
  assert.equal(text(t), 'Logo');
  assert.equal(t.props.title, 'Image from img.example');
  // A remote image with no alt text still says what it is.
  assert.equal(text(rich.LoadCard({ src: 'https://x.example/a.png', onLoad() {} })).startsWith('Image'), true);
});

test('image attachments follow the same rule', () => {
  const url = 'https://cdn.example/att.png';
  const tree = rich.Attachments({ items: [{ type: 'image', url, name: 'att.png' }] });
  const [el] = imageElements(tree);
  assert.equal(el.props.src, url);
  assert.equal(shallow(rich.Image, el.props).render().type, rich.LoadCard);
});

test('the image viewer asks before it shows a remote image that was not clicked', () => {
  const a = 'https://img.example/viewer-a.png', b = 'https://img.example/viewer-b.png';
  const items = [{ src: a, alt: 'A' }, { src: b, alt: 'B' }];
  const shownA = shallow(rich.Image, { src: a });
  loadButton(rich.LoadCard(shownA.render().props)).props.onClick(); // click A's load button
  assert.equal(rich.imageShown(a), true);
  const box = shallow(rich.Lightbox, { items, index: 1, onClose() {}, onMove() {} });
  let tree = box.render();
  assert.ok(!imgs(tree).some((e) => e.props.src === b), 'B is not requested when the viewer moves to it');
  const wait = elements(tree).find((e) => e.type === rich.LoadCard);
  assert.ok(wait, 'the viewer shows the load card');
  const btn = loadButton(rich.LoadCard(wait.props));
  assert.equal(text(btn), 'Load image from img.example');
  btn.props.onClick();
  tree = box.render();
  assert.ok(imgs(tree).some((e) => e.props.src === b && e.props.referrerPolicy === 'no-referrer'), 'B shows after its click, with no referrer');
  assert.ok(imgs(shallow(rich.Lightbox, { items, index: 0, onClose() {}, onMove() {} }).render()).some((e) => e.props.src === a));
});
