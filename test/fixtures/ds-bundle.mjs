// The DS bundle in Node: components/bundle.js in a VM context with the vendored React (public/vendor), as the page loads it
// before its own scripts. No DOM and no THREE: only what the bundle defines at load (the components, AgentOffice.worstOf,
// AgentOffice.rich, ...). test/rich.test.mjs renders components from it; test/building.test.mjs gives building.js the DS's one
// worst-state order (#92 review), as the page does.
import fs from 'node:fs';
import vm from 'node:vm';

const src = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

/** A new VM context with React and the DS bundle loaded. Returns { React, AO } (AO: window.AgentOffice). */
export function loadBundle() {
  const sb = { console, URL };
  sb.window = sb.self = sb; // the UMD build registers React on self
  vm.createContext(sb);
  vm.runInContext(src('public/vendor/react.production.min.js'), sb, { filename: 'react.production.min.js' });
  vm.runInContext(src('components/bundle.js'), sb, { filename: 'bundle.js' });
  return { React: sb.React, AO: sb.AgentOffice };
}
