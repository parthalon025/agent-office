# Bot portraits (Agent Office DS x1.5)

Front three-quarter flat portraits of the four bot shapes. viewBox `0 0 96 96`. Each portrait has a body colour, a shade tone (body darkened 24%), a highlight (body lightened 32%), two eyes in `#11161c` and a soft ellipse shadow. The far eye is a little narrower to give the three-quarter turn.

| File | Shape | Default body |
|---|---|---|
| `blob.svg` | Sphere | `#4f8cff` |
| `cone.svg` | Cone | `#4cb35a` |
| `octa.svg` | Dodecahedron (front face, five side faces) | `#ff8a3d` |
| `capsule.svg` | Capsule (pill) | `#9b4fd1` |

To use a different body colour, call `AgentOffice.PORTRAITS[shape](color)` from `src/assets.js`. It returns the SVG string and calculates the shade and highlight from the colour. Use the portraits at 24 px or larger. Do not add outlines or more colours.

## Sublevel portraits
`<shape>-sublevel.svg` for `blob`, `cone`, `octa`, `capsule`. Flat: one body tone and one shade (body darkened 24%), no highlight, no soft shadow. A 1.5 px outline in `#102a33` (inner facet edges of the octa: 1 px), square eyes in `#102a33`, and a thin floor line at y = 80. Same default body colours as above. Use them only in the Sublevel theme.

To recolour, call `AgentOffice.PORTRAITS_SUBLEVEL[shape](color)`.
