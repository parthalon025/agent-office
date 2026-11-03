# EmptyState

What a panel shows when it has nothing: an icon, a title that says what is true, a line that says what to do, and at most one action.

**The consumer provides:** the icon, the title, the text and an optional action.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `icon` | no | `string` |
| `title` | yes | `string` |
| `text` | no | `string` |
| `compact` | no | `boolean` |
| `action` | no | `{ label: string; icon?: string; onClick: () => void }` |
