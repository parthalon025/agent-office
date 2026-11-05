# FluentOffice

The office in the Fluent theme: a bright, quiet office in soft daylight. Neutral grey walls and floors, pale ash desks, charcoal chairs, a soft blue carpet in the lounge, blue-tinted glass, and a pale sky with a light skyline in the window. Light is soft and even, with low bloom, a light haze and no vignette. Panels are light layered surfaces with a hairline border, 8 px corners and a soft two-layer shadow; controls have 4 px corners. Heads are sentence case and semibold. The current floor row, the selected bot row and the pressed mode segment show a short accent pill. Text uses the system faces (Segoe UI Variable, Cascadia Mono, with fallbacks), so the theme loads no font file.

The look follows the open, MIT-licensed Fluent 2 design tokens (neutral ramp, brand blue, status colors, corner radii, elevation). It is an original look: it shows no product logo, no product name and no product art.

Any component takes the theme: set `data-theme="fluent"` on a parent, or pass `theme:"fluent"` to OfficeScene. In the HUD, the Fluent button switches the scene and the panels together. The bubbles, status meanings and actions do not change, so the office reads the same in every theme.

FluentOffice is OfficeScene with `theme` set to `"fluent"`. It takes every OfficeScene prop. It does not pick a solution: pass `building` or `solution` as for OfficeScene.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `theme` | no | `"light" \| "dark" \| "sublevel" \| "fluent"` (default `"fluent"`) |
| `building` | no | `BuildingDef` |
| `solution` | no | `"hq" \| "microsoft" \| "hermes" \| "copilot"` |
| `adapter` | no | `AgentAdapter \| null` |
| `floor` | no | `number` |
| `view` | no | `"floor" \| "building"` |
| `mode` | no | `"auto" \| "day" \| "night" \| "sublevel" \| "fluent"` |
| `height` | no | `number` |
| `quality` | no | `Quality` |
| `intro` | no | `boolean` |
| `hud` | no | `boolean` |
| other | no | Every other OfficeScene prop (see OfficeScene) |

Consumer provides: a building or a solution, an adapter (or the mock), and the height. The theme tokens come from `tokens.css`; the faces are the system faces, so the page loads no font file for this theme.
