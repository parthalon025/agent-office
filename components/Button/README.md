# Button

A compact action. Use `primary` for the one action that answers the bot (Approve, Retry), `quiet` for the other (Decline, Dismiss), `danger` for an action that cannot be undone (Remove bot), and `ghost` for an action inside a toast or a row. The label says the result. While the agent works on the command, show `loading`.

**The consumer provides:** the label and the click handler. While a command is in flight, set `loading`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `variant` | no | `"primary" \| "quiet" \| "danger" \| "ghost"` |
| `size` | no | `"md" \| "lg"` |
| `icon` | no | `string` |
| `loading` | no | `boolean` |
| `disabled` | no | `boolean` |
| `label` | no | `string` |
| `title` | no | `string` |
| `type` | no | `"button" \| "submit"` |
| `onClick` | no | `() => void` |
| `children` | no | `ReactNode` |
