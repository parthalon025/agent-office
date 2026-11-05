# OfficeScene

The 3D office itself and the main component of the system. It holds a building of floors, each floor holds rooms of one office type, and each room holds bots at workstations that match their role. The full HUD sits on top.

- **Expandable.** Add floors, rooms and bots from the HUD (Add floor, Add room, the bot button on a room) or with the API. A room gets wider when it gets more bots; a floor gets wider when it gets more rooms.
- **Two views.** Building shows all floors stacked, with one status pip per bot; click a floor or a room to go in. Floor shows one floor; click a room in the room list to frame it.
- **Data.** Pass `building` (floors → rooms → bots). Without it the example HQ runs with `simulate` on. Set `editable:false` to hide the add controls.
- **Tokens.** Every material reads the `scene-*`, `status-*`, `type-*` and `floor-*` tokens, so Day and Night follow the theme.
- **Agents.** Pass `adapter` to connect real agents (see README, Quickstart, and Recipes, Connect a platform). Every button sends a command to the adapter; the scene changes only when the adapter sends events back. Without an adapter, the mock adapter runs (`simulate:false` turns it off).
- **Sessions and talk.** Sessions show as a badge and a Sessions tab, or as their own blob (Recipes, Show sessions). Agents talk with `message.agent`: they turn, walk over or send an envelope. Click a bot to open its chat. Its replies also show as speech bubbles over it. Use the broadcast bar to message a room, a floor or every floor.
- **Solutions.** `solution:"microsoft"` loads the Microsoft customer solutions office.
- **Cinematic.** `quality` sets the post effects (auto, high, medium, low). `intro` flies in from the tower. `sound` starts with sound on; the sound button in the zoom panel turns it on and off. Bots path around every object, ride the elevator and carry tool calls as packets (see Concepts, The scene).
- **Motion and zoom.** With `prefers-reduced-motion`, every camera move cuts and a floor change shows the new floor at once. The cut goes through `stage.goal` like a glide, so a page that holds the goal back holds the cut too. The + and - buttons call `office.zoom(f)`: the zoom stays inside the controls' `minZoom` and `maxZoom`, and + never zooms out.
- **Mount again.** A new scene starts empty. The adapter sends the state again with `seeded: true` on each event, and `at` when it knows the time (Recipes, Mount a scene again). Seeded events record no history, play no sound and send no `onNotify` or toast, so `sinceYouLeft` counts only news. Dispose marks the building as seen, but not while the page is hidden.
- **Decisions inbox.** The inbox state is open or closed. Pass `inbox` (boolean) and `onInbox(open)` to control it from the page: the page can then close it, and read its state, with no class names. Without `inbox`, the scene keeps the state itself. `onInbox` runs in both cases when the person opens or closes the inbox.
- **Alerts and tab title.** The scene mounts a `Notifier` that counts the open decisions of the building on screen. Pass `waitingCount` (number) to use your own total, for example the open decisions of all buildings. Pass `notifier: false` to not mount it, and mount your own `Notifier` instead (see `Notifier`, `title`).
- **Agent panel tabs.** `extraTabs`, `hideTabs` and `onTabChange` go to the agent panel (see `AgentPanel`). To switch the open tab from the page, for example after a click on a desk monitor or from Ctrl+K, pass `agentTab` (a tab id) and keep it in step with `onTabChange`. Without `agentTab`, the panel keeps its own tab. The panel shows only while a bot is selected, so set `agentTab` and select the bot (`office.select(name)`) together.
- Without React: `AgentOffice.office.mount(el, opts)`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `onNotify` | no | `(n: { kind: "request" \| "error"; bot: string; text: string; risk?: "low" \| "medium" \| "high" \| null }) => void` |
| `frameInset` | no | `{ left: number; right: number } \| null` |
| `ambient` | no | `boolean` |
| `onAmbientOpen` | no | `() => void` |
| `sinceYouLeft` | no | `boolean` |
| `onSinceYouLeft` | no | `(open: boolean) => void` |
| `building` | no | `BuildingDef` |
| `solution` | no | `"hq" \| "microsoft" \| "hermes" \| "copilot"` |
| `adapter` | no | `AgentAdapter \| null` |
| `theme` | no | `"light" \| "dark" \| "sublevel" \| "fluent" \| "fluent-dark"` |
| `floor` | no | `number` |
| `view` | no | `"floor" \| "building"` |
| `mode` | no | `"auto" \| "day" \| "night" \| "sublevel" \| "fluent" \| "fluent-dark"` |
| `simulate` | no | `boolean` |
| `editable` | no | `boolean` |
| `hud` | no | `boolean` |
| `toasts` | no | `boolean` |
| `height` | no | `number` |
| `reset` | no | `string` |
| `quality` | no | `Quality` |
| `intro` | no | `boolean` |
| `sound` | no | `boolean` |
| `onReady` | no | `(office: OfficeApi) => void` |
| `onSelect` | no | `(botName: string \| null) => void` |
| `inbox` | no | `boolean` |
| `onInbox` | no | `(open: boolean) => void` |
| `notifier` | no | `boolean` |
| `waitingCount` | no | `number` |
| `extraTabs` | no | `AgentPanelTab[]` |
| `hideTabs` | no | `("chat" \| "trace" \| "sessions" \| "agent")[]` |
| `agentTab` | no | `string` |
| `onTabChange` | no | `(id: string) => void` |
