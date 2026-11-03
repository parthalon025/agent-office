# StatusBubble

The bubble above a bot in the 3D scene, drawn here as a flat reference for the sprite. The glyph and its color say the state. The consumer advances `frame` (0–2) about every 0.35 s for the working dots.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `status` | yes | `Status` |
| `frame` | no | `number` |
