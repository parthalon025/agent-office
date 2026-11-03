# BroadcastBar

Send one message to many bots: a room, a floor or every floor. Each bot in the target gets the message in its chat and answers on its own. The office puts it at the bottom of the floor view.

**The consumer provides:** the targets, the current target, and the change and send handlers. Set `disabled` when there is no agent connection.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `disabled` | no | `boolean` |
| `targets` | yes | `{ id: string; label: string; target: { room?: string; floor?: number; all?: boolean } }[]` |
| `value` | no | `string \| null` |
| `onChange` | no | `(id: string) => void` |
| `onSend` | no | `(target: unknown, text: string) => void` |
