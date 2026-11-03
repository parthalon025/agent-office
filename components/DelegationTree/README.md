# DelegationTree

The orchestrator and the agents it delegated to, as a tree, with the concurrency slots (Hermes runs 3 subagents at a time by default). Temporary subagents carry a badge and leave when they finish.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `tree` | yes | `{ name: string; shape?: Shape; color?: string; status?: Status; task?: string; ephemeral?: boolean; children?: DelegationTreeProps["tree"][] }` |
| `max` | no | `number` |
| `onSelect` | no | `(name: string) => void` |
