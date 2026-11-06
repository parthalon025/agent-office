# Logos (Agent Office DS x1.7.18)

The Agent Office mark is a square with one centred dot (diameter = 40% of the size). Its corner comes from the theme: the `logo-mark-radius` token (25% of the size, a rounded square, in most themes; 50%, a circle, in Sublevel). The wordmark is "Agent Office", converted to paths. The lockup puts the mark and the wordmark side by side. The gap is 0.4 x the mark size. The wordmark cap height is 0.5 x the mark size and the cap band is centred on the mark.

In the page, `Logo` draws the logo of the theme it sits in: the nearest `data-theme` on it or a parent (`AgentOffice.themeOf`). Each theme names its wordmark in its `AgentOffice.MODES` entry (`wordmark`), and the mark takes `ink`, `bg` and `logo-mark-radius` from the theme's tokens. No theme has a logo file of its own.

| Wordmark (`AgentOffice.LOGO.wordmarks`) | Drawing | Themes |
|---|---|---|
| `sans` | "Agent Office" in IBM Plex Sans SemiBold. | Day, Night, Fluent, Fluent Dark |
| `wide` | "AGENT OFFICE" in Archivo SemiBold, width 118, tracked +0.14 em. Cap height = 0.4 x the mark size (the wide caps look larger than Plex). | Sublevel |

## Files

The files are the logo of the first theme (Day), for use outside the page.

| File | Use |
|---|---|
| `mark.svg` | Mark on light grounds: `#18212b` square, `#e9edf1` dot. |
| `mark-inverse.svg` | Mark on dark grounds: colours inverted. |
| `wordmark.svg` / `wordmark-inverse.svg` | Wordmark only (`#18212b` / `#e9edf1`). |
| `lockup.svg` / `lockup-inverse.svg` | Mark + wordmark. Default logo for headers and covers. |

For another theme as a file, call `AgentOffice.LOGO.mark(ink, dot, radius)` with the theme's `ink`, `bg` and `logo-mark-radius` (as a share: 0.5 for 50%), and take the wordmark path from `AgentOffice.LOGO.wordmarks[name]`.

## Clear space
Keep clear space on all sides equal to the dot diameter (40% of the mark size). For the 64 px master, this is 25.6 px.

## Minimum size
- Mark: 16 px.
- Lockup: 96 px wide.
Below these sizes, use the mark only.

## Do
- Use the plain files on `bg`, `panel` or white. Use the inverse files on a dark `bg` or `panel`.
- Scale the files proportionally.
- Use the mark alone for app icons, favicons and small spaces.

## Do not
- Do not change the colours, or use the type colours or status colours on the logo.
- Do not stretch, rotate, outline or add shadows or gradients.
- Do not move the dot or change its size.
- Do not set "Agent Office" in live text as the logo. Use the outlined wordmark.
- Do not put the logo on busy 3D scene areas without a `panel` behind it.
- Do not mix a mark and a wordmark of two themes.

Wordmark sources: IBM Plex Sans SemiBold (SIL OFL 1.1), outlined with fontTools (kerning: harfbuzz). Archivo (SIL OFL 1.1, @fontsource-variable/archivo 5.3.0), static instance wght 600 / wdth 118, outlined with fontTools (kerning: harfbuzz). The outlining script is not in this repo.
