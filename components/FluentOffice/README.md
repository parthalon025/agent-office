# FluentOffice

The office in the Fluent look, in two modes: Fluent (`fluent`) and Fluent Dark (`fluent-dark`).

**Fluent** is a bright, quiet office in soft daylight. Neutral grey walls and floors, pale ash desks, charcoal chairs, a soft blue carpet in the lounge, blue-tinted glass, and a pale sky with a light skyline in the window. Light is soft and even, with low bloom, a light haze and no vignette. Panels are light layered surfaces with a hairline border and a soft two-layer shadow.

**Fluent Dark** is the same office at night. Charcoal walls and floors, walnut desks, slate chairs, a deep blue carpet, dark blue glass, and a dusk sky with a crescent moon over a dark skyline with a few lit windows. The room lamps are on but softer than in Night, the screens glow, each desk has a pool of screen light, and the haze and the vignette are light. Panels are dark layered surfaces (`#1f1f1f` page, `#292929` glass panels, `#333333` chips) with a white hairline at 10% and a deeper two-layer shadow. The accent is the light brand blue of Fluent 2 (`#479ef5`, `colorBrandForeground1`) with dark text on it, and accent text is `#62abf5` (`colorBrandForeground2`), so it is 5.2:1 on a chip; status colors are the lighter tints, so they read on the dark surfaces. Bubbles stay a light face (`#f5f5f5`), so status words on them use the dark `status-*-on-bubble` tokens. Fluent Dark is a dark theme (`dark: true` in `AgentOffice.MODES`), like Night, so the browser draws its scrollbars and check boxes dark too (`color-scheme: dark`).

Both modes have 8 px panel corners and 4 px control corners, sentence-case semibold heads, and a short accent pill on the current floor row, the selected bot row and the pressed mode segment. Text uses the system faces (Segoe UI Variable, Cascadia Mono, with fallbacks), so neither mode loads a font file. `bundle.css` sets these once for the family, on `[data-theme|="fluent"]`; only the colors, the shadow and the scene light differ.

The look follows the open, MIT-licensed Fluent 2 design tokens (neutral ramp, brand blue, status colors, corner radii, elevation). Reference, "Fluent 2 source of Fluent and Fluent Dark", names the source token of each color, and the reason where a color differs. It is an original look: it shows no product logo, no product name and no product art.

Any component takes the theme: set `data-theme="fluent"` or `data-theme="fluent-dark"` on a parent, or pass `theme` to OfficeScene. In the HUD, the Fluent and Fluent Dark buttons switch the scene and the panels together. The bubbles, status meanings and actions do not change, so the office reads the same in every theme.

FluentOffice is OfficeScene with `theme` set to `"fluent"`. Pass `theme: "fluent-dark"` for Fluent Dark. It takes every OfficeScene prop. It does not pick a solution: pass `building` or `solution` as for OfficeScene.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `theme` | no | `"light" \| "dark" \| "sublevel" \| "fluent" \| "fluent-dark"` (default `"fluent"`) |
| `building` | no | `BuildingDef` |
| `solution` | no | `"hq" \| "microsoft" \| "hermes" \| "copilot"` |
| `adapter` | no | `AgentAdapter \| null` |
| `floor` | no | `number` |
| `view` | no | `"floor" \| "building"` |
| `mode` | no | `"auto" \| "day" \| "night" \| "sublevel" \| "fluent" \| "fluent-dark"` |
| `height` | no | `number` |
| `quality` | no | `Quality` |
| `intro` | no | `boolean` |
| `hud` | no | `boolean` |
| other | no | Every other OfficeScene prop (see OfficeScene) |

Consumer provides: a building or a solution, an adapter (or the mock), and the height. The theme tokens come from `tokens.css`; the faces are the system faces, so the page loads no font file for either mode.
