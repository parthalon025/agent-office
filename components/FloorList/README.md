# FloorList

The list of floors, top floor first. Pips show each bot status; the ratio shows working over total; a floor with more than one room shows the room count. Add floor puts a new floor on top of the building.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `floors` | yes | `{ id: number; name: string; statuses: Status[]; rooms?: number }[]` |
| `current` | yes | `number \| null` |
| `onSelect` | no | `(id: number) => void` |
| `onAdd` | no | `() => void` |
