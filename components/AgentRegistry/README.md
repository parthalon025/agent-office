# AgentRegistry

The inventory of every agent: platform, identity, model, tool count, access scope and last run. Broad access shows as a warning badge. Use it for governance reviews.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `agents` | yes | `{ name: string; shape?: Shape; color?: string; status?: Status; platform?: string; identity?: string; model?: string; tools?: string[]; access?: "scoped" \| "broad"; last?: string }[]` |
