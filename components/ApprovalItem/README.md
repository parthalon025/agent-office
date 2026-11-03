# ApprovalItem

One request in Waiting on me. A waiting bot asks a yes/no question (Approve / Decline). A bot with an error offers Retry / Dismiss. Show the floor so the person can find the bot.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `name` | yes | `string` |
| `floor` | no | `number` |
| `ask` | yes | `string` |
| `status` | no | `"waiting" \| "error"` |
| `onApprove` | no | `() => void` |
| `onDecline` | no | `() => void` |
