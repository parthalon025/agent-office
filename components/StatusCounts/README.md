# StatusCounts

The summary strip of the whole office. It counts bots in each state across all floors. Put it at top center; it is the first thing to read.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `counts` | yes | `Partial<Record<"working" \| "waiting" \| "error" \| "resting", number>>` |
