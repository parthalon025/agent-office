// A small Chrome DevTools Protocol client for the core-jobs gate (#147). No dependencies: it starts the Chrome or Edge
// that is already on the machine (headless, its own temp profile, its own debug port) and talks to it over the global
// WebSocket of Node 22. It stops the browser by its own pid, never by image name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  process.env.OFFICE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export const findBrowser = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a headless browser. Returns { page(), close() }. */
export async function launch({ exe = findBrowser(), width = 1360, height = 900 } = {}) {
  if (!exe) throw new Error('No Chrome or Edge found. Set OFFICE_BROWSER to the browser program.');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gate-'));
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu-vsync',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => { child.once('exit', r); child.once('error', () => r(null)); });
  let tabs = null;
  for (let i = 0; i < 100 && !tabs; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (t.some((x) => x.type === 'page')) tabs = t; } catch { /* not up yet */ }
    if (!tabs) await sleep(100);
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    // the profile folder can stay busy for a moment after the browser exits
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  if (!tabs) { await close(); throw new Error('The browser did not start.'); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable');
  const api = {
    send, evaluate,
    async size(w, h, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    },
    async goto(url) { await send('Page.navigate', { url }); },
    async waitFor(expr, ms = 15000, what = expr) {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await evaluate(expr); } catch { /* the page is loading */ }
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    /** A real mouse click at the middle of the first visible element that `pick` (a JS expression) returns. */
    async click(pick) {
      const box = await evaluate(`(()=>{const e=(${pick});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();if(r.width<1||r.height<1)return null;return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!box) return false;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      return true;
    },
    async key(key, { ctrl = false } = {}) {
      const base = { key, modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27 })[key] || 0 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async type(text) { await send('Input.insertText', { text }); },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
  };
  return { page: api, close };
}
