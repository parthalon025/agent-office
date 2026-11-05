# Recipes

Each recipe does one task. Do the steps in order. Look up names in Reference.

## Daily use

The office HUD has these by default (set `hud: false` to hide all HUD parts):

- **Since you left.** On open, a card counts what happened since the person last saw this building (the page was hidden, or the scene of this building was disposed while the page showed): finished, needs you, errors, spend, and up to 3 lines. Needs you counts and lists the bots with an open request, the same bots as the decisions inbox. The card follows them while it shows. History is kept in the browser (`localStorage`, key `ao-history:<building name>`). The saved copy has a size cap: the newest entries in 400,000 characters, each text cut at 2,000. When the storage is full, the building seen longest ago loses its saved history first. Events with `seeded: true` do not count (see Mount a scene again). Set `sinceYouLeft: false` to hide the card. `onSinceYouLeft(open)` tells the page when the card shows and when it goes. API: `office.summary(sinceMs)`, `office.history(sinceMs)`.
- **Replay.** "Replay" on the card, the trace button in the zoom panel, or the palette opens the time scrubber. The office replays the recorded events at 1x, 10x or 60x. Live events wait and apply after the replay. "Live" stops it. API: `office.replay({ from, to, speed })`, `office.stopReplay()`.
- **Decisions.** The decisions button (with the count) opens the inbox: every request, high risk first, with cost and a preview. Keys: J / K move, A approve, D decline, X select, Shift+A approve the selection. Send `risk`, `cost`, `preview` and `tool` on `request` events to fill it. API: `office.approveMany(names)`, `office.declineMany(names)`.
- **Command palette.** Ctrl+K or Cmd+K: jump to a bot or a floor, approve all low-risk requests, open decisions, replay, change the view, the theme or the sound, or type a request for the Manager.
- **Alerts.** The bell button turns on browser alerts for "needs you" and errors while the page is hidden. The page title shows the count, for example "(3) Agent Office". Alerts start only from that click. The scene counts the building on screen. To count more, pass `waitingCount` to `OfficeScene`. To run your own `Notifier`, pass `notifier: false` and give your `Notifier` `title` and `count` as you need.
- **Control the inbox.** Pass `inbox` and `onInbox` to `OfficeScene` to open or close the decisions inbox from the page and to read its state.
- **Ambient bar.** `ambient: true` shows only a strip with floor pips, the "needs you" count and the last activity, for a second screen or a narrow window. "Open" shows the full office (`onAmbientOpen`).
- **Framing.** With the HUD on, the scene centers between the left and right panels, so the elevator lobby stays visible. Set `frameInset: { left, right }` (px) to override it, or `null` for none. A side under 0 counts as 0. When the two sides together take more than 65% of the view width, both shrink in proportion, so the scene keeps 35% of the width and stays in the view. With `prefers-reduced-motion`, the camera cuts to each new view.
- **Zoom.** The + and - buttons call `office.zoom(1.2)` and `office.zoom(1/1.2)`. The zoom stays between `minZoom` and `maxZoom` of the stage controls (`office.inspect().stage.ctl`). If your page frames a view past `maxZoom`, raise `maxZoom` while that view shows, so + can zoom in more. + never zooms out.

## Add a tab to the agent panel

1. Pass `extraTabs` to `OfficeScene` (or `AgentPanel`): `[{ id: "terminal", label: "Terminal", icon: "terminal", after: "chat", render: function (bot) { return h(MyTerminal, { bot: bot.name }); } }]`.
2. Give each tab a unique `id` of letters, digits and dashes only. Do not use `chat`, `trace`, `sessions` or `agent`. The panel ignores an extra tab with any other id.
3. To remove a built-in tab, pass `hideTabs: ["trace"]`.
4. To learn which tab is open, use `onTabChange(id)`.
5. To open a tab from the page, for example from a click on a desk monitor, pass `agentTab: "terminal"` to `OfficeScene` (`activeTab` on `AgentPanel`), select the bot, and keep `agentTab` in step with `onTabChange`.

The DS draws the tab, the focus and the keys. Your `render` draws only the content.

## Show your agents

1. Write a `building`: `floors[] → rooms[] → bots[]`. Give each bot a unique `name`, a `role` and a `shape` (blob, cone, octa, capsule).
2. Put each room in the office type that fits the work: `team`, `lab`, `studio` or `hq` (war room).
3. Pass it: `h(A.OfficeScene, { building })`. Or start from a solution: `solution: "hermes" | "copilot" | "microsoft" | "hq"`.

Leave `color` out and the scene picks a body color for each bot. To set it yourself, take it from `AgentOffice.BODY_COLORS` (10 colors), for example `BODY_COLORS[n % BODY_COLORS.length]`, so a list and the scene show the same color. Do not copy the hex values. `BOT_COLORS` has only 4 colors (one for each shape) and is for portraits. Do not use it for a bot color. The color is a CSS color, not an index.

Do not draw your own 3D bots. Do not set bot positions.

## Connect a platform

0. Pick the pattern: Direct, Bridge or Trace (Concepts, Connection). Use a bridge for any secret key.
1. Copy `kit/adapter.js`. Fill the two mapping tables: platform event → Agent Office event, command → platform call.
2. Set `AgentOffice.strict = true`. Play a recorded event log and fix each warning.
3. Map risky steps to `request`. Send `tokens` and `cost` on `tool.result`.
4. Run `python3 kit/check.py --events log.jsonl`.

| Platform | Map these |
| --- | --- |
| Hermes Agent | `delegate_task` → `delegate` / `subagent.done`; tool start and end → `tool.call` / `tool.result`; checkpoints → `checkpoint`; cron → `trigger.run`; provider fallback → `model`; each conversation → `session.start` / `session.end` |
| Copilot Studio | Plan → `plan`; connected agent call → `delegate`; connector or flow → `tool.call` / `tool.result`; knowledge lookup → `knowledge`; autonomous trigger → `trigger.run`; each conversation → `session.start` / `session.end` |
| Claude Code, Agent SDK | Each session → `session.start` with `isolated: true`; subagent (Task) → `delegate` with `spawn`; tool use → `tool.call` / `tool.result`; permission prompt → `request` |

Recipes are mappings, not drop-in code. Check the platform API before you ship.

## Mount a scene again

A page that shows one building at a time mounts a new scene for each building. A new scene starts empty, so the adapter sends the state again.

1. In `init(ctx)`, send the building state: `floor.add`, `room.add`, `bot.add`, then the state of each bot (`status`, `session.start`, `request`, `tool.call`, ...). Set `seeded: true` on each of these events.
2. Set `at` (the event time in ms) on a seeded event when you know it. A seeded event with `at` after the last time the person saw the building counts in Since you left. Without `at`, a seeded event never counts.
3. Restore a plan in progress: send `plan` after `bot.add`, with the current status of each step. Keep the step ids the same as before, so later `plan.step` events find them.
4. Send live events after that first pass, without `seeded`.

Seeded events play no sound, send no toast and no `onNotify`, and go into the replay history only when they are news (step 2). Show open requests from your own list (or the DS inbox), not from toasts.

## Send rich messages

Agents write Markdown, as in Claude, ChatGPT or Teams. The chat renders it; the 3D bubble and the activity log show plain text.

- **Text:** `text` is Markdown: links, bare URLs, bold, italic, code blocks (with a copy button), lists, task lists, quotes, tables and images. Set `format: "plain"` to show text as is.
- **Attachments:** `attachments: [{ type: "image" | "file" | "link" | "video" | "audio", url, name, size, mime, alt, title, description, site, thumb, width, height }]` on `message` and `message.agent`. Images show inline (a grid for two or more) and open in a viewer. Files show as a card with Download. Links show as a card from your data; the office fetches nothing.
- **From the user:** the composer attaches files from the attach button, a paste or a drop. The `message` command then carries `attachments` with data or blob URLs; upload them on the platform side.
- **Safety:** raw HTML never renders. Links: http, https, mailto. Images: http, https and PNG, JPEG, GIF or WebP data URLs. Send `width` and `height` for images so the chat does not jump.

## Show sessions

A session is one run or one conversation of an agent. The adapter chooses how it shows.

| Setting | Result |
| --- | --- |
| `sessions: "agent"` (default) on the building or a bot | One blob per agent. Open sessions show as a count badge over the blob and as rows in the Sessions tab of the agent panel |
| `sessions: "session"` | Each session gets its own grey blob. It arrives by the elevator, works at a seat in the agent's room and leaves when the session ends |
| `isolated: true` on one `session.start` | Only that session gets its own blob. Use it for a session with its own context that can block on a person (for example a Claude Code session or a Hermes subagent) |

Send `session.start { bot, session, title }` and `session.end { bot, session, ok, result }`. The Stop button sends the `session.stop` command.

## Let agents talk to each other

Send `message.agent { from, to, text }`. The engine picks the picture:

- **Same room, short message:** the two bots turn to each other; a speech bubble shows over the sender.
- **Same room, long message** (over 80 characters, or `walk: true`): the sender walks to the receiver, talks, and walks back.
- **Other room or floor:** an envelope rides the ceiling cable tray (and the elevator between floors) to the receiver.

Use `delegate` for work hand-offs (dashed line), and `message.agent` for talk. Set `walk: false` to keep a long message as a bubble.

## Add a Manager

The Manager is an agent: a bot with `orchestrator: true`. Messages to it go to your platform's orchestrator (Hermes main agent, Copilot Studio generative orchestration, a Claude agent with subagents). The broadcast bar lists the Manager first, so a request without a target goes to it.

If your platform has no orchestrator, use the reference Manager in `kit/manager.js`. It runs in the page and wraps your adapter.

1. Load `kit/manager.js` after `bundle.js`.
2. Wrap your adapter: `adapter: AgentOffice.manager.create({ adapter: myAdapter })`. Leave out `adapter` to wrap the mock.
3. Ask the Manager, for example: "Research the Contoso pricing, then write a summary."
4. The Manager splits the request on "then" and ";", picks the best free bot for each step by role words, and sends `assign` commands one step at a time. A step ends when its bot sends `status: "finished"` or an error, or after `timeoutMs` (default 120 s).
5. For better plans, pass `planner: async (text, bots) => [{ text, bot }]`, for example an LLM call. Keep risky steps as `request` events on the agent side.

Ask "status" to get a summary of all bots and running plans. When no bot fits a step, the Manager asks for more detail and names the teams.

## Add a role

1. Before mount: `A.office.ROLES[id] = { label, short, icon: "role-" + id, tasks: [...], asks: [...] }`.
2. Set `A.office.Work[id]` to a workstation builder. Reuse one (`A.office.Work.coder`) or write one from `kit/part.js`.
3. Add a `role-<id>` icon. Roles have icons, not colors.

## Add furniture or a workstation

Copy `kit/part.js`. Build meshes with `A.office.Parts` helpers inside a workstation builder, so the nav grid sees them and bots walk around them. Set `mesh.userData.noNav = 1` only on decor that bots may cross (rugs, lights, signs). Use `scene-*` tokens through `K.t(token)`.

## Add a solution or a theme

- **Solution:** `A.solutions[id] = { id, label, summary, building }`. Do not change the default templates.
- **Theme:** give every color and shadow token a value, plus `light-<theme>-*` and `fx-*-<theme>`. Check ContrastCheck in the new theme.
- **Office type:** not supported without an engine change. Ask for a new version of the system.

## Add a component

Use tokens only. Write a README with a props table and a "consumer provides" line, a preview with every state, types in `index.d.ts`, and a changelog row.

## Test your page

1. Screenshots: Day, Night, Sublevel; 1360, 1100 and 400 px; `quality: "low"`; reduced motion. Look at each one.
2. Walk test: `office.applyEvent({ type: "status", bot, status: "resting" })` for each bot in a room, then `"working"`. Look while they walk. For a number, use `office.inspect().nav[floor].path(from, to)`.
3. Adapter test: click Approve and check that the scene changes only after the adapter replies.
4. Run `python3 kit/check.py <your files>`. A custom property that your own files define counts as a known token. That is `--name:` in a CSS file, in an HTML `<style>` block or in an HTML `style=""` attribute, and `setProperty('--name', ...)` in a script or an HTML file. A `var(--name)` that nothing defines is an error. A name that the code builds at run time, such as `"var(--status-" + s` or `"role-" + r`, is checked by its prefix: a name that ends in "-" must start some token or icon.

## Prompt templates

**Build a page:** "Build <page> x0.1 with Agent Office DS x1.6.4. Read README, Recipes and Reference. Start from kit/page.html. Use tokens and the icon set only. Write copy in Simplified Technical English. Run kit/check.py and take the screenshots in the definition of done. Report what you checked."

**Connect a platform:** "Write an Agent Office adapter x0.1 for <platform>. Read Recipes (Connect a platform) and the events and commands in Reference. Copy kit/adapter.js. Fill the mapping tables first, then the code. Set AgentOffice.strict = true and play a recorded log. Report each event type you saw."

**Copilot Studio (paste into Copilot on your work account):** "List my Copilot Studio agents. For each one, give its connected agents, tools (connectors, agent flows, MCP, computer use), knowledge sources, triggers and channels, in a table with the columns Agent, Role, Connected agents, Tools, Knowledge, Triggers, Channels."
