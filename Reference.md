# Reference

This repo copy is the DS source. Reference.md is kept by hand in step with `kit/schema.json`, `tokens.json`, `components/index.d.ts` and the component READMEs. Machine-readable copy: `kit/schema.json`.

## Events (agent to office)

| Event | Fields | Result |
| --- | --- | --- |
| `status` | `bot`, `status`, `task?`, `quiet?` | A bot changes state. The bot walks to rest or back to its seat when needed. |
| `message` | `bot`, `text`, `say?`, `attachments?`, `format?` | A bot says something to the user: chat line and speech bubble. text is Markdown (links, images, code, tables) unless format is "plain". attachments: [{type: image | file | link | video | audio, url, name?, size?, mime?, alt?, title?, description?, site?, thumb?, width?, height?}]. |
| `message.agent` | `from`, `to`, `text`, `walk?`, `attachments?` | One agent talks to another. Same room: the bots turn to each other; a long message (over 80 characters, or walk: true) makes the sender walk over. Other room or floor: an envelope rides the cable tray or the elevator. |
| `request` | `bot`, `id?`, `text`, `actions?`, `quiet?`, `risk?`, `cost?`, `preview?`, `tool?` | A bot needs a decision. Shows in Waiting on me, the chat and a toast. Optional risk ("low", "medium" or "high"), cost, preview and tool help the user decide. |
| `error` | `bot`, `text` | A bot stopped on an error. |
| `usage` | `percent?`, `bots?`, `cost?`, `costLimit?`, `costs?` | Usage of the plan or limit, in percent. Spend is optional, in dollars: cost is the total for the goal or plan, costLimit is its limit, costs is the spend of each bot by name. The usage meter shows it. |
| `session.start` | `bot`, `session`, `title?`, `isolated?` | A session (one run or conversation) starts. With sessions: "agent" it shows as a count badge and a row in the Sessions tab; with sessions: "session" or isolated: true it gets its own grey blob from the elevator. |
| `session.end` | `bot`, `session`, `result?`, `ok?` | A session ends. Its blob, if any, first walks to its desk and sits for a short time (1.4 s), then walks back to the elevator. |
| `plan` | `bot`, `goal`, `steps` | An orchestrator makes a plan. steps: [{id, text, status?, owner?}]. A new plan replaces the plan of that bot. To restore a plan that is in progress, send `plan` again with the current status of each step (see Scene mount). |
| `plan.step` | `bot`, `id`, `status`, `owner?` | A plan step changes state. |
| `delegate` | `bot`, `to?`, `spawn?`, `roomId?`, `task?` | A bot gives a task to another bot, or spawns a temporary subagent (spawn). |
| `subagent.done` | `bot`, `result?`, `remove?` | A subagent returns its result. A temporary subagent first walks to its desk and sits for a short time (1.4 s), then leaves by the elevator. Under reduced motion, or when its floor is not on screen, it waits the same 1.4 s and then leaves with no walk. |
| `tool.call` | `bot`, `id`, `tool`, `kind?`, `args?`, `say?` | A bot calls a tool. A packet rides the cable tray. |
| `tool.result` | `bot`, `id`, `ok?`, `ms?`, `summary?`, `tokens?`, `cost?` | A tool call returns. The packet comes back in the result color. |
| `knowledge` | `bot`, `source`, `text?` | A bot reads a knowledge source. |
| `skill.load` | `bot`, `skill` | A bot loads a skill. |
| `checkpoint` | `bot`, `id`, `label`, `files?` | A bot saves a checkpoint. |
| `rollback` | `bot`, `label` | A bot rolls back to a checkpoint. |
| `trigger.run` | `job`, `bot?`, `next?` | A scheduled job or trigger runs. |
| `model` | `bot`, `model`, `fallback?` | A bot changes model, or falls back to another model. |
| `floor.add` | `floor` | Add a floor. |
| `room.add` | `floorId`, `room` | Add a room to a floor. |
| `floor.update` | `floorId`, `floor` | Rename a floor (name, key). Nothing else on it changes. |
| `room.update` | `roomId`, `room` | Rename a room, give it a new id, or change its type. Its bots stay and follow the new id. |
| `bot.add` | `roomId`, `bot` (BotDef) | Add a bot to a room. BotDef fields are listed below. |
| `bot.remove` | `bot` | Remove a bot. |

Every event can also carry these fields (`common` in `kit/schema.json`):

| Field | Type | Result |
| --- | --- | --- |
| `seeded` | `boolean?` | The event restores state that the office already had. The scene applies it, but records no history, plays no sound and sends no notification or toast. It adds no unread count and no Activity line. Since you left does not count it. |
| `at` | `number?` | The time of the event in ms (`Date.now()` form). A seeded event with `at` after the last time the person saw this building is news: the office records it at that time, it adds unread counts and Activity lines like a live event, and Since you left counts it. It still plays no sound and sends no notification or toast. |

### Scene mount

A scene keeps no state from an earlier mount. The adapter sends the state again when a scene mounts: `floor.add`, `room.add`, `bot.add`, then the state of each bot (`status`, `session.start`, `request`, `plan`, ...). This is the supported way to restore a scene.

1. Set `seeded: true` on each event of that first pass. Set `at` when you know the time of the event.
2. Restore a plan with one `plan` event that has the current status of each step. You can also send `plan` with the first status, then one `plan.step` for each step that changed. Send `plan` after `bot.add` of its bot.
3. Send each event only once for each mount. After the first pass, send live events without `seeded`. If an exact copy of a seeded event comes again in the same mount, the office records it once.

The office marks the building as seen when the page is hidden, and when the scene is disposed while the page shows. A scene disposed while the page is hidden keeps the time the page was hidden, so events that came in the meantime stay news. The next mount of the same building counts only news after that time.

## Commands (office to agent)

The office fills in `cmd.bots` with the names of the target bots.

| Command | Fields | Sent when |
| --- | --- | --- |
| `message` | `bot?`, `target?`, `targetLabel?`, `text`, `attachments?` | The user writes to one bot (bot) or broadcasts (target). attachments: images or files the user pasted, dropped or picked, as {type, url (data: or blob: or https), name, size, mime}. |
| `approve` | `bot`, `requestId?` | The user approves a request. |
| `decline` | `bot`, `requestId?` | The user declines a request. |
| `retry` | `bot` | Run the failed task again. |
| `dismiss` | `bot` | Clear an error. |
| `pause` | `bot` | Pause a bot. |
| `resume` | `bot` | Resume a bot. |
| `assign` | `bot`, `task`, `from?` | Give a bot a task. The Manager sends it for each plan step (from = the Manager). |
| `delegate` | `bot`, `to`, `task` | Ask a bot to delegate a task. |
| `rollback` | `bot`, `checkpoint` | Roll a bot back to a checkpoint. |
| `session.stop` | `bot`, `session` | Stop one session of a bot. |
| `cron.pause` | `job` | Pause a scheduled job. |
| `cron.resume` | `job` | Resume a scheduled job. |

### BotDef

The `bot` of `bot.add`. `kit/check.py --events` and `AgentOffice.validate` check each field and report a field that is not listed (a typo). A field that starts with `_` belongs to the engine.

| Field | Required | Type | Use |
| --- | --- | --- | --- |
| `name` | no | `string` | Unique name. The engine makes one when you leave it out. |
| `role` | no | `string` | A role id from `AgentOffice.office.ROLES`. Sets the workstation. |
| `shape` | no | `"blob" \| "cone" \| "octa" \| "capsule"` | Body shape. |
| `color` | no | `string` | Body color, a CSS color (not an index). The engine picks one from `AgentOffice.BODY_COLORS` when you leave it out. See "Bot colors" below. |
| `status` | no | `Status` | First state. Default `working`. |
| `task` | no | `string` | First task line. |
| `tasks` | no | `string[]` | Task lines for the mock adapter. |
| `sessions` | no | `"agent" \| "session"` | How sessions of this bot show: a badge or their own blob. |
| `orchestrator` | no | `boolean` | True for a Manager. |
| `ephemeral` | no | `boolean` | True for a temporary bot, such as a subagent. It leaves by the elevator. |
| `platform` | no | `string` | Platform name for the agent card, for example `Claude Code`. |
| `identity` | no | `string` | Identity for the agent card, for example a folder. |
| `owner` | no | `string` | Owner for the agent card. |
| `model` | no | `string` | Model name. |
| `fallback` | no | `string` | Fallback model name. |
| `tools` | no | `string[]` | Tool names for the agent card. |
| `knowledge` | no | `string[]` | Knowledge sources for the agent card. |
| `skills` | no | `string[]` | Skills for the agent card. |
| `channels` | no | `string[]` | Channels for the agent card. |
| `triggers` | no | `string[]` | Trigger names for the agent card. |
| `cost` | no | `string` | Cost text for the agent card. |
| `word` | no | `string` | Status word for the page. The DS keeps it and does not show it. |
| `usage` | no | `number` | Engine field. Share of the weekly limit that this bot used, in percent. The `usage` event sets it. A page can send it to restore a bot. |
| `parent` | no | `string` | Engine field. Name of the bot that made this helper. `delegate` and `session.start` set it. |
| `session` | no | `string` | Engine field. Id of the session that this helper bot shows. |

## Office API

`onReady(office)` in React, or the return value of `AgentOffice.office.mount(el, opts)`: `addBot`, `addFloor`, `addRoom`, `all`, `applyEvent`, `approve`, `approveMany`, `bots`, `broadcast`, `byBot`, `chatOf`, `connect`, `cost`, `decline`, `declineMany`, `dispose`, `errors`, `ev`, `events`, `finished`, `floor`, `focusRoom`, `getBuilding`, `history`, `inspect`, `message`, `messages`, `quality`, `removeBot`, `replay`, `retry`, `right`, `screenPos`, `select`, `send`, `sessions`, `setFloor`, `setFrameInset`, `setSound`, `setView`, `speed`, `stage`, `stopReplay`, `stopSession`, `summary`, `to`, `tokens`, `toolCalls`, `top`, `validate`, `visible`, `waiting`, `y`, `zoom`.

- `zoom(factor)`: zoom by a factor (the HUD + and - buttons use 1.2 and 1/1.2). The zoom stays inside the controls' `minZoom` and `maxZoom` (0.4 and 4 by default). A step never goes the wrong way: when a framed view is past the limit, + keeps the zoom. Returns the new zoom.
- Camera moves (`setView`, `setFloor`, `focusRoom`, `setFrameInset`) glide for `duration-camera`. With `prefers-reduced-motion` they cut, and a floor change shows the new floor at once. Each move still sets `stage.goal` (`office.inspect().stage`), and the next frame ends it. So a page that holds `stage.goal` back, for example while an item is in focus, holds the cut too.
- `dispose()` frees the GPU memory of the stage: every geometry, material and texture in the scene (also the ones the page added), the Kit caches, the light shadows and the post effects. Then it frees the renderer and its WebGL context. It is safe to call twice. It frees nothing that another live stage still uses.
- `stage.clear(group)` takes a group out of the scene at once and frees its GPU memory after the next frame. What the scene and the Kit caches (`K.tex`, `K.mats`) still use then stays, so a page can build again in the same frame from the same materials and textures. A theme change frees the old Kit textures.

Globals: `AgentOffice.BODY_COLORS` (the 10 bot body colors, a frozen array), `AgentOffice.BOT_COLORS` (one portrait color for each shape), `AgentOffice.money(n)` (the DS money format), `AgentOffice.validate(event)`, `AgentOffice.schema`, `AgentOffice.strict`, `AgentOffice.adapters.create`, `AgentOffice.adapters.mock`, `AgentOffice.solutions`, `AgentOffice.office.ROLES`, `.Work`, `.Parts`, `.helpers`, `.Nav`. `components/index.d.ts` types them: `AgentOfficeGlobals`, set on `window.AgentOffice`.

### Bot colors

| Global | What it is | Use it when |
| --- | --- | --- |
| `BODY_COLORS` | An array of 10 body colors. The scene gives them to new bots in this order (`BODY_COLORS[n % 10]`). | You set `bot.color`, or you draw a bot in a list. This is the bot color. |
| `BOT_COLORS` | An object with one color for each shape: `blob`, `cone`, `octa`, `capsule`. These are the first 4 entries of `BODY_COLORS`. `PORTRAITS[shape]()` uses it when you pass no color. | You draw a portrait of a shape and have no bot. Do not use it for the color of a bot in the scene: 4 colors repeat too soon. |

`bot.color` stays a CSS color. It is not an index, so `{ color: 3 }` is not valid. To use a palette slot, write `BODY_COLORS[n % BODY_COLORS.length]`. A page that kept `BOT_COLORS` for bot colors can switch to `BODY_COLORS`, and its bots then match the scene. Pick the slot from a stable key, such as a hash of the session id.

### Money

`AgentOffice.money(n)` is the one money format of the DS. UsageMeter, CostMeter and DecisionInbox use it: `$0.26`, `$12.00`, and `<$0.01` for a cost above zero and under one cent. A string passes through, so `cost: "about $1"` shows as written. `OfficeFormat.money` in a page can follow the same rules.

## Components

| Component | Group | What it is |
| --- | --- | --- |
| `ActivityLog` | Feeds | The newest events first: time, bot, and what changed. |
| `AddButton` | Actions | A dashed, full-width button that adds one thing to a list: a floor, a room or a bot. |
| `AgentCard` | Governance | One agent's identity and reach: platform, owner, identity, model (and fallback), tools, knowledge, skills, channels, triggers and cost. |
| `AgentChat` | Conversation | The conversation with one bot: header with portrait, status line and role, the message log, quick actions, and a text box. |
| `AgentPanel` | Orchestration | The panel that opens when you select a bot: a header with the bot, its role badges and model, then tabs: Chat, Trace, Sessions and Agent. Add or hide tabs with `extraTabs` and `hideTabs`. Control the open tab with `activeTab`. |
| `AgentRegistry` | Governance | The inventory of every agent: platform, identity, model, tool count, access scope and last run. |
| `AmbientBar` | Daily | A thin status strip for a second screen or a narrow window. |
| `ApprovalItem` | Queues | One request in Waiting on me. |
| `BotAvatar` | Roster | A flat portrait of a bot for use outside the 3D scene: lists, notifications, docs. |
| `BotLineup` | 3D parts | The four bot shapes (blob, cone, octa, capsule) with their status bubbles, on a plinth. |
| `BotRow` | Roster | One bot in the roster: portrait in its shape and body color with a status dot, name, role icon, and the status line `State · Task`. |
| `BroadcastBar` | Conversation | Send one message to many bots: a room, a floor or every floor. |
| `BuildingView` | 3D office | The building at a glance: every floor stacked, every room as a glass box with its office-type stripe, and every bot as a status pip that bobs while it works. |
| `Button` | Actions | A compact action. |
| `ChannelList` | Orchestration | Where requests come in and which agent each channel routes to: Hermes gateway platforms (CLI, Discord, API server, IDE) or Copilot channels (Teams, Microsoft 365 Copilot, website, email). |
| `ChatMessage` | Conversation | One message in a chat. |
| `CheckpointTimeline` | Orchestration | Snapshots an agent took before it changed files or data. |
| `ColorRatio` | Docs | The 60-30-10 rule, live in the current theme: 60% neutrals, 30% structure, 10% emphasis. |
| `CommandPalette` | Daily | A search box for the whole office. |
| `ContrastCheck` | Docs | Live contrast for the key token pairs, measured in this page's theme. |
| `CopilotOffice` | Solutions | The Copilot Studio office. |
| `CostMeter` | Orchestration | Tokens, cost and cache hit rate for a run or an agent. |
| `DecisionInbox` | Daily | All open requests in one list, highest risk first. |
| `DelegationTree` | Orchestration | The orchestrator and the agents it delegated to, as a tree, with the concurrency slots (Hermes runs 3 subagents at a time by default). |
| `Dialog` | Feedback | A modal for a decision that needs full attention, for example Remove bot or Disconnect agents. |
| `DoAndDont` | Docs | The main rules as pairs. |
| `EmptyState` | Feedback | What a panel shows when it has nothing: an icon, a title that says what is true, a line that says what to do, and at most one action. |
| `FloorHeader` | Navigation | The colored head of the roster panel. |
| `FloorList` | Navigation | The list of floors, top floor first. |
| `Foundations` | Docs | Motion, layers, breakpoints and 3D units in one place. |
| `HermesOffice` | Solutions | The Hermes orchestrator office. |
| `Icon` | Foundations | The icon set: 34 line icons on a 24px grid with a 1.75px stroke, round caps and joins. |
| `Logo` | Foundations | The Agent Office mark, wordmark and lockup. |
| `ModeToggle` | Actions | A segmented control for the scene mode: Day, Night, Sublevel, Tour. Each option has an icon. |
| `ModelBadge` | Orchestration | The model an agent runs on. |
| `Notifier` | Daily | Alerts for a person who works in another tab. |
| `OfficeScene` | 3D office | The 3D office itself and the main component of the system. |
| `OfficeTypeBadge` | Office types | A chip that names an office type with its icon and type color. |
| `OfficeTypeCard` | Office types | A flat picture and badge for one office type. |
| `Panel` | Surfaces | The glass surface for every HUD block over the 3D scene. |
| `PlanCard` | Orchestration | The orchestrator's plan: the goal, each step with its status and owner, and steps done over total. |
| `RichText` | Conversation | Safe Markdown for one chat message. |
| `RoleBadge` | Office types | A quiet chip that names a bot role with its icon. |
| `RoomList` | Navigation | The rooms on the current floor: type icon, name, type, and working over total. |
| `RoomScene` | 3D office | One floor with rooms you choose, without the HUD. |
| `RunTrace` | Orchestration | The steps of a run in order: skill loads, plans, delegations, tool calls (with arguments and results), knowledge reads, checkpoints and model fallbacks. |
| `ScheduleList` | Orchestration | Cron jobs and event triggers: name, when, the agent, the next run, and Pause or Resume. |
| `Select` | Forms | A styled native select with a label, a hint and an error. |
| `SessionList` | Orchestration | The sessions of one agent: each run or conversation, newest first, with its state, times and result. |
| `SinceYouLeft` | Daily | A summary card for the person who comes back. |
| `Skeleton` | Feedback | A placeholder while data loads: the roster before the adapter answers, or the chat before history arrives. |
| `SolutionCard` | Solutions | A solution template: a ready-made building for one kind of customer work. |
| `SolutionOffice` | Solutions | The Microsoft customer solutions office: the roles that take a customer from first call to value, as agents. |
| `StatusBubble` | Status | The bubble above a bot in the 3D scene, drawn here as a flat reference for the sprite. |
| `StatusCounts` | Summary | The summary strip of the whole office. |
| `StatusDot` | Status | An 8px dot for one bot status. |
| `SublevelOffice` | Themes | The office in the Sublevel theme: a quiet, retro corporate floor under cool fluorescent light. |
| `Tabs` | Navigation | Switch between views in one panel, for example Floor, Waiting and Activity in the phone sheet. |
| `TextInput` | Forms | A single-line text field with a label, a hint and an error. |
| `TimeScrubber` | Daily | A replay bar for the office history. |
| `Toast` | Feedback | A short message that something happened that the person did not start: a bot needs a decision, a bot failed, or a command could not be sent. |
| `ToolCall` | Orchestration | One tool call: status, tool name, kind (MCP, connector, code, terminal, browser, computer use, agent flow, knowledge, skill, memory, API) and time. |
| `ToolKindBadge` | Orchestration | The kind of a tool, with its icon. |
| `Tooltip` | Foundations | A short label that shows on hover and on keyboard focus. |
| `UsageMeter` | Feeds | The weekly usage limit: one figure, one bar, and the four bots that use the most. Optional spend and spend limit. Without `percent`, it shows spend only, titled "Spend". `title` sets another title. |
| `ViewToggle` | Actions | Switches between the building view and the floor view. |
| `Workstations` | 3D parts | The nine role workstations. |

Each README has the full props table. Types: `components/index.d.ts`.

## Tokens

### color

| Token | light | dark | sublevel | Use |
| --- | --- | --- | --- | --- |
| `bg` | `#e9edf1` | `#10141a` | `#dfe6e1` | Page and 3D scene background behind every panel. |
| `panel` | `rgba(255,255,255,0.86)` | `rgba(24,30,38,0.86)` | `rgba(246,248,245,0.93)` | Glass HUD panels over the 3D scene. Always pair with blur-panel. |
| `chip` | `#f1f4f7` | `#1f2630` | `#e7ece8` | Hover, selected row, pressed segment, quiet button fill. |
| `line` | `rgba(30,45,60,0.10)` | `rgba(200,215,230,0.10)` | `rgba(20,60,50,0.16)` | Panel borders and dividers. Hairline only. |
| `ink` | `#18212b` | `#e6ebf0` | `#102a33` | Primary text on bg, panel and chip. |
| `muted` | `#5f6b78` | `#8e9aa7` | `#4d6660` | Secondary text: task lines, timestamps, counts. 4.6:1 or more on bg, panel and chip. |
| `accent` | `#2f6fe4` | `#6c9dff` | `#1f6f8b` | Primary action (Approve, Retry), focus ring, routine markers. |
| `on-accent` | `#ffffff` | `#0d1420` | `#ffffff` | Text on accent. |
| `emphasis` | `{accent}` | `{accent}` | `#b5302b` | The 10% color: alerts and the one key action in a decision (Approve on a request, unread counts, room alert beacons). In Day and Night it equals accent; in Sublevel it is red. Never a fill larger than a button. |
| `on-emphasis` | `{on-accent}` | `{on-accent}` | `#ffffff` | Text on emphasis. |
| `on-status` | `#ffffff` | `#ffffff` | `#ffffff` | Text and glyphs on a status fill (danger button, check in the finished bubble). |
| `bubble` | `#ffffff` | `#f2f5f8` | `#f6f8f5` | Fill of status bubbles and speech bubbles over bots, in 2D and 3D. |
| `status-working` | `#1f9a58` | `#2fb36d` | `#1d8a5a` | Bot is working. Dot, bubble glyph, monitor glow. |
| `status-waiting` | `#c27c17` | `#e3992f` | `#b07514` | Bot needs a human decision. Always shows in Waiting on me. |
| `status-error` | `#d1403b` | `#e5605b` | `#c23b36` | Bot failed. Always shows in Waiting on me with Retry. |
| `status-resting` | `#78818b` | `#8a939d` | `#7f8c8a` | Bot is idle in the lounge. |
| `status-finished` | `#3b74e0` | `#5b93f5` | `#2f6bc8` | Bot finished a task; check bubble at the desk. |
| `status-working-text` | `#197a46` | `#2fb36d` | `#18734b` | Text color for the working status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-working. |
| `status-waiting-text` | `#945f12` | `#e3992f` | `#895b10` | Text color for the waiting status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-waiting. |
| `status-error-text` | `#c4332e` | `#e6645f` | `#b63733` | Text color for the error status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-error. |
| `status-resting-text` | `#646b74` | `#8a939d` | `#5d6765` | Text color for the resting status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-resting. |
| `status-finished-text` | `#2363dc` | `#5b93f5` | `#2c63ba` | Text color for the finished status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-finished. |
| `status-working-on-bubble` | `#1b854c` | `#217e4d` | `#1b7f53` | Text color for the working status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-waiting-on-bubble` | `#a46913` | `#9a6315` | `#996611` | Text color for the waiting status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-error-on-bubble` | `#d1403b` | `#d42822` | `#c23b36` | Text color for the error status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-resting-on-bubble` | `#6e7780` | `#666f7a` | `#677371` | Text color for the resting status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-finished-on-bubble` | `#3771df` | `#1565f1` | `#2f6bc8` | Text color for the finished status on bubble (a light face in every theme). 4.5:1 or more. |
| `floor-ops` | `#4a6278` | `#587089` | `#3f5d70` | Floor 1 identity. Roster header fill, building-view floor band; white text on it. |
| `floor-sales` | `#b5523b` | `#b5523b` | `#5d4a7a` | Floor 2 identity. Roster header fill; white text on it. |
| `floor-research` | `#2f7f44` | `#2f7f44` | `#2c6b57` | Floor 3 identity. Roster header fill; white text on it. |
| `floor-content` | `#7a52c7` | `#7a52c7` | `#2f5f86` | Floor 4 identity. Roster header fill; white text on it. |
| `floor-hq` | `#8a5a12` | `#8a5a12` | `#7a5414` | Floor 5 (HQ) identity. Roster header fill; white text on it. |
| `on-floor` | `#ffffff` | `#ffffff` | `#ffffff` | Text on any floor-* fill. 4.9:1 or more. |
| `scrim` | `#0a1016` | `#0a1016` | `#0a1016` | Dark veil behind a dialog or the command palette. Mix it with transparent: color-mix(in srgb, var(--scrim) 45%, transparent). |
| `type-team` | `#3a7ca5` | `#5f9fc8` | `#2f6b7a` | Office type: team floor. Type badge dot, room icon, the stripe on the room floor edge. |
| `type-lab` | `#0f8b8d` | `#2fb3b5` | `#0f7f7c` | Office type: lab / server room. |
| `type-studio` | `#c2477a` | `#e0709a` | `#b03f6e` | Office type: studio. |
| `type-hq` | `#a36a12` | `#d0922e` | `#946010` | Office type: war room / HQ. |
| `scene-floor` | `#f3f2ee` | `#2a3039` | `#2f6456` | 3D floor slab top. |
| `scene-wall` | `#e3e6ea` | `#232a34` | `#e9ede7` | 3D back wall. |
| `scene-wood` | `#d8b98a` | `#8f7656` | `#f1f1ea` | 3D desk tops and side tables. |
| `scene-chair` | `#2f5d4a` | `#24493b` | `#1c2326` | 3D chairs and sofas. |
| `scene-rug` | `#c0563f` | `#a8483a` | `#2a5560` | 3D lounge rug. Marks the resting zone. |
| `scene-wall-side` | `#d9dde2` | `#1e242d` | `#e2e7e2` | 3D left wall. One step darker than scene-wall so the corner reads. |
| `scene-slab` | `#c9ced4` | `#1b2028` | `#b9c4bf` | 3D floor slab edge and kit plinths. |
| `scene-rail` | `#ffffff` | `#59616c` | `#f4f6f2` | 3D front railing slats. |
| `scene-sofa` | `#2f5f52` | `#24493b` | `#2c5b6b` | 3D lounge sofas. |
| `scene-metal` | `#9aa2ab` | `#6f7884` | `#b8c0bf` | 3D desk pedestals and bases. |
| `scene-dark` | `#2b323b` | `#2b323b` | `#263238` | 3D monitors, lamps, racks, tripods. |
| `scene-glass` | `#bcd3e6` | `#3d5468` | `#cfe3e0` | 3D glass partitions between rooms and the room boxes in the building view. Used at 22–28% opacity. |
| `scene-subagent` | `#9aa3ad` | `#6f7884` | `#b9c4bf` | 3D body of a temporary subagent. Grey so it reads as on loan; it leaves when it returns. |

#### Contrast pairs the DS checks

`test/contrast.test.mjs` measures these pairs in Day, Night and Sublevel. A page can check its own uses against the same list. Card = `panel` over `bg`.

| Foreground | Background | Needs | Use |
| --- | --- | --- | --- |
| `ink` | `bg`, card, `chip` | 4.5:1 | Primary text. |
| `muted` | `bg`, card, `chip` | 4.5:1 | Secondary text. |
| `status-*-text` | `bg`, card, `chip` | 4.5:1 | A status word on a theme surface. |
| `status-*-on-bubble` | `bubble` | 4.5:1 | A status word on a bubble or a whiteboard face. |
| `status-*` | card | 3:1 | Status dot, next to a word. |
| `status-*` | any | not checked at 4.5:1 | Do not use it as text color. It is a fill and a dot. Use `status-*-text` or `status-*-on-bubble`. |

### spacing

| Token | Value | Use |
| --- | --- | --- |
| `space-1` | `4px` | Pip gaps, icon-to-text in dots. |
| `space-2` | `8px` | Gap between panels in a column; row gap. |
| `space-3` | `12px` | Panel inner padding (sides). |
| `space-4` | `16px` | Screen gutter. Minimum on phones. |
| `space-5` | `24px` | Gap between HUD columns and the scene edge on wide screens. |
| `space-6` | `32px` | Section gaps in docs and cards. |

### radius

| Token | Value | Use |
| --- | --- | --- |
| `radius-sm` | `6px` | Buttons, floor number badge. |
| `radius-md` | `8px` | Rows, segments. |
| `radius-lg` | `12px` | Panels. |
| `radius-full` | `9999px` | Status dots, avatars, bubbles. |

### shadow

| Token | Value | Use |
| --- | --- | --- |
| `shadow-panel` | `{"light": "0 6px 24px rgba(10,20,30,0.08)", "dark": "0 6px 24px rgba(0,0,0,0.35)", "sublevel": "0 1px 0 rgba(16,42,51,0.10)"}` | Every floating HUD panel. Nothing else casts a shadow. |

### blur

| Token | Value | Use |
| --- | --- | --- |
| `blur-panel` | `14px` | backdrop-filter on every panel so the scene shows through. |

### opacity

| Token | Value | Use |
| --- | --- | --- |
| `opacity-glass` | `0.25` | 3D glass partitions and building-view room boxes. |
| `opacity-resting` | `0.7` | Status bubble of a resting bot. |

### zIndex

Layers from back to front. Use only these values.

| Token | Value | Use |
| --- | --- | --- |
| `z-scene` | `0` | The 3D canvas. |
| `z-tag` | `5` | Labels drawn over the scene. |
| `z-hud` | `10` | HUD panels over the scene. |
| `z-sheet` | `20` | Phone bottom sheet, pickers and menus. |
| `z-toast` | `30` | Toasts. |
| `z-tooltip` | `40` | Tooltips. |
| `z-dialog` | `50` | Dialog and its overlay. |

### duration

Motion durations in ms. The 3D engine reads duration-floor, duration-camera, duration-speech, duration-handoff, duration-tool-label, duration-elevator, duration-packet and duration-intro.

| Token | Value | Use |
| --- | --- | --- |
| `duration-instant` | `80ms` | Hover and press feedback. |
| `duration-fast` | `160ms` | Chips, toggles, tooltips. |
| `duration-base` | `240ms` | Panels, chat open, toasts in. |
| `duration-floor` | `450ms` | A floor rises into view. Read by the 3D engine. |
| `duration-camera` | `600ms` | The camera glides to a floor, a room or the building. Read by the 3D engine. |
| `duration-speech` | `5500ms` | A speech bubble stays over a bot. Read by the 3D engine. |
| `duration-handoff` | `2600ms` | A hand-off line flies and fades between two bots. Read by the 3D engine. |
| `duration-tool-label` | `1800ms` | A tool name stays over a bot. Read by the 3D engine. |
| `duration-toast` | `6000ms` | A toast stays on screen. |
| `duration-elevator` | `1100ms` | The elevator ride between two floors. Read by the 3D engine. |
| `duration-packet` | `1300ms` | A tool-call packet rides the cable tray one way. Read by the 3D engine. |
| `duration-intro` | `2800ms` | The intro flythrough from the tower to the first floor. Read by the 3D engine. |
| `duration-fly` | `420ms` | A bot portrait flies from the scene into the agent panel. |

### easing

Easing curves. Use ease-out for things that arrive, ease-in for things that leave.

| Token | Value | Use |
| --- | --- | --- |
| `ease-out` | `cubic-bezier(0.33, 1, 0.68, 1)` | Floors, panels and toasts that arrive. |
| `ease-in` | `cubic-bezier(0.32, 0, 0.67, 0)` | Things that leave. |
| `ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | State changes in place. |
| `ease-walk` | `linear` | Bots walking on the aisle. |

### breakpoint

Layout breakpoints for the office HUD (container width).

| Token | Value | Use |
| --- | --- | --- |
| `bp-phone` | `820px` | At this width and below: floor chips, one bottom sheet, no room list, queue, log, broadcast or usage. |
| `bp-compact` | `1100px` | At this width and below: the activity log hides and the broadcast bar moves left. |
| `bp-wide` | `1360px` | The reference width for previews and the full HUD. |

### scene

3D layout in scene units (1 unit is about 0.5 m). The engine reads these on mount.

| Token | Value | Use |
| --- | --- | --- |
| `scene-depth` | `12` | Room depth. |
| `scene-pitch` | `4.6` | Distance between workstations in a row. |
| `scene-gap` | `2.6` | Gap between rooms on a floor. |
| `scene-floor-gap` | `4.2` | Height between floors in the building view. |
| `scene-handoff-dash` | `0.35` | Dash length of the hand-off line. |
| `scene-handoff-gap` | `0.2` | Gap length of the hand-off line. |
| `scene-wall-h` | `5.2` | Wall height. |
| `scene-bot-h` | `1.1` | Bot height. Desk top 0.95, seat 0.6. |
| `scene-nav-pad` | `0.45` | Clearance between a walking bot and any object. The nav grid grows every obstacle by this value. |
| `scene-nav-cell` | `0.25` | Cell size of the nav grid that bots path on. |

### light

3D light levels for each theme (0 to 2). The engine reads these.

| Token | Value | Use |
| --- | --- | --- |
| `light-day-sky` | `0.75` | Sky light in Day. |
| `light-day-sun` | `0.9` | Sun in Day, from the front right. |
| `light-day-lamp` | `0` | Room lamps in Day: off. |
| `light-night-sky` | `0.2` | Sky light in Night. |
| `light-night-sun` | `0.14` | Moon in Night. |
| `light-night-lamp` | `1.6` | Warm room lamps in Night. |
| `light-sublevel-sky` | `0.78` | Fluorescent fill in Sublevel. |
| `light-sublevel-sun` | `0.38` | Ceiling key light in Sublevel, from above. |
| `light-sublevel-lamp` | `0` | Room lamps in Sublevel: off. |

### fx

3D post effects (0 to 2). The engine reads these on mount and when the theme changes. Quality "low" turns post effects off.

| Token | Value | Use |
| --- | --- | --- |
| `fx-bloom-day` | `0.12` | Bloom strength in Day. |
| `fx-bloom-night` | `0.7` | Bloom strength in Night: screens, lamps, windows, packets and beacons glow. |
| `fx-bloom-sublevel` | `0.25` | Bloom strength in Sublevel. |
| `fx-threshold-day` | `1.3` | Light level where bloom starts in Day. Above white, so walls do not glow. |
| `fx-threshold-night` | `0.8` | Light level where bloom starts in Night. |
| `fx-threshold-sublevel` | `1.15` | Light level where bloom starts in Sublevel. |
| `fx-exposure-day` | `1` | Exposure in Day. |
| `fx-exposure-night` | `1.08` | Exposure in Night. |
| `fx-exposure-sublevel` | `1` | Exposure in Sublevel. |
| `fx-fog-day` | `0` | Depth haze in Day: off. |
| `fx-fog-night` | `0.3` | Depth haze in Night, in the bg color. |
| `fx-fog-sublevel` | `0.12` | Depth haze in Sublevel. |
| `fx-bloom-radius` | `0.45` | Bloom spread. |
| `fx-knee` | `0.82` | Highlight roll-off: light above this level compresses softly, light below keeps the token color. |
| `fx-vignette-day` | `0` | Corner darkening in Day: off, so the scene edge meets the page bg. |
| `fx-vignette-night` | `0.18` | Corner darkening in Night. |
| `fx-vignette-sublevel` | `0.06` | Corner darkening in Sublevel. |

### font families

- `font-sans`: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif
- `font-mono`: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace
- `font-term`: "VT323", "IBM Plex Mono", ui-monospace, monospace
- `font-sublevel-sans`: "Archivo", "IBM Plex Sans", system-ui, sans-serif
- `font-sublevel-mono`: "Chivo Mono", "IBM Plex Mono", ui-monospace, monospace

## Icons

`add`, `approve`, `attach`, `bell`, `bot`, `broadcast`, `browser`, `building`, `channel`, `chat`, `checkpoint`, `chevron-down`, `chevron-right`, `close`, `code-run`, `computer-use`, `connector`, `copy`, `cost`, `day`, `decline`, `delegate`, `elevator`, `error`, `eval`, `filter`, `finished`, `floor`, `flow`, `hq`, `identity`, `info`, `knowledge`, `lab`, `mcp`, `memory`, `model`, `more`, `night`, `pause`, `plan`, `remove`, `resting`, `resume`, `retry`, `role-ae`, `role-analyst`, `role-coder`, `role-csa`, `role-csam`, `role-designer`, `role-fde`, `role-media`, `role-ops`, `role-partner`, `role-planner`, `role-research`, `role-sales`, `role-se`, `role-specialist`, `role-writer`, `rollback`, `room`, `schedule`, `search`, `send`, `session`, `settings`, `skill`, `sound`, `sound-off`, `studio`, `subagent`, `team`, `terminal`, `token`, `tool`, `tour`, `trace`, `trigger`, `waiting`, `working`, `zoom-in`, `zoom-out`
