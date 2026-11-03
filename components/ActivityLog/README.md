# ActivityLog

The newest events first: time, bot, and what changed. Show 5 rows on desktop and 20 in the phone sheet. One line per event; truncate, do not wrap.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `entries` | yes | `{ time: string; name: string; text: string }[]` |
