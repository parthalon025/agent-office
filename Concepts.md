# Concepts

This page tells why the system works as it does. For values, see Reference. For tasks, see Recipes.

## Principles

- **The scene is the status.** A person sees what each bot does without reading. Position, bubble glyph and screen glow carry state. Panels give the detail.
- **Every action is an agent action.** The office never changes a bot on its own. A button sends a command; the scene changes when the adapter sends an event back.
- **The room fits the work.** The office type fits the team; the workstation fits the role.
- **The office grows.** Rooms get wider with more bots, floors with more rooms, the building taller with more floors.
- **Summary before detail.** Counts, then floors and rooms, then the roster, then the log.
- **Glass, not boxes.** Panels float over the scene with `panel`, `blur-panel` and `shadow-panel`. Nothing else gets a shadow.

## The model

`building → floors[] → rooms[] → bots[]`. A floor `key` (ops, sales, research, content, hq) picks the floor color. A room `type` picks the shape, the zone, the props and the rest spot. A bot `role` picks the workstation and the screen picture.

| Office type | Zone | Rest spot | Default roles |
| --- | --- | --- | --- |
| Team floor (`team`) | Rug, two sofas, a floor prop on the back wall | Lounge | research, writer, analyst, sales, planner |
| Lab (`lab`) | Server racks, cable tray, test bench | Bench sofa | coder, ops, analyst |
| Studio (`studio`) | Round stage, cyc wall, softboxes, camera | Green-room sofa | media, designer, writer |
| War room (`hq`) | Long table with a live map, wall of screens | Sofa | planner, analyst |
| Security (`security`) | Six wall screens: two on the back wall, two on each side wall (`room.screens` names them; a page repaints them), a solid left wall and a glass right wall | None | No bots: the engine refuses `bot.add` into it |

Roles: research, writer, coder, analyst, designer, ops, sales, planner, media, and the Microsoft customer solutions roles ae, specialist, partner, se, csa, csam, fde.

**Agents and sessions.** A blob is an agent: a name, a role, tools and a model. A session is work the agent does. By default a session shows as a count badge and a row in the Sessions tab. A session gets its own blob when it has its own context and can block on a person; the adapter sets that (`sessions`, `isolated`). Temporary blobs are grey (`scene-subagent`), arrive by the elevator and leave when they are done.

## Orchestration map

| Concept | Hermes Agent | Copilot Studio | Agent Office |
| --- | --- | --- | --- |
| Orchestrator (shown as Manager) | Main agent | Generative orchestration | An agent: a bot with `orchestrator: true`, badge "Manager". Agent Office runs no agent; the platform does. `kit/manager.js` is an optional reference Manager. It stands, wears a ring and turns to the room; PlanCard |
| Subagents | `delegate_task` | Connected agents | `delegate`, `subagent.done`; dashed hand-off line; DelegationTree |
| Sessions | Conversations, gateway threads | Conversations | `session.start`, `session.end`; Sessions tab, badge or own blob |
| Agent talk | Messages between agents | Agent-to-agent | `message.agent`: turn, walk over or envelope |
| Tools | Toolsets, MCP, terminal, browser | Connectors, flows, MCP, computer use | `tool.call`, `tool.result`; packet on the cable tray; ToolCall |
| Knowledge, skills | Skills, context files | Knowledge sources | `knowledge`, `skill.load` |
| Triggers | Cron jobs | Autonomous triggers | `trigger.run`; ScheduleList |
| Checkpoints | Checkpoints, `/rollback` | — | `checkpoint`, `rollback`; CheckpointTimeline |
| Models | Provider routing, fallback | Model per agent | `model`; ModelBadge |
| Governance | Toolset rules | Agent inventory, Entra Agent ID | AgentCard, AgentRegistry |
| Cost | Caching, routing | Usage analytics | CostMeter; `tokens`, `cost` on `tool.result` |
| Human in the loop | Command approval | Human handoff | `request`; approval cards; emphasis |

## Connection

Agent Office is the control room. The harness runs the agents. They meet in an **adapter**: a small object in the page that turns harness events into Agent Office events and Agent Office commands into harness calls.

```
harness  ──events──▶  adapter  ──emit(ev)──▶  office  ──▶  scene, HUD
harness  ◀──calls───  adapter  ◀──send(cmd)──  office  ◀──  user (approve, chat, stop)
```

**The contract.** `kit/schema.json` lists every event and command. `AgentOffice.validate(ev)` checks one event; `AgentOffice.strict = true` checks all of them while you build. The scene changes only from events, so the office never shows a state the harness did not report.

**Three ways to connect.** Pick the first one that the harness supports.

| Pattern | Use it when | Path | Two-way |
| --- | --- | --- | --- |
| **Direct** | The harness has an HTTP, WebSocket or SSE API that the browser can reach, with no secret key in the page | Page adapter ↔ harness API | Yes |
| **Bridge** | The harness gives hooks, an SDK or a local process, or it needs a secret key | Page adapter ↔ WebSocket ↔ bridge (a small server next to the harness) ↔ harness | Yes, if the harness takes input (SDK, API); watch only for hooks |
| **Trace** | The harness only writes logs or traces (JSONL transcripts, OpenTelemetry spans, webhooks) | Bridge reads the trace and sends events | No: watch only, plus replay |

| Harness | Pattern | Notes |
| --- | --- | --- |
| LM Studio, Ollama | Direct (with CORS on) | A model server, not an agent: add an agent loop (a kit reference) |
| Hermes Agent | Direct (API server) or Bridge (event hooks) | Mapping in Recipes |
| Claude Code | Bridge: hooks for watch mode, Agent SDK for full control | The bridge runs next to Claude Code |
| Claude API, Claude Agent SDK | Bridge (keeps the key) | Tool use and streaming map to `tool.call` and `message` |
| OpenAI API, Agents SDK | Bridge (keeps the key) | Handoffs map to `delegate` |
| Copilot Studio | Bridge (Direct Line secret, tracing export) | Mapping in Recipes |
| GitHub Copilot coding agent | Trace (GitHub webhooks) | Watch only |

Check each vendor's current API before you build an adapter. These are mappings, not promises about a vendor's API.

**The approval round trip.** This is the most important path:

1. The harness wants to do a risky step and waits (a permission prompt, a tool approval, a human handoff).
2. The adapter sends `request { bot, id, text, risk, cost, preview, tool }`.
3. The office shows it in Waiting on me, the decision inbox, a toast and, if alerts are on, a browser alert.
4. The user approves. The office sends `approve { bot, requestId }`.
5. The adapter answers the harness. The harness continues and sends `status` and `tool.result`.

A harness that cannot wait for an answer (watch mode, trace) must not send `request`. Send `message` or `error` instead, so the office never offers a button that does nothing.

**What the bridge does.** It holds secret keys, talks to processes and SDKs a browser cannot reach, turns many harness events into the few Agent Office events, and sends commands back. Keep it small: one file per harness, no state the harness does not already keep.

## The scene

- **Units.** 1 unit is about 0.5 m. Bot 1.1 high, desk 0.95, seat 0.6, wall 5.2, room depth 12, workstation pitch 4.6. The camera is isometric and frames its target box.
- **Navigation.** Bots never walk through objects. The engine reads each mesh from 0.2 to 2.1 units high, grows it by `scene-nav-pad` and marks it on a grid of `scene-nav-cell` cells. Each walk is an A* path smoothed by line of sight. A bot walks at `scene-walk-speed`; a temporary helper (`ephemeral`) walks at `scene-walk-speed-ephemeral`, in and out. A helper walks about twice as fast as a normal bot. A session blob (`session.start` with `sessions: "session"` or `isolated: true`) is also `ephemeral`, so it walks at the helper speed too.
- **Elevator and tower.** Each floor has a glass elevator. Floor changes ride it. The building view is a glass tower on a plaza with a roof sign, a beacon and a car at the current floor.
- **Data you can see.** Tool calls are packets on the cable tray; agent talk across rooms is an envelope; the token meter fills with usage.
- **Living bots.** Blink, sway and glance; a hop when finished; a slump on error.
- **Light.** Glow is for light sources only (screens, lamps, windows, packets, beacons). The Day bloom threshold is above white. Labels and bubbles draw after the effects so text stays sharp. Quality `low` turns the effects off.
- **Motion rules.** The scene may move all the time; panels may not. One moving thing at a time in the HUD. With reduced motion, the extras stop and floors change at once.

## Visual rules

- **Color meaning.** Status colors mean state, floor colors mean floor, type colors mean office type, `accent` means action and focus, `emphasis` means look now. The meanings are the same in 2D and 3D.
- **60-30-10.** 60% neutral (bg, panels, walls, desks), 30% structure (carpet, floor bands, panel heads, accent), 10% emphasis (beacons, unread counts, the key action). One emphasis item per decision.
- **Themes.** Day (`light`), Night (`dark`) and Sublevel (`sublevel`), an original retro-corporate look: flat square panels, Archivo wide uppercase heads, Chivo Mono names, VT323 figures, green carpet and fluorescent light.
- **Type.** IBM Plex Sans for interface text, IBM Plex Mono for numbers. Sublevel swaps the faces, not the scale.
- **Icons.** Line icons on a 24 px grid, 1.75 px stroke, round caps. Use the `Icon` component. No emoji.
- **Shape.** 4 px base. Panels `radius-lg`, rows `radius-md`, buttons `radius-sm`, dots `radius-full`.

## Words

Write in Simplified Technical English (ASD-STE100): short sentences, active voice, one instruction per sentence. Agents speak in the first person.

| Moment | Pattern | Example |
| --- | --- | --- |
| Status line | `<State> · <Task>` | Working · Reviewing the landing zone |
| Approval request | A yes/no question that names the object | Approve sending the QBR deck to Contoso? |
| Buttons | The result | Approve · Decline · Retry · Dismiss · Stop |
| Error | What failed, in under 6 words | Demo tenant login expired |
| Agent reply | `On it. New task: <task>.` | On it. New task: Find 10 leads in Ohio. |
| Agent progress | `Update: <task> is <n>% done.` | Update: the demo is 70% done. |
| Agent talk | `To <agent>: <text>` / `From <agent>: <text>` | From Researcher: Your input is ready. |
| Attachment only (bubble) | `Sent an image` / `Sent a file` / `Sent a link` | Sent an image (+2) |
| Session row | `<State> · <start> to <end> · <result>` | Finished · 10:02 to 10:07 · Done |
| Trace | `Called <tool>`, `Delegated to <agent>`, `Checkpoint · <label>` | Called query_dataverse |
| Empty | What is true, then what to do | No bots yet. Add one from the room list. |
| Toggle | `Turn <thing> on` / `Turn <thing> off` | Turn sound on |

Do not use "Oops", "Sorry", exclamation marks, "please wait" or vague verbs like "process" or "handle".

## Accessibility

- **Contrast.** Text 4.5:1; icons, dots, type colors, borders and focus rings 3:1, in every theme. ContrastCheck measures it live. A status color (`status-*`) is a fill or a dot. For a status word, use `status-*-text` on `bg`, `panel` and `chip`, or `status-*-on-bubble` on `bubble`. Reference.md lists the pairs the DS checks.
- **Never color alone.** Every status dot has a word; every type color has an icon and a label; every sound has a visible change.
- **Keyboard.** Every control is a real button, input or select. Tabs move with arrow keys. Dialogs trap focus and close on Escape. The HUD is the keyboard path to every bot.
- **Screen readers.** The roster is a listbox, the chat a polite live log, toasts `status` or `alert`, the usage bar a `meter`, the sound button a toggle with `aria-pressed`.
- **Focus.** 2 px `accent` outline with 2 px offset.
- **Motion.** `prefers-reduced-motion` stops bob, squash, auto-rotate, spinners, shimmer, blink, sway, glance, hop, flicker, the intro, the elevator ride, camera glides (the camera cuts), packets, envelopes, walks to talk, the portrait fly and the panel stagger.
- **Targets.** Icon buttons 30 × 30 px or more.
