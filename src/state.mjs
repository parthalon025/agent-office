// Saved state (#181): the office's one state file, as slices. Each area owns its slice and its cleaner (SLICES: key -> the
// cleaner that area exports); this module loads the file, hands each cleaner its own part, and writes the file back. The office (office.mjs)
// reads a slice by name (`get`), never the whole object.
// One writer (the Interface): `save()` writes plainly and only once the office owns its port (`claim()`); `claim()` makes the
// first, owner-only write of the whole file through the injected `writeFirst` (writeSecret: user, SYSTEM and Administrators).
// So a copy on a busy port writes nothing (#100): until `claim()` a change stays in memory.
// Keys the file has that no slice knows are kept as they are, so an older or newer office does not lose them.
// Pure apart from the injected file functions: tests give them in memory.
// Each area exports its own cleaner (cleanRules and cleanCosts in security.mjs, cleanTrust in trust.mjs, cleanRooms in rooms.mjs,
// cleanRecord in archetypes.mjs through cleanLayouts here, cleanPersonas, cleanTeams and cleanScreens in personas.mjs, cleanRecent
// in recent.mjs, cleanNotes and cleanPins in notes.mjs, cleanMerges, cleanStandups and cleanFocus in rituals.mjs); SLICES only
// names them. A new slice is a cleaner in its owning module plus one line in SLICES.
// slice(...keys) is for a module that takes a slice of its own: campus gets layouts, rooms and merges; exportCustom gets the
// customization keys.
// Tested in test/state.test.mjs.
import fs from 'node:fs';
import { cleanRules, cleanCosts } from './security.mjs';
import { cleanTrust } from './trust.mjs';
import { cleanRecord } from './archetypes.mjs';
import { cleanRooms } from './rooms.mjs';
import { cleanPersonas, cleanTeams, cleanScreens } from './personas.mjs';
import { cleanRecent } from './recent.mjs';
import { cleanNotes, cleanPins } from './notes.mjs';
import { cleanMerges, cleanStandups, cleanFocus } from './rituals.mjs';
import { cleanOrientation } from './orientation.mjs';
import { cleanManagers } from './manager-employees.mjs';
import { cleanRuntime } from './paperclip-runtime.mjs';
import { cleanSelfApproval } from './hq-model.mjs';
import { cleanWriteGrid } from './hq-writes/index.mjs';

const isMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const list = (raw) => (Array.isArray(raw) ? raw : []);

/** Function floors (#92): one record per building; a record that does not clean is dropped. */
export function cleanLayouts(raw) {
  return Object.fromEntries(Object.entries(isMap(raw) ? raw : {}).map(([k, v]) => [k, cleanRecord(v)]).filter(([, v]) => v));
}
/** The default spend limit: a number of dollars, 0 or more; anything else is not set (the built-in default applies). */
export function cleanSpendLimit(raw) { return Number.isFinite(raw) && raw >= 0 ? raw : undefined; }
/** What a connection to Paperclip keeps ({ url, company }), or nothing. */
export function cleanPaperclip(raw) { return isMap(raw) && typeof raw.url === 'string' ? raw : undefined; }

/**
 * The slices of the saved state. A cleaner takes the saved value (or undefined) and the context `{ exists }` and gives the
 * slice in its one form. Where the owning area exports the cleaner, this table only names it.
 */
export const SLICES = {
  recent: (raw, ctx) => cleanRecent(raw).filter((d) => ctx.exists(d)),   // folders that are gone drop out
  security: cleanRules,
  costs: cleanCosts,
  trust: cleanTrust,
  layouts: cleanLayouts,
  rooms: cleanRooms,
  notes: cleanNotes,
  pins: cleanPins,
  merges: cleanMerges,
  standups: cleanStandups,
  focus: cleanFocus,
  orientation: cleanOrientation,
  personas: cleanPersonas,
  teams: cleanTeams,
  screens: cleanScreens,
  templates: list,
  schedules: list,
  spendLimit: cleanSpendLimit,
  paperclip: cleanPaperclip,
  paperclipRuntime: cleanRuntime,   // { enabled: true } while the user wants the office's own Paperclip to run with the office (#193)
  managers: cleanManagers,   // the office Managers hired as Paperclip employees (#204): { employeeId: { building, name, company } }
  hqGrid: cleanWriteGrid,   // the HQ write grid (#198): { writeKind: 'confirm' | 'allow' | 'deny' } for the cells the user set
  hqSelfApproval: cleanSelfApproval,   // the approval kinds an employee may approve itself (#203): { approvalType: true } for the kinds the user turned on
  httpHooks: (raw) => (isMap(raw) ? raw : undefined),
  commands: (raw) => (Array.isArray(raw) ? raw : undefined),
  goals: (raw) => raw,   // the Manager (manager.mjs restore) reads its own export
};

/**
 * createState({ file, slices, read, write, writeFirst, exists }): load `file` through the slice cleaners.
 *   get(key)           the slice (the same object each time; change it in place, then save())
 *   set(key, value)    replace a slice (undefined removes the key from the file)
 *   slice(...keys)     an object with a get/set property per key, for a module that takes a slice of its own
 *   save()             plain write, only after claim()
 *   claim()            the office owns its port: the first, owner-only write of the whole file; save() writes from now on
 *   owned()            true after claim()
 */
export function createState({ file, slices = SLICES, read = (f) => fs.readFileSync(f, 'utf8'), write = (f, t) => fs.writeFileSync(f, t),
  writeFirst = write, exists = (d) => fs.existsSync(d) } = {}) {
  let raw = {};
  try { const j = JSON.parse(read(file)); if (isMap(j)) raw = j; } catch { /* first run, or a file that does not parse */ }
  const data = { ...raw };
  for (const [key, clean] of Object.entries(slices)) data[key] = clean(raw[key], { exists });
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  let owned = false;
  const text = () => JSON.stringify(data, null, 2);
  const get = (key) => data[key];
  const set = (key, value) => { if (value === undefined) delete data[key]; else data[key] = value; };
  return {
    get, set,
    slice: (...keys) => Object.defineProperties({}, Object.fromEntries(keys.map((k) => [k, { enumerable: true, get: () => get(k), set: (v) => set(k, v) }]))),
    save() { if (!owned) return; try { write(file, text()); } catch { /* ignore */ } },
    claim() { owned = true; writeFirst(file, text()); },
    owned: () => owned,
  };
}
