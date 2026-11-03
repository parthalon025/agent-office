# DecisionInbox

All open requests in one list, highest risk first. The person reads each question, sees the cost and a preview, and approves or declines. The person can select more than one and answer them together.

- **Consumer provides:** `bots` from the office snapshot. The inbox shows each bot with a `request`. It sorts by risk (high, medium, no risk, low), then by floor, then by name.
- Each row shows the avatar, the bot name, the floor, the question, the risk badge, the cost, the tool and the preview.
- The risk badge has a dot and a word: "High risk" (`status-error`), "Medium risk" (`status-waiting`), "Low risk" (`status-finished`). Color is never alone.
- The preview is mono text. It shows 3 lines. "Show all" opens the full text.
- Approve is the emphasis button, one for each decision. Decline is quiet. If `request.actions` has labels, the buttons use them (for example Retry and Dismiss).
- The batch bar shows when the person selects rows: "Approve 3", "Decline 3", "Clear". It calls `onApproveMany(names)` or `onDeclineMany(names)`.
- The bot name calls `onOpen(name)`. Enter on a row also calls it.
- Keyboard: J and K move the focus, A approves, D declines, X selects, Shift+A approves the selected rows. The legend at the bottom shows the keys. After an answer, the focus goes to the next row.
- Empty state: "Nothing needs you".
- Give the parent a height, or set `maxHeight`. The list then scrolls and the legend stays at the bottom.
- At 380 px and less, the avatar and the legend hide.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `bots` | yes | `{ name: string; color?: string; shape?: "blob" \| "cone" \| "octa" \| "capsule"; role?: string; status?: "working" \| "waiting" \| "error" \| "resting" \| "finished"; task?: string; floor?: number; room?: string; orchestrator?: boolean; request: { id?: string; text: string; actions?: string[]; risk?: "low" \| "medium" \| "high"; cost?: number \| string; preview?: string; tool?: string } \| null }[]` |
| `maxHeight` | no | `number \| string` |
| `onApprove` | no | `(name: string) => void` |
| `onDecline` | no | `(name: string) => void` |
| `onApproveMany` | no | `(names: string[]) => void` |
| `onDeclineMany` | no | `(names: string[]) => void` |
| `onOpen` | no | `(name: string) => void` |
