# FloorList

The list of floors, top floor first. Pips show each bot status; the ratio shows working over total; a floor with more than one room shows the room count. Add floor puts a new floor on top of the building.

In the office HUD at 820 px and below, the list is one strip that scrolls sideways. Each row keeps the width of its name, and the strip scrolls the current floor into the middle when the floor, the list or the window changes.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `floors` | yes | `{ id: number; name: string; statuses: Status[]; rooms?: number }[]` |
| `current` | yes | `number \| null` |
| `onSelect` | no | `(id: number) => void` |
| `onAdd` | no | `() => void` |
