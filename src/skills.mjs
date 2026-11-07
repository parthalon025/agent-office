// Skills an agent writes (#72): the office lists, reads, edits and deletes them in the agent's own skills folder
// (Hermes: ~/.hermes/skills/<name>/SKILL.md, or <category>/<name>/SKILL.md). The folder comes from the provider
// (skillsDir). This is a distinct job from the provider and the server: a path-safe store of files outside the
// worktree, so it has its own file and its own test (test/skills.test.mjs).
//
// A skill is a folder one or two levels under the skills folder with a SKILL.md in it. Its name is that path with
// slashes: 'deploy' or 'devops/rollback'. Names are plain folder names (letters, digits, dot, dash, underscore; no
// leading dot), so a name can never leave the folder. A link or junction is never followed: a folder or file that is
// a link is not a skill. The office edits and deletes; it does not make skills (the agent does).
//
// The caller holds the user's confirm before save and remove (office.mjs). Sync file calls; the folder is small.
import fs from 'node:fs';
import path from 'node:path';

export const SKILL_MAX = 64 * 1024;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = 'SKILL.md';

export class SkillsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');

// title and description: from the front matter (name, description), else the first heading, else the folder name.
function describe(text, name) {
  const t = norm(text);
  let meta = {}, body = t;
  const m = t.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (m) {
    body = t.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  const h = body.match(/^#\s+(.+)$/m);
  return { title: (meta.name || (h && h[1].trim()) || name.split('/').pop()).slice(0, 120), description: (meta.description || '').slice(0, 300) };
}

export function createSkills({ dir }) {
  const root = path.resolve(dir);

  const stat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const isDir = (p) => { const s = stat(p); return !!s && s.isDirectory() && !s.isSymbolicLink(); };
  const isFile = (p) => { const s = stat(p); return !!s && s.isFile() && !s.isSymbolicLink(); };

  // The folder and file of skill `name`, or a SkillsError. 400 for a name that is not plain, 404 for no such skill.
  function find(name) {
    const segs = String(name ?? '').split('/');
    if (segs.length < 1 || segs.length > 2 || !segs.every((x) => SEG.test(x))) throw new SkillsError(400, 'That is not a skill name.');
    let at = root;
    for (const x of segs) {
      at = path.join(at, x);
      if (!isDir(at)) throw new SkillsError(404, 'No such skill.');
    }
    const file = path.join(at, FILE);
    if (!isFile(file)) throw new SkillsError(404, 'No such skill.');
    // Belt and braces: after links, the folder must still be under the skills folder.
    const real = fs.realpathSync.native(at), top = fs.realpathSync.native(root);
    if (path.relative(top, real).startsWith('..') || path.isAbsolute(path.relative(top, real))) throw new SkillsError(404, 'No such skill.');
    return { at, file, segs };
  }

  function entries(p) {
    try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && SEG.test(d.name)).map((d) => d.name).sort(); } catch { return []; }
  }

  return {
    dir: root,

    /** Every skill: [{ name, title, description, bytes, at }], by name. A missing folder is no skills. */
    list() {
      const out = [];
      const add = (name, file) => {
        const s = fs.statSync(file);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { /* unreadable: no title */ }
        out.push({ name, ...describe(text, name), bytes: s.size, at: Math.round(s.mtimeMs) });
      };
      for (const a of entries(root)) {
        const pa = path.join(root, a);
        if (isFile(path.join(pa, FILE))) { add(a, path.join(pa, FILE)); continue; }
        for (const b of entries(pa)) if (isFile(path.join(pa, b, FILE))) add(`${a}/${b}`, path.join(pa, b, FILE));
      }
      return out;
    },

    /** { name, text, bytes, at } of one skill. */
    read(name) {
      const { file, segs } = find(name);
      const s = fs.statSync(file);
      if (s.size > SKILL_MAX * 4) throw new SkillsError(413, 'That skill is too large to show.');
      return { name: segs.join('/'), text: fs.readFileSync(file, 'utf8'), bytes: s.size, at: Math.round(s.mtimeMs) };
    },

    /** Replaces the text of a skill that exists. Returns { name, bytes }. */
    save(name, text) {
      const { file, segs } = find(name);
      const next = norm(text);
      if (Buffer.byteLength(next) > SKILL_MAX) throw new SkillsError(413, `A skill can have ${SKILL_MAX / 1024} KB. This one has ${Math.ceil(Buffer.byteLength(next) / 1024)} KB.`);
      fs.writeFileSync(file, next);
      return { name: segs.join('/'), bytes: Buffer.byteLength(next) };
    },

    /** Deletes the skill's folder (its SKILL.md and what is beside it). An empty category folder goes too. */
    remove(name) {
      const { at, segs } = find(name);
      fs.rmSync(at, { recursive: true, force: true });
      if (segs.length === 2) {
        const cat = path.dirname(at);
        try { if (!fs.readdirSync(cat).length) fs.rmdirSync(cat); } catch { /* not empty, or gone */ }
      }
      return { name: segs.join('/') };
    },
  };
}
