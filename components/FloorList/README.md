# FloorList

The list of floors, top floor first. Pips show each bot status; the ratio shows working over total; a floor with more than one room shows the room count. Add floor puts a new floor on top of the building.

In the office HUD above 820 px the list scrolls inside 150 px, so the rooms, the queue and the roster stay in view in a building with many floors; the current floor scrolls into the middle. Add floor stays below the rows, outside the scroll.

As the elevator panel of a building with function floors (agent-office #92), each floor has a `wing`: the rows of a wing sit together under one header with its name, also when the building's floors mix wings (the Software product preset has Support between Product and tech floors). The wings come in the order of their top floor, and the rows of a wing keep their order, top floor first, so the floor numbers of a mixed building are not in one run. Floors with no wing (`wing: ""`, the ground floor) after the wing groups get a thin rule above them instead of a name, so they do not read as part of the wing above. The floor number is lit with a ring in the status color of the worst state of the floor's desks (error, needs you, review ready, working, finished, resting; `AgentOffice.worstOf`), and the row's label says the state, so the state is never in color alone. An `empty` floor (no agents, open desks only) is dimmed and says "No agents here". ArrowUp and ArrowDown on a row go to the next row with agents as the list shows them: the elevator skips empty floors. A click still goes to an empty floor, so the user can start an agent at one of its desks.

In the office HUD at 820 px and below, the list is one strip that scrolls sideways. Each row keeps the width of its name, and the strip scrolls the current floor into the middle when the floor, the list or the window changes.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `floors` | yes | `{ id: number; name: string; statuses: Status[]; rooms?: number; wing?: string; empty?: boolean; state?: Status \| "review" }[]` |
| `title` | no | `string` (default "Floors"; an office page with function floors says "Elevator") |
| `current` | yes | `number \| null` |
| `onSelect` | no | `(id: number) => void` |
| `onAdd` | no | `() => void` |
