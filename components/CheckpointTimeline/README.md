# CheckpointTimeline

Snapshots an agent took before it changed files or data. Roll back opens a confirm dialog in your app, then sends a `rollback` command.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `checkpoints` | yes | `{ id: string; label: string; time: string; files?: number }[]` |
| `onRollback` | no | `(cp: unknown) => void` |
