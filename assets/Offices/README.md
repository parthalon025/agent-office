# Office type thumbnails (Agent Office DS x1.6.10)

Flat isometric (30 degree) room thumbnails. viewBox `0 0 320 200`. Each room has a floor tile, a back wall, a left wall and the signature items of the room type. All items use the scene colours of the theme. A thin stripe in the type colour runs along the front edges of the floor. Each room shows two or three tiny bots. The layout of a room type is the same in all three themes.

| Room type | Day | Night | Sublevel | Type colour (Day / Night / Sublevel) | Items |
|---|---|---|---|---|---|
| Team floor | `team.svg` | `team-night.svg` | `team-sublevel.svg` | `#3a7ca5` / `#5f9fc8` / `#2f6b7a` | Round desks with monitors, a lounge with a rug and an L sofa, a whiteboard. |
| Lab / server room | `lab.svg` | `lab-night.svg` | `lab-sublevel.svg` | `#0f8b8d` / `#2fb3b5` / `#0f7f7c` | Server racks with LED dots, a cable tray, a work bench with test gear. |
| Studio | `studio.svg` | `studio-night.svg` | `studio-sublevel.svg` | `#c2477a` / `#e0709a` / `#b03f6e` | A stage in front of a curved cyc wall, a light on a stand, a camera on a tripod. |
| War room / HQ | `hq.svg` | `hq-night.svg` | `hq-sublevel.svg` | `#a36a12` / `#d0922e` / `#946010` | A long table with seats on all sides, a wall of screens, a map screen. |
| Security | `security.svg` | `security-night.svg` | `security-sublevel.svg` | `#6650b8` / `#9a86e8` / `#5a48a6` | Six wall screens, three on each wall, each a small rule grid (Allow, Deny and Ask cells) in a frame of the type colour. No bots: the room has none. The room shell is the HQ one. |

## Themes
- **Day** (`<type>.svg`): the x0.2 thumbnails, unchanged.
- **Night** (`<type>-night.svg`): Night scene colours (floor `#2a3039`, walls `#232a34` / `#1e242d`). Screens and LEDs glow (stacked soft circles, no filters). Small warm lamp pools (`#f2b766`) on the floor, the bench, the stage or the table.
- **Sublevel** (`<type>-sublevel.svg`): green carpet (`#2f6456`, small carpet tiles), white desks (`#f1f1ea`), black chairs (`#1c2326`), off-white walls with a low wainscot band, boxy off-white terminals with tiny number grids (`#cfe3e0` on `#102a33`). Bots have square eyes.

The glows use opacity only: no gradients, filters or ids, so many thumbnails can share one page.

In code: `AgentOffice.THUMBS` is the Day set. `AgentOffice.THUMBS_BY_THEME.light`, `.dark` and `.sublevel` hold the three sets (`light` is the same object as `THUMBS`).
