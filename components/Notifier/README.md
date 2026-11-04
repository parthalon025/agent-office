# Notifier

Alerts for a person who works in another tab. Notifier draws nothing. NotifyToggle is the button that turns browser alerts on and off.

- **Consumer provides:** `notifications` (one for each open request, error or finish) and `enabled`.
- The page title gets the prefix "(N) ", where N is the number of open decisions. N is `count`, or the number of notifications of kind `request`. When Notifier unmounts, the title goes back. Set `title: false` to leave the page title alone: Notifier then sends only browser alerts, and it does not restore the title when it unmounts.
- When `enabled` is true and the page is hidden, each new notification shows a browser alert, for example "Ledger needs you" with "High risk. Approve posting 42 journal entries?". It shows up to 3 alerts at a time. A click on the alert focuses the page and calls `onClick`.
- Notifications that exist when Notifier mounts do not show an alert.
- NotifyToggle asks for permission only from its own click. The label is "Turn alerts on" or "Turn alerts off". It is a toggle with `aria-pressed` and the `bell` icon.
- If the browser blocks alerts, NotifyToggle says "Alerts are blocked. Allow them in the browser settings." If the browser has no alerts, the button is off.
- All Notification calls have feature checks and try/catch.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `notifications` | yes | `{ id: string; kind?: "request" \| "error" \| "finished"; bot?: string; text?: string; risk?: "low" \| "medium" \| "high" }[]` |
| `enabled` | yes | `boolean` |
| `count` | no | `number` |
| `title` | no | `boolean` |
| `onClick` | no | `(notification: { id: string; kind?: "request" \| "error" \| "finished"; bot?: string; text?: string; risk?: "low" \| "medium" \| "high" }) => void` |
