# UsageMeter

The weekly usage limit: one figure, one bar, and the four bots that use the most. The bar uses `ink`, not a status color, because usage is not a bot state.

Spend is optional. Set `cost` to show a Spend line under the bar. Add `costLimit` to show "$0.42 of $2.00" and a second bar. A row can have its own `cost`. Without `percent`, the meter shows spend only. The `usage` event fills these props: `cost`, `costLimit` and `costs` (spend of each bot, by name).

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `percent` | no | `number` |
| `reset` | yes | `string` |
| `cost` | no | `number` |
| `costLimit` | no | `number` |
| `rows` | no | `{ name: string; color: string; percent?: number; cost?: number }[]` |
