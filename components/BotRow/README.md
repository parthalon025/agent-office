# BotRow

One bot in the roster: portrait in its shape and body color with a status dot, name, role icon, and the status line `State · Task`. Selecting a row also selects the bot in the scene.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `name` | yes | `string` |
| `color` | yes | `string` |
| `shape` | no | `Shape` |
| `role` | no | `Role` |
| `status` | yes | `Status` |
| `task` | yes | `string` |
| `selected` | no | `boolean` |
| `onClick` | no | `() => void` |
