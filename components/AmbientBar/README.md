# AmbientBar

A thin status strip for a second screen or a narrow window. The person sees the state of each floor and what needs them, without the 3D scene.

- **Consumer provides:** `floors` from the office snapshot, the snapshot `log` (or one `last` entry), and `onOpen`.
- Each floor chip shows its number and a dot with a count for working, needs you, errors and resting. Screen readers and the tooltip get the words, for example "Floor 2, Sales: 2 working, 1 needs you". At 1400 px and more, the words also show.
- A bot with a `request` counts as "needs you".
- The needs-you count uses `emphasis` when it is more than 0: "3 need you". Else it says "Nothing needs you".
- The last activity line shows the newest log entry.
- "Open office" calls `onOpen`.
- Widths: one line above 900 px. At 900 px and less, the activity line goes under the floors. At 640 px and less, "Open office" shows the icon only. At 440 px and less, the button hides and the floors scroll.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `floors` | yes | `{ id: number; key?: string; name: string; rooms: { id: string; bots: { name: string; status: "working" \| "waiting" \| "error" \| "resting" \| "finished"; request?: { id?: string; text: string } \| null }[] }[] }[]` |
| `log` | no | `{ time: string; name: string; text: string }[]` |
| `last` | no | `{ time?: string; name: string; text: string } \| null` |
| `name` | no | `string` |
| `onOpen` | no | `() => void` |
