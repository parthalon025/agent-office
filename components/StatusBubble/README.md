# StatusBubble

The bubble above a bot in the 3D scene, drawn here as a flat reference for the sprite. The glyph and its color say the state. The glyph uses `status-*-on-bubble`, which reads at 4.5:1 on the light bubble face in every theme. The raw `status-*` colors do not. The consumer advances `frame` (0–2) about every 0.35 s for the working dots.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `status` | yes | `Status` |
| `frame` | no | `number` |
