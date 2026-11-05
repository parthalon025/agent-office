# Agent Office DS x1.5 (design system README)

Agent Office is **the control room for any agent harness**. A harness (Claude Code, Hermes Agent, Copilot Studio, the Claude or OpenAI Agents SDK, a local model in LM Studio with an agent loop) runs the agents. Agent Office shows what they do and lets people steer them. Each agent is a bot. Bots sit in rooms, rooms sit on floors, floors stack into a building.

**Agent Office runs no agents.** It connects to a harness through one contract: events in, commands out (see Concepts, Connection). The parts in `kit/` that act like a harness (`manager.js`) are references for teams that have no harness. They are not the product.

**The design system is the 3D office.** The main component is `OfficeScene`: the building with its HUD. All other components are its parts. Every material reads the tokens, so one token change updates the rooms, the bots and the panels.

## For agents: start here

Read four files. Do not guess a value, a prop or an event name.

| File | Type | Use it to |
| --- | --- | --- |
| **README** (this page) | Quickstart | Load, mount, connect, the rules, the definition of done |
| **Recipes** | How-to | Do one task: daily use (since you left, replay, decisions, palette, alerts), show agents, connect Hermes or Copilot, sessions, agent talk, add a role, a part or a theme, test |
| **Reference** | Reference (generated) | Look up a token, an event, a command, the office API or a component |
| **Concepts** | Explanation | Learn why: the model, orchestration map, scene behavior, visual rules, words, accessibility |

`Changelog` lists the versions. `kit/` has starter files: `page.html`, `adapter.js`, `part.js`, `manager.js` (a reference Manager for platforms with no orchestrator), `schema.json` and `check.py`. `components/index.d.ts` has the types. Each component has a README with a props table.

## Quickstart

**1. Load, in this order.**

| # | File |
| --- | --- |
| 1 | `tokens.css` (generated from `tokens.json` by the build; one block per theme) |
| 2 | `components/bundle.css` (imports the fonts) |
| 3 | React 18 and ReactDOM 18 (only for React components) |
| 4 | `components/lib/three.min.js` (three.js 0.147.0) |
| 5 | `components/lib/three-orbit-controls.js` |
| 6 | `components/lib/three-postprocessing.js` (without it, the office renders as quality `low`) |
| 7 | `components/bundle.js` (sets `window.AgentOffice`) |

Set the theme with `data-theme="light" | "dark" | "sublevel"` on `<html>` or on any parent.

**2. Mount.**

```js
const h = React.createElement, A = window.AgentOffice;
ReactDOM.createRoot(el).render(h(A.OfficeScene, {
  building: myBuilding,   // or solution: "hq" | "microsoft" | "hermes" | "copilot"
  adapter: myAdapter,     // leave out for the mock; null for no connection
  height: 720, quality: "auto", intro: true,
  onReady: office => {}, onSelect: name => {}
}));
// No React: const office = A.office.mount(el, { building, adapter, root: el.parentNode });
```

**3. Connect.** The scene changes only from events. Buttons send commands.

```js
const adapter = A.adapters.create({
  name: "My agents",
  subscribe(emit) { socket.onmessage = e => emit(JSON.parse(e.data)); },  // events in
  send(cmd) { return api.post("/agents/command", cmd); }                  // commands out
});
A.validate({ type: "status", bot: "Scout", status: "working" });          // { ok, errors }
```

Start from `kit/page.html` and `kit/adapter.js`. The starter page runs the mock until you set `window.USE_REAL_ADAPTER = true`. Set `AgentOffice.strict = true` while you build: the office then warns on each event that does not match `kit/schema.json`.

## Rules (must)

- Use tokens for every color, size, duration, light level and effect. No literal colors.
- Use the icon set for every symbol. No emoji or text glyphs.
- Keep the color meanings: status = state, floor = floor, type = office type, `accent` = action and focus, `emphasis` = look now (one per decision, about 10% of the screen).
- Pair every status color with a word or an icon. Pair every sound with a visible change.
- Change the scene only with adapter events. Never move bots with your own code; the engine walks them around objects.
- Map risky steps (dangerous tools, spend, publishing) to `request` events.
- Respect `prefers-reduced-motion`. Keep the HUD keyboard path complete.
- Keep the x version prefix (x1.5) until the design is a SKU: in file names, titles, scene signs and the changelog.

## Definition of done

Use visual inspection: take screenshots and look at them.

- [ ] `python3 kit/check.py <your files>` passes (tokens, icons, version marks, event log). A custom property that a checked file defines counts as a known token: `--name:` in a CSS file, in an HTML `<style>` block or in an HTML `style=""` attribute, or `setProperty('--name', ...)` in a script or an HTML file.
- [ ] Screenshots in Day, Night and Sublevel, at 1360, 1100 and 400 px, with `quality: "low"` and with reduced motion.
- [ ] Bots walk around objects: send `status: "resting"` to a room, then `"working"`, and look while they walk.
- [ ] Approve, decline, chat and broadcast send commands; the scene changes only after the adapter replies.
- [ ] ContrastCheck passes in each theme. Focus is visible on every control.
- [ ] Every new state (loading, empty, error, long text) has a preview. The changelog row is updated.
