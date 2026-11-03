# TimeScrubber

A replay bar for the office history. The person plays the day again at 1x, 10x or 60x, moves to a time, and goes back to live.

- **Consumer provides:** `history` meta (`count`, `first`, `last`) and `replay` state from the engine. `replay` is `null` when the office is live.
- Play calls `onPlay(from, speed)`. From live, play starts at `history.first`. In a paused replay, play starts at `replay.t`.
- Pause calls `onPause`. If you do not give `onPause`, pause calls `onStop`.
- The range moves from `history.first` to `history.last`. A change calls `onSeek(t)`. The time labels use the mono font.
- Speed buttons are toggles with `aria-pressed`. A change during play calls `onPlay(t, speed)`.
- "Live" calls `onStop`. It is pressed when the office is live.
- Keyboard: Left and Right move 1 minute, Shift moves 10 minutes, Page Up and Page Down move one tenth, Home and End go to the start and the end. `aria-valuetext` gives the clock time, for example "Replay at 09:30:42".
- Empty state: "No history yet". The controls are off.
- At 460 px and less, the range goes on its own line.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `history` | yes | `{ count: number; first: number; last: number }` |
| `replay` | yes | `{ playing: boolean; from: number; to: number; t: number; speed: number } \| null` |
| `onPlay` | no | `(from: number, speed: number) => void` |
| `onPause` | no | `() => void` |
| `onStop` | no | `() => void` |
| `onSeek` | no | `(t: number) => void` |
