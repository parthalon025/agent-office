# BotLineup

The four bot shapes (blob, cone, octa, capsule) with their status bubbles, on a plinth. A bot is one solid in one body color with two eyes. Do not use a status, floor or type color as a body color.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `bots` | no | `{ shape: "blob" \| "cone" \| "octa" \| "capsule"; color: string; status: Status }[]` |
| `spin` | no | `number` |
| `height` | no | `number` |
| `mode` | no | `"auto" \| "day" \| "night"` |
