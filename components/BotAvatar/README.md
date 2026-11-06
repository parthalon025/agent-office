# BotAvatar

A flat portrait of a bot for use outside the 3D scene: lists, notifications, docs. It takes the bot's shape and body color, and an optional status dot. There is one drawing per shape; the `portrait-*` tokens of the theme it sits in style it (gloss, outline, square eyes, ink), so Sublevel shows its flat outlined bots with no file of its own (`assets/Bots/README.md`).

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `shape` | yes | `Shape` |
| `color` | yes | `string` |
| `status` | no | `Status` |
| `size` | no | `number` |
