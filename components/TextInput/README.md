# TextInput

A single-line text field with a label, a hint and an error. The chat and broadcast boxes use the same style. Every field has a visible label or an `aria-label`.

**The consumer provides:** the label, the value and `onChange`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `id` | no | `string` |
| `label` | no | `string` |
| `value` | no | `string` |
| `defaultValue` | no | `string` |
| `placeholder` | no | `string` |
| `hint` | no | `string` |
| `error` | no | `string` |
| `disabled` | no | `boolean` |
| `type` | no | `string` |
| `onChange` | no | `(value: string) => void` |
