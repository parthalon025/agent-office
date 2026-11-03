# UsageMeter

The weekly usage limit: one figure, one bar, and the four bots that use the most. The bar uses `ink`, not a status color, because usage is not a bot state.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `percent` | yes | `number` |
| `reset` | yes | `string` |
| `rows` | no | `{ name: string; color: string; percent: number }[]` |
