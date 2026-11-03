# SessionList

The sessions of one agent: each run or conversation, newest first, with its state, times and result. It is the Sessions tab of AgentPanel.

- **Consumer provides:** `sessions` from the office snapshot (`session.start` and `session.end` events) and `onStop`, which sends the `session.stop` command.
- A session with its own blob shows "own blob". The adapter decides that with `sessions` on the building or bot, or `isolated` on the event (see Recipes, Show sessions).
- Empty state: "No sessions yet".

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `sessions` | yes | `{ id: string; title: string; status: "working" \| "finished" \| "error"; time: string; end?: string; result?: string; blob?: string }[]` |
| `onStop` | no | `(sessionId: string) => void` |
