# Bot portraits (Agent Office DS x1.7.11)

Front three-quarter flat portraits of the four bot shapes. viewBox `0 0 96 96`. Each portrait has a body colour, a shade tone (body darkened 24%), a highlight (body lightened 32%), two eyes and a soft ellipse shadow. The far eye is a little narrower to give the three-quarter turn.

| File | Shape | Default body |
|---|---|---|
| `blob.svg` | Sphere | `#4f8cff` |
| `cone.svg` | Cone | `#4cb35a` |
| `octa.svg` | Dodecahedron (front face, five side faces) | `#ff8a3d` |
| `capsule.svg` | Capsule (pill) | `#9b4fd1` |

## One drawing, styled by the theme

There is one drawing per shape for every theme. The theme's `portrait-*` tokens style it (`bundle.css`, classes `ao-pt-*`), so a theme has no portrait files of its own:

| Token | Does |
|---|---|
| `portrait-gloss` | 1 shows the highlight and the soft shadow; 0 draws the bot flat (Sublevel). |
| `portrait-outline` | 1 draws a 1.5 px outline, the inner facet edges of the octa (1 px) and a thin floor line under the bot, in `portrait-ink` (Sublevel); 0 draws none. |
| `portrait-eyes-square` | 1 draws square eyes (Sublevel); 0 round eyes. |
| `portrait-ink` | Colour of the eyes and the lines: `#11161c`, or `#102a33` in Sublevel. |

`BotAvatar` draws `AgentOffice.PORTRAITS[shape](color)`. To use a different body colour, pass it: the function calculates the shade and highlight from the colour. Use the portraits at 24 px or larger. Do not add outlines or more colours by hand: set the tokens.

## Files

The files are the portraits of the first theme (Day), for use outside the page. For a file in another theme, call `AgentOffice.PORTRAITS[shape](color, look)` with `look = { ink, gloss, outline, eyesSquare }`, the values of that theme's `portrait-*` tokens. `test/components.test.mjs` checks that each file is the drawing of the first theme.
