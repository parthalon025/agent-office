# Tooltip

A short label that shows on hover and on keyboard focus. Use it for icon-only buttons and for truncated names. Never put an action or more than one line in a tooltip.

**The consumer provides:** the text and one focusable child.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `text` | yes | `string` |
| `side` | no | `"top" \| "bottom"` |
| `open` | no | `boolean` |
| `children` | yes | `ReactNode` |
