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
| `session.start` | `bot`, `session`, `title?`, `isolated?` | A session (one run or conversation) starts. With sessions: "agent" it shows as a count badge and a row in the Sessions tab; with sessions: "session" or isolated: true it gets its own grey blob from the elevator. The blob is a temporary bot, so it walks at the helper speed (`scene-walk-speed-ephemeral`). |
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
| `room.add` | `floorId`, `room` | Add a room to a floor. A room of type security has no bots and six wall screens that a page repaints; room.screens gives their six titles. |
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
| `ephemeral` | no | `boolean` | True for a temporary bot, such as a subagent. It leaves by the elevator and walks at `scene-walk-speed-ephemeral`. A session blob is ephemeral too. |
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
- `dispose()` frees the GPU memory of the stage: every geometry, material and texture in the scene (also the ones the page added), the Kit caches, the light shadows and the post effects. Then it frees the renderer and its WebGL context. It is safe to call twice. It frees nothing that another live stage still uses, with one exception: the post effects share one full-screen triangle geometry between all stages, and `dispose()` frees it. A stage that still draws uploads it again on its next frame, so nothing shows. If a free throws, the other frees still run: the renderer, its WebGL context and its canvas are freed, and then the first error reaches the caller.
- `stage.clear(group)` takes a group out of the scene at once and frees its GPU memory after the next frame. What the scene and the Kit caches (`K.tex`, `K.mats`) still use then stays, so a page can build again in the same frame from the same materials and textures. A theme change frees the old Kit textures.

Globals: `AgentOffice.MODES` (the themes, see Themes below), `AgentOffice.modeOf(theme)` (the MODES entry of a `data-theme` value; a value that is no theme gets the first entry), `AgentOffice.PORTRAITS[shape](color, look?)` (a bot portrait as an SVG string; see Skins), `AgentOffice.officePicture(type, tok, style)` and `AgentOffice.OFFICE_PICTURES` (the office type pictures; see Skins), `AgentOffice.LOGO` (`mark(ink, dot, radius)` and `wordmarks`), `AgentOffice.office.LOOKS`, `.FX` and `.WINDOWS` (the scene part of each theme; see Skins), `AgentOffice.BODY_COLORS` (the 10 bot body colors, a frozen array), `AgentOffice.BOT_COLORS` (one portrait color for each shape), `AgentOffice.money(n)` (the DS money format), `AgentOffice.validate(event)`, `AgentOffice.schema`, `AgentOffice.strict`, `AgentOffice.adapters.create`, `AgentOffice.adapters.mock`, `AgentOffice.solutions`, `AgentOffice.office.ROLES`, `.Work`, `.Parts`, `.helpers`, `.Nav`. `components/index.d.ts` types them: `AgentOfficeGlobals`, set on `window.AgentOffice`.

### Themes

`AgentOffice.MODES` is the one list of themes, in the order of the themes of `tokens.json`. The scene engine, `ModeToggle` (its default options), the `OfficeScene` HUD toggle, the command palette and the drawn parts (`Logo`, `OfficeTypeCard`) read it. A page that shows its own theme control reads it too and keeps no copy. Read it; do not change it. Every entry has every field.

| `id` (look) | `theme` (`data-theme`) | `label` | `icon` | `dark` | `retro` | `wordmark` | Look |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `day` | `light` | Day | `day` |  |  | `sans` | Daylight office; the sun follows the clock. |
| `night` | `dark` | Night | `night` | `true` |  | `sans` | Dark office, warm room lamps, glow and fog. |
| `sublevel` | `sublevel` | Sublevel | `terminal` |  | `true` | `wide` | Retro corporate floor under fluorescent light. |
| `fluent` | `fluent` | Fluent | `fluent` |  |  | `sans` | Bright, quiet office in soft daylight, low bloom and light haze. System faces, 4 px controls and 8 px panels. |
| `fluent-dark` | `fluent-dark` | Fluent Dark | `fluentdark` | `true` |  | `sans` | Fluent at night: a dim, neutral office with soft room lamps, screen glow and a dusk window. The faces, corners, heads and accent pills of Fluent. |

The `id` names the look: the engine reads `light-<id>-*` and `fx-*-<id>`, and `AgentOffice.office.LOOKS[id]`. A `data-theme` value that is no theme shows the first look (Day).

- `dark: true` marks a dark scene (Night, Fluent Dark): the window shows a night or dusk sky with lit windows, monitors glow more, the page lays a pool of screen light on each desk, the office type pictures show lit screens and lamp pools, and `tokens.css` sets `color-scheme: dark` in the theme's block, so the browser draws scrollbars and check boxes dark. The engine sets `stage.K.dark` from it.
- `retro: true` (Sublevel) draws the office type pictures in the retro style: terminal desks with number grids, carpet tiles, a wainscot band, square-eyed bots.
- `wordmark` names the theme's wordmark drawing in `AgentOffice.LOGO.wordmarks`: `sans` (IBM Plex Sans) or `wide` (Archivo, capitals).

A theme can be a variant of another: its id is `<family>-<variant>` (Fluent Dark is `fluent-dark`). `bundle.css` and the page's own style sheet set the look of a family once, on `[data-theme|="<family>"]`, which matches the family id and every `<family>-*` id (Sublevel is `[data-theme|="sublevel"]`, Fluent and Fluent Dark `[data-theme|="fluent"]`). No style rule names one theme with `[data-theme="<id>"]`. Each variant has its own colors in `tokens.css`.

### Skins

A skin (a theme) is a token set plus a component set. Code reads the skin only through its tokens and its entries in `AgentOffice.MODES` and `AgentOffice.office.LOOKS`, and never compares a look or theme id with a string. Every skin has its own variant of each themed part, and no part falls back to the part of another skin. `test/skin.test.mjs` runs the same checks for every theme of `tokens.json` (Recipes, "Add a theme", lists the parts in its order).

| Part | Comes from |
| --- | --- |
| Colors, shadow, light, effects, faces, corners | The theme's tokens (`tokens.json`, `tokens.css`; faces and corners through a family rule in `bundle.css`). |
| Bot portraits (`BotAvatar`) | One drawing per shape (`AgentOffice.PORTRAITS`), styled by the theme's `portrait-*` tokens through the `ao-pt-*` classes of `bundle.css`. For a file in a theme, pass `look = { ink, gloss, outline, eyesSquare }`, the theme's token values. |
| Logo | The mark takes `ink`, `bg` and `logo-mark-radius`; the wordmark is the drawing that the MODES entry names (`wordmark`). |
| Office type pictures (`OfficeTypeCard`) | `AgentOffice.officePicture(type, tok, { dark, retro })`: one drawing per type, colored by the theme's scene, type and status tokens; `dark` and `retro` come from the MODES entry. `OfficeTypeCard` reads the tokens of the theme it sits in. `AgentOffice.OFFICE_PICTURES` lists the types. |
| Mode icon | The `icon` of the MODES entry, from the icon set. Each theme has its own. |
| Scene look | `AgentOffice.office.LOOKS[id]`: `hi`, `si`, `lamp` (from the `light-*` tokens), `hc`, `hg`, `sc` (sky, ground and sun light colors), `sp` (sun position), `win` (the window picture, a name of `AgentOffice.office.WINDOWS`: `sky`, `stars`, `corridor`, `clouds`, `dusk`), `frame` (window frame color), `leaf` (plant leaf color), `beacon` (the two tokens of the room alert beacon: for a request, for an error), `clock` (the sun follows the clock), `flicker` (the fill light flickers now and then), `caps` (signs and wall screen titles in capitals; the engine sets `stage.K.caps`), `term` (desk monitors in the terminal face; `stage.K.term`, which the page's desk terminals read too). `AgentOffice.office.FX` holds the post effects of each look, from the `fx-*` tokens. |

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
| `BotAvatar` | Roster | A flat portrait of a bot for use outside the 3D scene: lists, notifications, docs. One drawing per shape; the `portrait-*` tokens of the theme style it. |
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
| `FluentOffice` | Themes | The office in the Fluent theme: a bright, quiet office in soft daylight, with neutral greys, a blue accent, small round corners and the system faces. With `theme: "fluent-dark"` it shows Fluent Dark: the same look at night. |
| `Foundations` | Docs | Motion, layers, breakpoints and 3D units in one place. |
| `HermesOffice` | Solutions | The Hermes orchestrator office. |
| `Icon` | Foundations | The icon set: 86 line icons on a 24px grid with a 1.75px stroke, round caps and joins. |
| `Logo` | Foundations | The Agent Office mark, wordmark and lockup, in the theme it sits in: the mark takes `logo-mark-radius`, the wordmark is the one the theme's MODES entry names. |
| `ModeToggle` | Actions | A segmented control for the scene mode: Day, Night, Sublevel, Fluent, Fluent Dark and Tour (`AgentOffice.MODES` plus Tour). Each option has an icon. |
| `ModelBadge` | Orchestration | The model an agent runs on. |
| `Notifier` | Daily | Alerts for a person who works in another tab. |
| `OfficeScene` | 3D office | The 3D office itself and the main component of the system. |
| `OfficeTypeBadge` | Office types | A chip that names an office type with its icon and type color. |
| `OfficeTypeCard` | Office types | A flat picture and badge for one office type. The picture is drawn from the tokens of the theme the card sits in (`AgentOffice.officePicture`), in the dark or retro style of its MODES entry, so the stripe is the `type-*` color of that theme. It reads the tokens after the first render. |
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

| Token | light | dark | sublevel | fluent | fluent-dark | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `bg` | `#e9edf1` | `#10141a` | `#dfe6e1` | `#f5f5f5` | `#1f1f1f` | Page and 3D scene background behind every panel. |
| `panel` | `rgba(255,255,255,0.86)` | `rgba(24,30,38,0.86)` | `rgba(246,248,245,0.93)` | `rgba(255,255,255,0.88)` | `rgba(41,41,41,0.88)` | Glass HUD panels over the 3D scene. Always pair with blur-panel. |
| `chip` | `#f1f4f7` | `#1f2630` | `#e7ece8` | `#ebebeb` | `#333333` | Hover, selected row, pressed segment, quiet button fill. |
| `line` | `rgba(30,45,60,0.10)` | `rgba(200,215,230,0.10)` | `rgba(20,60,50,0.16)` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` | Panel borders and dividers. Hairline only. |
| `ink` | `#18212b` | `#e6ebf0` | `#102a33` | `#242424` | `#ffffff` | Primary text on bg, panel and chip. |
| `muted` | `#5f6b78` | `#8e9aa7` | `#4d6660` | `#616161` | `#adadad` | Secondary text: task lines, timestamps, counts. 4.6:1 or more on bg, panel and chip. |
| `accent` | `#2f6fe4` | `#6c9dff` | `#1f6f8b` | `#0f6cbd` | `#479ef5` | Primary action (Approve, Retry), focus ring, routine markers. |
| `accent-text` | `#2363dc` | `{accent}` | `#1e6d89` | `{accent}` | `#4aa0f6` | Accent as text on bg, card and chip: 4.5:1 or more in every theme. Fills, the focus ring and the 3D scene keep `accent`. |
| `on-accent` | `#ffffff` | `#0d1420` | `#ffffff` | `#ffffff` | `#141414` | Text on accent. |
| `emphasis` | `{accent}` | `{accent}` | `#b5302b` | `{accent}` | `{accent}` | The 10% color: alerts and the one key action in a decision (Approve on a request, unread counts, room alert beacons). In Day, Night, Fluent and Fluent Dark it equals accent; in Sublevel it is red. Never a fill larger than a button. |
| `on-emphasis` | `{on-accent}` | `{on-accent}` | `#ffffff` | `{on-accent}` | `{on-accent}` | Text on emphasis. |
| `on-status` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#141414` | Not used by the DS (agent-office #118): no one value reaches 4.5:1 on all five status fills in any theme. Draw a status word with status-*-text or status-*-on-bubble, or on a status-*-text fill with bg (danger button, door sign count). The desk terminal word is scene-dark on status-* mixed 55% into bubble. |
| `bubble` | `#ffffff` | `#f2f5f8` | `#f6f8f5` | `#ffffff` | `#f5f5f5` | Fill of status bubbles and speech bubbles over bots, in 2D and 3D. Also the check mark cut out of the finished disk (3:1 or more on status-finished-on-bubble). |
| `status-working` | `#1f9a58` | `#2fb36d` | `#1d8a5a` | `#107c10` | `#54b054` | Bot is working. Dot, bubble glyph, monitor glow. |
| `status-waiting` | `#c27c17` | `#e3992f` | `#b07514` | `#de590b` | `#faa06b` | Bot needs a human decision. Always shows in Waiting on me. |
| `status-error` | `#d1403b` | `#e5605b` | `#c23b36` | `#c50f1f` | `#dc626d` | Bot failed. Always shows in Waiting on me with Retry. |
| `status-resting` | `#78818b` | `#8a939d` | `#788583` | `#7a7a7a` | `#858585` | Bot is idle in the lounge. |
| `status-finished` | `#3b74e0` | `#5b93f5` | `#2f6bc8` | `#2886de` | `#62abf5` | Bot finished a task; check bubble at the desk. |
| `status-working-text` | `#197a46` | `{status-working}` | `#18734b` | `#0e700e` | `{status-working}` | Text color for the working status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-working. |
| `status-waiting-text` | `#945f12` | `{status-waiting}` | `#895b10` | `#a94409` | `{status-waiting}` | Text color for the waiting status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-waiting. |
| `status-error-text` | `#c4332e` | `#e6645f` | `#b63733` | `#b10e1c` | `#ee8a93` | Text color for the error status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-error. |
| `status-resting-text` | `#646b74` | `{status-resting}` | `#5d6765` | `#616161` | `#adadad` | Text color for the resting status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-resting. |
| `status-finished-text` | `#2363dc` | `{status-finished}` | `#2c63ba` | `#115ea3` | `{status-finished}` | Text color for the finished status on bg, panel and chip. 4.5:1 or more. Use it for a status word. Dot and fill use status-finished. |
| `status-working-on-bubble` | `#1b854c` | `#217e4d` | `#1b7f53` | `{status-working}` | `#0e700e` | Text color for the working status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-waiting-on-bubble` | `#a46913` | `#9a6315` | `#996611` | `#bc4b09` | `#bc4b09` | Text color for the waiting status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-error-on-bubble` | `{status-error}` | `#d42822` | `{status-error}` | `{status-error}` | `#b10e1c` | Text color for the error status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-resting-on-bubble` | `#6e7780` | `#666f7a` | `#677371` | `#707070` | `#616161` | Text color for the resting status on bubble (a light face in every theme). 4.5:1 or more. |
| `status-finished-on-bubble` | `#3771df` | `#1565f1` | `{status-finished}` | `#0f6cbd` | `#115ea3` | Text color for the finished status on bubble (a light face in every theme). 4.5:1 or more. |
| `floor-ops` | `#4a6278` | `#587089` | `#3f5d70` | `#505c60` | `#505c60` | Floor 1 identity. Roster header fill, building-view floor band; white text on it. |
| `floor-sales` | `#b5523b` | `#b5523b` | `#5d4a7a` | `#b6480e` | `#b6480e` | Floor 2 identity. Roster header fill; white text on it. |
| `floor-research` | `#2f7f44` | `#2f7f44` | `#2c6b57` | `#00723b` | `#00723b` | Floor 3 identity. Roster header fill; white text on it. |
| `floor-content` | `#7a52c7` | `#7a52c7` | `#2f5f86` | `#6656d1` | `#6656d1` | Floor 4 identity. Roster header fill; white text on it. |
| `floor-hq` | `#8a5a12` | `#8a5a12` | `#7a5414` | `#8e562e` | `#8e562e` | Floor 5 (HQ) identity. Roster header fill; white text on it. |
| `on-floor` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | Text on any floor-* fill. 4.9:1 or more. |
| `scrim` | `#0a1016` | `#0a1016` | `#0a1016` | `#000000` | `#000000` | Dark veil behind a dialog or the command palette. Mix it with transparent: color-mix(in srgb, var(--scrim) 45%, transparent). |
| `type-team` | `#3a7ca5` | `#5f9fc8` | `#2f6b7a` | `#4f6bed` | `#778df1` | Office type: team floor. Type badge dot, room icon, the stripe on the room floor edge. |
| `type-lab` | `#0f8b8d` | `#2fb3b5` | `#0f7f7c` | `#038387` | `#4cb4b7` | Office type: lab / server room. |
| `type-studio` | `#c2477a` | `#e0709a` | `#b03f6e` | `#c239b3` | `#da7ed0` | Office type: studio. |
| `type-hq` | `#a36a12` | `#d0922e` | `#946010` | `#b27c00` | `#efb839` | Office type: war room / HQ. |
| `type-security` | `#6650b8` | `#9a86e8` | `#5a48a6` | `#8764b8` | `#b29ad4` | Office type: Security room (the permission rules on its wall screens). |
| `scene-floor` | `#f3f2ee` | `#2a3039` | `#2f6456` | `#f0f0f0` | `#2e2e2e` | 3D floor slab top. |
| `scene-wall` | `#e3e6ea` | `#232a34` | `#e9ede7` | `#e6e6e6` | `#292929` | 3D back wall. |
| `scene-wood` | `#d8b98a` | `#8f7656` | `#f1f1ea` | `#e2cfae` | `#8c7a5e` | 3D desk tops and side tables. |
| `scene-chair` | `#2f5d4a` | `#24493b` | `#1c2326` | `#394146` | `#4a5356` | 3D chairs and sofas. |
| `scene-rug` | `#c0563f` | `#a8483a` | `#2a5560` | `#5a8fd0` | `#2f5d8f` | 3D lounge rug. Marks the resting zone. |
| `scene-wall-side` | `#d9dde2` | `#1e242d` | `#e2e7e2` | `#e0e0e0` | `#242424` | 3D left wall. One step darker than scene-wall so the corner reads. |
| `scene-slab` | `#c9ced4` | `#1b2028` | `#b9c4bf` | `#b3b3b3` | `#1a1a1a` | 3D floor slab edge and kit plinths; the City ground. |
| `scene-rail` | `#ffffff` | `#59616c` | `#f4f6f2` | `#ffffff` | `#5c5c5c` | 3D front railing slats. |
| `scene-sofa` | `#2f5f52` | `#24493b` | `#2c5b6b` | `#4d565c` | `#3f4a55` | 3D lounge sofas. |
| `scene-metal` | `#9aa2ab` | `#6f7884` | `#b8c0bf` | `#a8a8a8` | `#707070` | 3D desk pedestals and bases. |
| `scene-dark` | `#2b323b` | `#2b323b` | `#263238` | `#292929` | `#141414` | 3D monitors, lamps, racks, tripods. |
| `scene-glass` | `#bcd3e6` | `#3d5468` | `#cfe3e0` | `#cfe4fa` | `#34506e` | 3D glass partitions between rooms and the room boxes in the building view. Used at 22–28% opacity. |
| `scene-subagent` | `#9aa3ad` | `#6f7884` | `#b9c4bf` | `#a3a3a3` | `#6b6b6b` | 3D body of a temporary subagent. Grey so it reads as on loan; it leaves when it returns. |

#### Contrast pairs the DS checks

`test/contrast.test.mjs` measures these pairs in every theme of `tokens.json`, with no exception for one theme; `test/skin.test.mjs` also runs the pairs of the ContrastCheck card in every theme. A page can check its own uses against the same list. Card = `panel` over `bg`.

| Foreground | Background | Needs | Use |
| --- | --- | --- | --- |
| `ink` | `bg`, card, `chip` | 4.5:1 | Primary text. |
| `muted` | `bg`, card, `chip` | 4.5:1 | Secondary text. |
| `status-*-text` | `bg`, card, `chip` | 4.5:1 | A status word on a theme surface. |
| `status-*-on-bubble` | `bubble` | 4.5:1 | A status word on a bubble or a whiteboard face. |
| `on-accent` | `accent` | 4.5:1 | Label of a primary button. |
| `accent-text` | `bg`, card, `chip` | 4.5:1 | Accent text on a selected row: the More link of a decision card, a ghost button. Raw `accent` is 4.21:1 on chip in Day. |
| `bubble` | `status-finished-on-bubble` | 3:1 | The check mark cut out of the finished disk (StatusBubble and the 3D bubble). |
| `on-floor` | every `floor-*` | 4.9:1 | Floor header text. |
| `status-*` | card, `chip` | 3:1 | Status dot, next to a word. |
| `type-*` | `chip` | 3:1 | Type dot, room icon and room floor stripe. |
| `accent` | `bg` | 3:1 | Focus ring and the accent pill of a pressed control. |
| `status-*` | any | not checked at 4.5:1 | Do not use it as text color. It is a fill and a dot. Use `status-*-text` or `status-*-on-bubble`. |

#### Fluent 2 source of Fluent and Fluent Dark

Fluent and Fluent Dark follow the open Fluent 2 design tokens: `webLightTheme` and `webDarkTheme` of `@fluentui/tokens` (MIT, version 1.0.0-alpha.24). Each color names its source: an alias token (`colorNeutralBackground3`), a step of the neutral ramp (`grey[94]`), of the brand ramp (`brandWeb[90]`) or of a shared palette color (`orchid tint30`). "Matches" means the value is the source value. Where it differs, the cell says why; most differences are a contrast fix, so do not set them back to the source. A value that drifted with no reason was aligned to its source (in x1.7.11 or x1.7.13, as the cell says), and every contrast pair was measured again. A `{token}` value takes the value of that token. The theme shows no Microsoft logo, Windows mark or product name.

| Token | fluent (webLightTheme) | fluent-dark (webDarkTheme) |
| --- | --- | --- |
| `bg` | `#f5f5f5`: colorNeutralBackground3. Aligned from `#f3f3f3` (x1.7.13). | `#1f1f1f`: colorNeutralBackground2. Matches. |
| `panel` | `rgba(255,255,255,0.88)`: colorNeutralBackground1, at the 88% glass alpha of the DS. Fluent 2 has no glass surface. Aligned from `rgba(251,251,251,0.88)` (x1.7.13). | `rgba(41,41,41,0.88)`: colorNeutralBackground1, at the 88% glass alpha of the DS. Fluent 2 has no glass surface. |
| `chip` | `#ebebeb`: colorSubtleBackgroundSelected. Matches. | `#333333`: colorSubtleBackgroundSelected. Matches. |
| `line` | `rgba(0,0,0,0.10)`: colorNeutralStencil1Alpha. The stroke token colorNeutralStrokeAlpha (0.05) is too faint on the glass panel. | `rgba(255,255,255,0.10)`: colorNeutralStrokeAlpha. Matches. |
| `ink` | `#242424`: colorNeutralForeground1. Matches. | `#ffffff`: colorNeutralForeground1. Matches. |
| `muted` | `#616161`: colorNeutralForeground3. Matches. | `#adadad`: colorNeutralForeground3. Matches. |
| `accent` | `#0f6cbd`: colorBrandBackground. Matches. | `#479ef5`: colorBrandForeground1. Aligned from `#4aa0f6` (x1.7.13); `accent-text` keeps the lighter step. |
| `accent-text` | `{accent}`: colorBrandForeground1. Matches. | `#4aa0f6`: colorBrandForeground1. Differs: `#479ef5` is 4.499:1 on chip; one step lighter is 4.6:1. |
| `on-accent` | `#ffffff`: colorNeutralForegroundOnBrand. Matches. | `#141414`: colorNeutralBackground3. Accent is the light brand foreground, so the text on it is dark: white on `#479ef5` is 2.8:1. |
| `emphasis` | `{accent}`: colorBrandBackground (= accent). Matches. | `{accent}`: colorBrandForeground1 (= accent). Matches. |
| `on-emphasis` | `{on-accent}`: colorNeutralForegroundOnBrand (= on-accent). Matches. | `{on-accent}`: colorNeutralBackground3 (= on-accent). Matches. |
| `on-status` | `#ffffff`: colorNeutralForegroundOnBrand. Not used (agent-office #118). | `#141414`: colorNeutralBackground3. Not used (agent-office #118). |
| `bubble` | `#ffffff`: colorNeutralBackground1. Matches. | `#f5f5f5`: grey[96] (webLightTheme colorNeutralBackground3). The bubble is a light face in every theme. |
| `status-working` | `#107c10`: colorStatusSuccessBackground3. Matches. | `#54b054`: colorStatusSuccessForeground1. Matches. |
| `status-waiting` | `#de590b`: orange shade10, one step darker than colorStatusWarningBackground3. Differs: colorStatusWarningBackground3 `#f7630c` is 2.6:1 on chip; orange shade10 is 3.2:1. Aligned from `#d2560b` (x1.7.13). | `#faa06b`: colorStatusWarningForeground1. Matches. |
| `status-error` | `#c50f1f`: colorStatusDangerBackground3. Matches. | `#dc626d`: colorStatusDangerForeground1. Matches. |
| `status-resting` | `#7a7a7a`: grey[48]. Fluent 2 has no idle status: a mid step of the neutral ramp, 3:1 or more on chip. | `#858585`: grey[52]. Fluent 2 has no idle status: a mid step of the neutral ramp. |
| `status-finished` | `#2886de`: brandWeb[90]. Fluent 2 has no finished status: a step of the brand ramp, 3:1 or more on chip. Aligned from `#227ed4` (x1.7.13). | `#62abf5`: colorBrandForeground2. Matches. |
| `status-working-text` | `#0e700e`: colorStatusSuccessForeground1. Matches. | `{status-working}`: colorStatusSuccessForeground1, the value of status-working. Aligned from `#6cbf6c` (x1.7.11). |
| `status-waiting-text` | `#a94409`: colorStatusWarningForeground1. Differs: `#bc4b09` is 4.25:1 on chip; darkened to 5.0:1. | `{status-waiting}`: colorStatusWarningForeground1. Matches. |
| `status-error-text` | `#b10e1c`: colorStatusDangerForeground1. Matches. | `#ee8a93`: colorStatusDangerForeground1. Differs: `#dc626d` is 3.6:1 on chip; lightened to 5.2:1. |
| `status-resting-text` | `#616161`: colorNeutralForeground3. Fluent 2 has no idle status, so the word takes the secondary text color. Aligned from `#5c5c5c` (x1.7.11). | `#adadad`: colorNeutralForeground3. Aligned from `#a3a3a3` (x1.7.11). |
| `status-finished-text` | `#115ea3`: colorBrandForeground2. Matches. | `{status-finished}`: colorBrandForeground2. Matches. |
| `status-working-on-bubble` | `{status-working}`: colorStatusSuccessBackground3. Matches. | `#0e700e`: webLightTheme colorStatusSuccessForeground1. The bubble is a light face, so the light theme gives the text. |
| `status-waiting-on-bubble` | `#bc4b09`: colorStatusWarningForeground1. Matches. | `#bc4b09`: webLightTheme colorStatusWarningForeground1. Light face. Aligned from `#a94409` (x1.7.11). |
| `status-error-on-bubble` | `{status-error}`: colorStatusDangerBackground3. Matches. | `#b10e1c`: webLightTheme colorStatusDangerForeground1. Light face. |
| `status-resting-on-bubble` | `#707070`: colorNeutralForeground4. Matches. | `#616161`: webLightTheme colorNeutralForeground3. Light face. |
| `status-finished-on-bubble` | `#0f6cbd`: colorBrandForeground1. Matches. | `#115ea3`: webLightTheme colorBrandForeground2. Light face. |
| `floor-ops` | `#505c60`: platinum shade20. Fluent 2 has no floor colors: a shared palette color, 4.9:1 or more under white. Aligned from `#4d5f6b` (x1.7.13). | `#505c60`: platinum shade20. Aligned from `#4d5f6b` (x1.7.13). |
| `floor-sales` | `#b6480e`: pumpkin shade10. Shared palette color. | `#b6480e`: pumpkin shade10. Aligned from `#ad440d` (x1.7.13). |
| `floor-research` | `#00723b`: seafoam shade30. Shared palette color. Aligned from `#1c7d3b` (x1.7.13). | `#00723b`: seafoam shade30. Aligned from `#1a7539` (x1.7.13). |
| `floor-content` | `#6656d1`: lavender shade10. Shared palette color. | `#6656d1`: lavender shade10. Matches. |
| `floor-hq` | `#8e562e`: brown primary. Shared palette color. | `#8e562e`: brown primary. Matches. |
| `on-floor` | `#ffffff`: colorNeutralForegroundOnBrand. Matches. | `#ffffff`: colorNeutralForeground1. Matches. |
| `scrim` | `#000000`: black, the color of colorBackgroundOverlay. The DS mixes it to 45%. Aligned from `#0a1016` (x1.7.13). | `#000000`: black, the color of colorBackgroundOverlay. Matches. |
| `type-team` | `#4f6bed`: cornflower primary. Shared palette color. | `#778df1`: cornflower tint20. Matches. |
| `type-lab` | `#038387`: teal primary. Shared palette color. | `#4cb4b7`: teal tint30. Matches. |
| `type-studio` | `#c239b3`: berry primary. Shared palette color. | `#da7ed0`: berry tint30. Matches. |
| `type-hq` | `#b27c00`: marigold shade20. Shared palette color, 3.05:1 on chip. Aligned from `#9a6a00` (x1.7.13). | `#efb839`: marigold tint20. Matches. |
| `type-security` | `#8764b8`: orchid primary. Shared palette color. | `#b29ad4`: orchid tint30. Aligned from `#b49dd4` (x1.7.13). |
| `scene-floor` | `#f0f0f0`: grey[94]. A 3D material: Fluent 2 has no scene tokens, so a neutral material is a step of the neutral ramp. Aligned from `#eeeeee` (x1.7.13). | `#2e2e2e`: grey[18]. A step of the neutral ramp. |
| `scene-wall` | `#e6e6e6`: grey[90]. Neutral ramp. Aligned from `#e8e8e8` (x1.7.13). | `#292929`: grey[16]. Neutral ramp. |
| `scene-wood` | `#e2cfae`: no source. A 3D material (wood): no Fluent 2 source. | `#8c7a5e`: no source. A 3D material (wood): no Fluent 2 source. |
| `scene-chair` | `#394146`: anchor primary. Shared palette color. Aligned from `#3a4048` (x1.7.13). | `#4a5356`: silver shade30. Aligned from `#4a5058` (x1.7.13). |
| `scene-rug` | `#5a8fd0`: no source. A 3D material (the lounge rug, in the brand blue family): no Fluent 2 source. | `#2f5d8f`: no source. A 3D material: no Fluent 2 source. |
| `scene-wall-side` | `#e0e0e0`: grey[88]. Neutral ramp, one step darker than the wall. Aligned from `#dedede` (x1.7.13). | `#242424`: grey[14]. Neutral ramp. |
| `scene-slab` | `#b3b3b3`: grey[70]. Neutral ramp. | `#1a1a1a`: grey[10]. Neutral ramp. |
| `scene-rail` | `#ffffff`: white. Matches. | `#5c5c5c`: grey[36]. Neutral ramp. |
| `scene-sofa` | `#4d565c`: anchor tint10. Shared palette color. Aligned from `#4a5560` (x1.7.13). | `#3f4a55`: no source. A 3D material: no Fluent 2 source. |
| `scene-metal` | `#a8a8a8`: grey[66]. Neutral ramp. | `#707070`: grey[44]. Neutral ramp. |
| `scene-dark` | `#292929`: grey[16] (colorNeutralBackgroundInverted). Matches. | `#141414`: grey[8] (colorNeutralBackground3). Matches. |
| `scene-glass` | `#cfe4fa`: brandWeb[150] (colorBrandBackground2Hover). Matches. | `#34506e`: no source. A 3D glass tint: no Fluent 2 source. |
| `scene-subagent` | `#a3a3a3`: grey[64]. Neutral ramp. | `#6b6b6b`: grey[42]. Neutral ramp. |

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
| `radius-fluent-sm` | `4px` | Buttons and controls in Fluent and Fluent Dark. The theme sets radius-sm to it. |
| `radius-fluent-md` | `4px` | Rows and segments in Fluent and Fluent Dark. The theme sets radius-md to it. |
| `radius-fluent-lg` | `8px` | Panels, cards and dialogs in Fluent and Fluent Dark. The theme sets radius-lg to it. |

`tokens.css` only defines the `radius-fluent-*` and `font-fluent-*` tokens. `components/bundle.css` maps them under `[data-theme|="fluent"]` (`radius-sm`, `radius-md`, `radius-lg`, `font-sans`, `font-mono`), for Fluent and Fluent Dark, as it maps `font-sublevel-*` under `[data-theme|="sublevel"]`. Fluent 2 sources: `borderRadiusMedium` (4px) for controls and rows, `borderRadiusXLarge` (8px) for panels. So load `bundle.css` with `tokens.css`: with `tokens.css` alone, Fluent and Fluent Dark keep the Day corners and faces.

### shadow

| Token | Value | Use |
| --- | --- | --- |
| `shadow-panel` | `{"light": "0 6px 24px rgba(10,20,30,0.08)", "dark": "0 6px 24px rgba(0,0,0,0.35)", "sublevel": "0 1px 0 rgba(16,42,51,0.10)", "fluent": "0 0 2px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.14)", "fluent-dark": "0 0 2px rgba(0,0,0,0.24), 0 4px 8px rgba(0,0,0,0.28)"}` | Every floating HUD panel. Nothing else casts a shadow. |

### skin

The values of the drawn DS parts in each theme: the bot portraits (`BotAvatar`, `AgentOffice.PORTRAITS`) and the logo mark. `bundle.css` applies them (`ao-pt-*`, `.ao-mark`), so no theme has a portrait or logo file of its own.

| Token | light | dark | sublevel | fluent | fluent-dark | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `portrait-ink` | `#11161c` | `#11161c` | `#102a33` | `#11161c` | `#11161c` | Eyes and line art of a bot portrait (BotAvatar). |
| `portrait-gloss` | `1` | `1` | `0` | `1` | `1` | Bot portrait: 1 shows the highlight and the soft shadow under the bot, 0 draws the bot flat. |
| `portrait-outline` | `0` | `0` | `1` | `0` | `0` | Bot portrait: 1 draws an outline, the inner facet edges and a floor line in portrait-ink, 0 draws none. |
| `portrait-eyes-square` | `0` | `0` | `1` | `0` | `0` | Bot portrait: 1 draws square eyes, 0 round eyes. |
| `logo-mark-radius` | `25%` | `25%` | `50%` | `25%` | `25%` | Corner of the logo mark: 25% is a rounded square, 50% a circle. |

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

The office top bar (brand, mode toggle, view toggle, status counts) keeps to the rows above the side columns: one row above `bp-phone`, two rows to 521 px, three rows below. In the bar the mode toggle shows icons only (the pressed mode keeps its label) to 999 px, and to 1199 px in the Sublevel family, whose capitals are wider. `test/skin.test.mjs` checks the width for every theme against the number of `AgentOffice.MODES` entries and the label lengths (a pinned estimate with 16 px to spare), so a new theme that makes the toggle longer must raise the width. The status counts go to a second row between the columns, and hide below 960 px. When a toggle still goes to a lower row (Sublevel from 821 to 899 px, or a long building or agent name), the side columns start below the last toggle of the bar (CSS anchor positioning), so no toggle is under a column. A page that puts its own panel under the bar starts it at 68 px above `bp-phone`, as the columns do.

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
| `scene-walk-speed` | `2.6` | Walk speed of a bot, in scene units a second. A walk of 15 to 80 units takes about 6 to 31 s. |
| `scene-walk-speed-ephemeral` | `5.2` | Walk speed of a temporary helper (an ephemeral bot), in and out. About twice the bot speed. A walk of 15 to 80 units (a short to a four-room floor) takes about 3 to 15 s, in place of 6 to 31 s. |

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
| `light-fluent-sky` | `0.85` | Even sky fill in Fluent: soft daylight. |
| `light-fluent-sun` | `0.65` | Sun in Fluent: softer than Day, high and from the front, so shadows are short. |
| `light-fluent-lamp` | `0` | Room lamps in Fluent: off. |
| `light-fluent-dark-sky` | `0.42` | Sky light in Fluent Dark: a dim interior, between Night and Fluent. |
| `light-fluent-dark-sun` | `0.32` | Key light in Fluent Dark: soft, from the same high front angle as Fluent. |
| `light-fluent-dark-lamp` | `1.1` | Room lamps in Fluent Dark: on, softer than Night. |

### fx

3D post effects (0 to 2). The engine reads these on mount and when the theme changes. Quality "low" turns post effects off.

| Token | Value | Use |
| --- | --- | --- |
| `fx-bloom-day` | `0.12` | Bloom strength in Day. |
| `fx-bloom-night` | `0.7` | Bloom strength in Night: screens, lamps, windows, packets and beacons glow. |
| `fx-bloom-sublevel` | `0.25` | Bloom strength in Sublevel. |
| `fx-bloom-fluent` | `0.08` | Bloom strength in Fluent: low, so only screens and beacons glow a little. |
| `fx-bloom-fluent-dark` | `0.4` | Bloom strength in Fluent Dark: screens and beacons glow, less than Night. |
| `fx-threshold-day` | `1.3` | Light level where bloom starts in Day. Above white, so walls do not glow. |
| `fx-threshold-night` | `0.8` | Light level where bloom starts in Night. |
| `fx-threshold-sublevel` | `1.15` | Light level where bloom starts in Sublevel. |
| `fx-threshold-fluent` | `1.35` | Light level where bloom starts in Fluent. Above white, so walls do not glow. |
| `fx-threshold-fluent-dark` | `0.9` | Light level where bloom starts in Fluent Dark. Below white, so lit screens bloom. |
| `fx-exposure-day` | `1` | Exposure in Day. |
| `fx-exposure-night` | `1.08` | Exposure in Night. |
| `fx-exposure-sublevel` | `1` | Exposure in Sublevel. |
| `fx-exposure-fluent` | `1` | Exposure in Fluent. |
| `fx-exposure-fluent-dark` | `1.05` | Exposure in Fluent Dark. |
| `fx-fog-day` | `0` | Depth haze in Day: off. |
| `fx-fog-night` | `0.3` | Depth haze in Night, in the bg color. |
| `fx-fog-sublevel` | `0.12` | Depth haze in Sublevel. |
| `fx-fog-fluent` | `0.06` | Depth haze in Fluent: light, in the bg color. |
| `fx-fog-fluent-dark` | `0.18` | Depth haze in Fluent Dark, in the bg color. |
| `fx-bloom-radius` | `0.45` | Bloom spread. |
| `fx-knee` | `0.82` | Highlight roll-off: light above this level compresses softly, light below keeps the token color. |
| `fx-vignette-day` | `0` | Corner darkening in Day: off, so the scene edge meets the page bg. |
| `fx-vignette-night` | `0.18` | Corner darkening in Night. |
| `fx-vignette-sublevel` | `0.06` | Corner darkening in Sublevel. |
| `fx-vignette-fluent` | `0` | Corner darkening in Fluent: off, so the scene edge meets the page bg. |
| `fx-vignette-fluent-dark` | `0.1` | Corner darkening in Fluent Dark: light, less than Night. |

### font families

- `font-sans`: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif
- `font-mono`: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace
- `font-term`: "VT323", "IBM Plex Mono", ui-monospace, monospace
- `font-sublevel-sans`: "Archivo", "IBM Plex Sans", system-ui, sans-serif
- `font-sublevel-mono`: "Chivo Mono", "IBM Plex Mono", ui-monospace, monospace
- `font-fluent-sans`: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif (system faces: the office loads no font file for them)
- `font-fluent-mono`: "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace

The Fluent faces are system faces. On Windows 11 the office shows Segoe UI Variable and Cascadia Mono; on Windows 10, Segoe UI and Consolas (Cascadia comes with Windows Terminal). A machine with none of them shows its system face: San Francisco on macOS (`-apple-system`, `system-ui`), the desktop face on Linux (`system-ui`, often Cantarell or Noto Sans), and its default monospace face. The layout does not depend on the face: the mode control fit rule (Breakpoint) has room for a wider face.

## Icons

`add`, `approve`, `attach`, `bell`, `bot`, `broadcast`, `browser`, `building`, `channel`, `chat`, `checkpoint`, `chevron-down`, `chevron-right`, `close`, `code-run`, `computer-use`, `connector`, `copy`, `cost`, `day`, `decline`, `delegate`, `elevator`, `error`, `eval`, `filter`, `finished`, `floor`, `flow`, `fluent`, `fluentdark`, `hq`, `identity`, `info`, `knowledge`, `lab`, `mcp`, `memory`, `model`, `more`, `night`, `pause`, `plan`, `remove`, `resting`, `resume`, `retry`, `role-ae`, `role-analyst`, `role-coder`, `role-csa`, `role-csam`, `role-designer`, `role-fde`, `role-media`, `role-ops`, `role-partner`, `role-planner`, `role-research`, `role-sales`, `role-se`, `role-specialist`, `role-writer`, `rollback`, `room`, `schedule`, `search`, `security`, `send`, `session`, `settings`, `skill`, `sound`, `sound-off`, `studio`, `subagent`, `team`, `terminal`, `token`, `tool`, `tour`, `trace`, `trigger`, `waiting`, `working`, `zoom-in`, `zoom-out`
