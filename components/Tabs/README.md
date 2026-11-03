# Tabs

Switch between views in one panel, for example Floor, Waiting and Activity in the phone sheet. Arrow keys move between tabs; Home and End jump. A tab can carry a count.

**The consumer provides:** the tabs, the current value and `onChange`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `tabs` | yes | `{ id: string; label: string; icon?: string; count?: number; content?: ReactNode }[]` |
| `value` | no | `string` |
| `onChange` | no | `(id: string) => void` |
| `label` | no | `string` |
| `render` | no | `(id: string) => ReactNode` |
