# RoomScene

One floor with rooms you choose, without the HUD. Use it to show an office type, or to embed one team's room in another page. The preview shows the five office types side by side: team floor, lab, studio, war room and Security room (no bots).

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `type` | no | `OfficeType` |
| `quality` | no | `Quality` |
| `name` | no | `string` |
| `bots` | no | `BotDef[]` |
| `rooms` | no | `RoomDef[]` |
| `floorKey` | no | `FloorKey \| "hq"` |
| `simulate` | no | `boolean` |
| `height` | no | `number` |
| `mode` | no | `"auto" \| "day" \| "night"` |
