# Dialog

A modal for a decision that needs full attention, for example Remove bot or Disconnect agents. It traps focus, closes on Escape and on a click outside, and gives focus back when it closes. Put the safe action on the left and the main action on the right.

**The consumer provides:** `open`, the title, the body, the actions and `onClose`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `open` | yes | `boolean` |
| `title` | yes | `string` |
| `onClose` | no | `() => void` |
| `actions` | no | `ReactNode` |
| `inline` | no | `boolean` |
| `children` | no | `ReactNode` |
