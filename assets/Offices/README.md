# Office type pictures (Agent Office DS x1.7.11)

Flat isometric (30 degree) room pictures. viewBox `0 0 320 200`. Each room has a floor tile, a back wall, a left wall and the signature items of the room type. A thin stripe in the type colour runs along the front edges of the floor. Each room shows two or three tiny bots.

| Room type | File | Items |
|---|---|---|
| Team floor | `team.svg` | Round desks with monitors, a lounge with a rug and an L sofa, a whiteboard. |
| Lab / server room | `lab.svg` | Server racks with LED dots, a cable tray, a work bench with test gear. |
| Studio | `studio.svg` | A stage in front of a curved cyc wall, a light on a stand, a camera on a tripod. |
| War room / HQ | `hq.svg` | A long table with seats on all sides, a wall of screens, a map screen. |
| Security | `security.svg` | Six wall screens, three on each wall, each a small rule grid (Allow, Deny and Ask cells) in a frame of the type colour. No bots: the room has none. The room shell is the HQ one. |

## Drawn from the tokens of the theme

There is one drawing per type for every theme: `AgentOffice.officePicture(type, tok, style)`. Its colours are the theme's tokens: the scene tokens (floor, walls, wood, chair, rug, slab, glass, metal, dark), `type-*` for the stripe and the type items, and the status tokens for the LEDs and the rule cells, some of them darkened or lightened. Props (the bots, some fittings) keep their own colours. So a theme gets its pictures from its tokens, and has no picture files of its own. `OfficeTypeCard` reads the tokens of the theme it sits in.

The style comes from the theme's `AgentOffice.MODES` entry:

- `dark: true` (Night, Fluent Dark): screens and LEDs glow (stacked soft circles, no filters), and small warm lamp pools (`#f2b766`) lie on the floor, the bench, the stage or the table.
- `retro: true` (Sublevel): carpet tiles, a low wainscot band on the walls, boxy terminals with tiny number grids in place of monitors, and bots with square eyes.

The glows use opacity only: no gradients, filters or ids, so many pictures can share one page.

## Files

The files are the pictures of the first theme (Day), for use outside the page. `test/components.test.mjs` checks that each file is the drawing of the first theme, byte for byte.
