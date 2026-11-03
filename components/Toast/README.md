# Toast

A short message that something happened that the person did not start: a bot needs a decision, a bot failed, or a command could not be sent. The office shows one for each new request and error, with an Open action that opens the bot's chat. Toasts stay for `duration-toast` and stack up to three. Never use a toast for the result of the person's own action; the scene shows that.

**The consumer provides:** the tone, the text and optional action and close handlers.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `tone` | no | `"info" \| "success" \| "warning" \| "error"` |
| `title` | no | `string` |
| `text` | yes | `string` |
| `action` | no | `{ label: string; onClick: () => void }` |
| `onClose` | no | `() => void` |
