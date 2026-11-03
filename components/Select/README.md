# Select

A styled native select with a label, a hint and an error. The broadcast target and the room type picker use it.

**The consumer provides:** the label, the options, the value and `onChange`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `id` | no | `string` |
| `label` | no | `string` |
| `ariaLabel` | no | `string` |
| `options` | yes | `{ value: string; label: string }[]` |
| `value` | no | `string` |
| `defaultValue` | no | `string` |
| `hint` | no | `string` |
| `error` | no | `string` |
| `disabled` | no | `boolean` |
| `onChange` | no | `(value: string) => void` |
