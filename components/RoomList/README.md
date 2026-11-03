# RoomList

The rooms on the current floor: type icon, name, type, and working over total. Click a room to frame it; click again to see the whole floor. The bot button adds a bot with a role that fits the type. Add room opens a type picker.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `rooms` | yes | `{ id: string; name: string; type: OfficeType; bots: number; working: number }[]` |
| `current` | no | `string \| null` |
| `onSelect` | no | `(id: string) => void` |
| `onAddBot` | no | `(roomId: string) => void` |
| `onAddRoom` | no | `(type: OfficeType) => void` |
