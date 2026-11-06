// The DS's public surface as a theme sees it, for test/theme-contract.test.mjs: tokens.json and tokens.css, the bundle loaded in a
// Node VM (AgentOffice.MODES, THUMBS_BY_THEME, ICONS, PORTRAITS, LOGO), the two engine tables that the bundle keeps private
// (LOOKS and FX, read the way test/ds-engine.test.mjs reads them), and the DS docs as text. It adds no export to the bundle.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');

export const tokens = JSON.parse(read('tokens.json'));
export const schema = JSON.parse(read('kit/schema.json'));
export const bundleText = read('components/bundle.js');
export const bundleCss = read('components/bundle.css');
export const tokensCss = read('tokens.css');

/** Every theme of tokens.json, in order: [{ id, name }]. The one theme list. */
export const themes = tokens.color.themes;

const sb = { console, URL };
sb.window = sb.self = sb;
vm.createContext(sb);
vm.runInContext(read('public/vendor/react.production.min.js'), sb, { filename: 'react.production.min.js' });
vm.runInContext(bundleText, sb, { filename: 'bundle.js' });
/** The bundle's global, AgentOffice. */
export const AO = sb.AgentOffice;

function source(start, end = '}\n') {
  const at = bundleText.indexOf(start);
  if (at < 0) throw new Error(`the bundle has no ${start}`);
  return bundleText.slice(at, bundleText.indexOf(end, at) + end.length);
}

/** The custom properties of the Day block of tokens.css (the engine reads light-* and fx-* from there). */
export const rootVals = (() => {
  const at = tokensCss.indexOf(':root, [data-theme="light"] {'), text = tokensCss.slice(at, tokensCss.indexOf('\n}', at)), o = {};
  for (const m of text.matchAll(/\n\s*--([a-z0-9-]+): ([^;]+);/g)) o[m[1]] = m[2];
  return o;
})();

/** The block of tokens.css for one theme: the Day block is the root block. */
export function themeBlock(id) {
  const open = id === 'light' ? ':root, [data-theme="light"] {' : `\n[data-theme="${id}"] {`;
  const at = tokensCss.indexOf(open);
  return at < 0 ? null : tokensCss.slice(at, tokensCss.indexOf('\n}', at));
}

/** The engine's LOOKS and FX tables after readScene read the tokens: { LOOKS, FX }. */
export function looksAndFx() {
  const run = new Function('AO', 'getComputedStyle', 'document',
    'var DEPTH,PITCH,GAP,FLOOR_H,DUR={},HANDOFF={},WALK={},NAV={},LOOKS;' + source('var FX={', '};\n') + source('function num(cs,n,f){', '}\n') +
    source('LOOKS={day:', '};\n') + source('function readScene(el){', '}\n') + 'readScene();return {FX:FX,LOOKS:LOOKS};');
  return run({ MODES: AO.MODES }, () => ({ getPropertyValue: (n) => rootVals[n.slice(2)] ?? '' }), { documentElement: {} });
}
