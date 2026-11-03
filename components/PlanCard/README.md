# PlanCard

The orchestrator's plan: the goal, each step with its status and owner, and steps done over total.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `title` | no | `string` |
| `goal` | no | `string` |
| `steps` | yes | `{ id: string; text: string; status?: Status; owner?: string }[]` |
