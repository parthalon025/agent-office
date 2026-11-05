# CommandPalette

A search box for the whole office. The person types a few letters and jumps to a bot, goes to a floor, runs an action or asks the Manager. Cmd+K or Ctrl+K opens it.

- **Consumer provides:** `open` and `onClose`, the `bots` and `floors` from the office snapshot, `managerName`, and `actions`.
- Give `onOpen` and the palette listens for Cmd+K and Ctrl+K itself. Set `hotkey` to use a different letter. You can also use `AgentOffice.useHotkey("k", fn)`.
- It is a modal. It traps the focus, closes on Escape and on a click outside, and gives the focus back when it closes.
- Groups: Manager, Bots (jump), Floors (go to), and the groups of your actions.
- When the person types text and a Manager exists, the first item is "Ask the Manager: <text>". It calls `onAsk(text)`. If other items match, the first match is active, so Enter jumps. Up selects the Manager item.
- The match is a substring match on each word. "led cl" finds Ledger, Month-end close.
- Up and Down move. Enter runs the item and closes the palette.
- `AgentOffice.CommandPalette.actions(handlers)` makes the standard actions: Approve all low-risk, Open decisions, Replay since you left, Building view, Floor view, one action for each theme of `AgentOffice.MODES` (Day, Night, Sublevel, Fluent, Fluent Dark), Turn sound on or off. Leave out a handler to hide its action. The handlers are `approveLowRisk`, `openDecisions`, `replay`, `setView(view)`, `setMode(mode)`, `sound`, `setSound(on)`.
- Set `inline` to show it inside a box (for a preview card).

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `open` | yes | `boolean` |
| `onClose` | no | `() => void` |
| `onOpen` | no | `() => void` |
| `hotkey` | no | `string` |
| `inline` | no | `boolean` |
| `bots` | no | `{ name: string; color?: string; shape?: "blob" \| "cone" \| "octa" \| "capsule"; role?: string; status?: "working" \| "waiting" \| "error" \| "resting" \| "finished"; task?: string; floor?: number; room?: string; orchestrator?: boolean }[]` |
| `floors` | no | `{ id: number; name: string; key?: string }[]` |
| `managerName` | no | `string \| null` |
| `actions` | no | `{ id: string; label: string; icon?: string; group?: string; keywords?: string; hint?: string; hidden?: boolean; run: () => void }[]` |
| `onBot` | no | `(name: string) => void` |
| `onFloor` | no | `(id: number) => void` |
| `onAsk` | no | `(text: string) => void` |
