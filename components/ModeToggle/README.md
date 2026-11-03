# ModeToggle

A segmented control for the scene mode: Day, Night, Tour. Day, Night and Sublevel are exclusive; Tour can be on with any of them. The consumer owns state.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `value` | no | `string` |
| `active` | no | `string[]` |
| `options` | no | `{ id: string; label: string }[]` |
| `onChange` | no | `(id: string) => void` |
| `label` | no | `string` |
