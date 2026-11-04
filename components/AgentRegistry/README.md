# AgentRegistry

The inventory of every agent: platform, identity, model, tool count, access scope and last run. Broad access shows as a warning badge. Use it for governance reviews.

- **Row select.** Pass `onSelect` to make each row a choice. The agent name becomes a button, so Tab, Enter and Space work. A click on the row also calls `onSelect(agent)`. Pass `selected` (an agent name) to mark one row with `aria-current` and a left accent line. Without `onSelect`, the table is read-only, as before.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `agents` | yes | `{ name: string; shape?: Shape; color?: string; status?: Status; platform?: string; identity?: string; model?: string; tools?: string[]; access?: "scoped" \| "broad"; last?: string }[]` |
| `onSelect` | no | `(agent: AgentRegistryProps["agents"][number]) => void` |
| `selected` | no | `string` |
