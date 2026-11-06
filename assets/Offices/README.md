# Office type pictures (Agent Office DS x1.7.15)

Flat isometric (30 degree) room pictures. viewBox `0 0 320 200`. Each room has a floor tile, a back wall, a left wall and the signature items of the room type. A thin stripe in the type colour runs along the front edges of the floor. Each room shows two or three tiny bots.

| Room type | File | Items |
|---|---|---|
| Team floor | `team.svg` | Round desks with monitors, a lounge with a rug and an L sofa, a whiteboard. |
| Lab / server room | `lab.svg` | Server racks with LED dots, a cable tray, a work bench with test gear. |
| Studio | `studio.svg` | A stage in front of a curved cyc wall, a light on a stand, a camera on a tripod. |
| War room / HQ | `hq.svg` | A long table with seats on all sides, a wall of screens, a map screen. |
| Security | `security.svg` | Six wall screens, three on each wall, each a small rule grid (Allow, Deny and Ask cells) in a frame of the type colour. No bots: the room has none. The room shell is the HQ one. |
| Lobby / Reception | `lobby.svg` | An L reception counter with a memo on it and a receptionist behind it, a directory board on the back wall, one open desk and a visitor. The stripe is the team colour (`type-team`), as in the scene. |

## Drawn from the tokens of the theme

There is one drawing per type for every theme: `AgentOffice.officePicture(type, tok, style)`. Every colour comes from the theme's tokens: the scene tokens (floor, walls, wood, chair, rug, slab, glass, metal, dark, lamp), `type-*` for the stripe and the type items, the status tokens for the LEDs and the rule cells, `accent` for screen lines and glows, `ink` for the retro terminal faces and `portrait-ink` for the bot eyes and shadows, some of them darkened or lightened. The only colours that are not a token are the tiny bots: their bodies are `AgentOffice.BODY_COLORS`, with the shade a bot portrait has. No colour falls back to the colour of another theme. So a theme gets its pictures from its tokens, and has no picture files of its own. `OfficeTypeCard` reads the tokens of the theme it sits in. `test/skin.test.mjs` draws every picture in every theme and fails on a colour that does not come from a token or from the bot colours.

The style comes from the theme's `AgentOffice.MODES` entry:

- `dark: true` (Night, Fluent Dark): screens and LEDs glow (stacked soft circles, no filters), and small warm lamp pools (`scene-lamp`) lie on the floor, the bench, the stage or the table.
- `retro: true` (Sublevel): carpet tiles, a low wainscot band on the walls, boxy terminals with tiny number grids in place of monitors, and bots with square eyes.

The glows use opacity only: no gradients, filters or ids, so many pictures can share one page.

## Files

The files are the pictures of the first theme (Day), for use outside the page. `test/components.test.mjs` checks that each file is the drawing of the first theme, byte for byte.
