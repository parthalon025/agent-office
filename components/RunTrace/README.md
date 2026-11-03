# RunTrace

The steps of a run in order: skill loads, plans, delegations, tool calls (with arguments and results), knowledge reads, checkpoints and model fallbacks. A checkpoint step offers Roll back. Use it as an activity map when you test or debug an agent.

**The consumer provides:** the steps and an optional rollback handler.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `steps` | yes | `TraceStep[]` |
| `onRollback` | no | `(checkpoint: { id: string; label: string }) => void` |
