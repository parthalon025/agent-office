# ModeToggle

A segmented control for the scene mode. Without `options` it shows the themes of `AgentOffice.MODES` (Day, Night, Sublevel, Fluent) and Tour. The themes are exclusive; Tour can be on with any of them. Each option can have an `icon` from the icon set. In a container under 520 px wide (the office, or a page box with `container-type: inline-size`), an option with an icon shows the icon only, and the pressed option keeps its label: five labels do not fit a phone. The label stays for screen readers and as the tooltip. The consumer owns state.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `value` | no | `string` |
| `active` | no | `string[]` |
| `options` | no | `{ id: string; label: string; icon?: string }[]` |
| `onChange` | no | `(id: string) => void` |
| `label` | no | `string` |
