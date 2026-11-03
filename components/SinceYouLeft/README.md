# SinceYouLeft

A summary card for the person who comes back. It tells what happened while they were away: what finished, what needs them, what failed and what it cost. Show it once when the person returns, above the HUD.

- **Consumer provides:** `summary` from the office snapshot, and the time the person left in `summary.since`.
- The title is "Since you left (<relative time>)", for example "Since you left (2 hours ago)".
- Four figures: Finished, Needs you, Errors, Spend. Each status figure has a dot and a word.
- Up to 3 top lines from `summary.top`.
- "Replay" calls `onReplay`. Use it to start the TimeScrubber at `summary.since`.
- "Open decisions" calls `onDecisions`. It is the emphasis button when a bot needs the person. It is off when no bot needs the person.
- The close button calls `onClose`.
- Empty state: "Nothing happened" when no bot finished, failed, called a tool or asked.
- At 340 px and less, the figures go into 2 columns.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `summary` | yes | `{ since: number; finished: number; waiting: number; errors: number; toolCalls: number; tokens: number; cost: number; sessions: number; messages: number; byBot?: Record<string, { finished: number; errors: number; tokens: number; cost: number }>; top?: string[] }` |
| `now` | no | `number` |
| `onReplay` | no | `() => void` |
| `onDecisions` | no | `() => void` |
| `onClose` | no | `() => void` |
