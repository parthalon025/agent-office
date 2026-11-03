# RichText

Safe Markdown for one chat message. It makes React elements and text nodes only. It does not parse or inject HTML, so `<img onerror=...>` shows as text.

Supported: paragraphs and line breaks, **bold**, *italic*, ~~strike~~, `inline code`, code blocks with a language label and a Copy button, headings (small sizes, for chat), bullet and numbered lists with one nested level, task lists (read only), quotes, tables (they scroll when they are wide), rules, links, bare URLs and images.

Rules:

- Links open in a new tab with `rel="noopener noreferrer nofollow"`. The domain shows on hover.
- Links accept `http`, `https` and `mailto` only. A link with a different scheme shows as text.
- Images accept `http`, `https` and `data:image/png`, `jpeg`, `gif` or `webp` only. A different image URL shows the card "Image not available".
- Text that is not complete is safe to show while it streams. A code block that does not close shows to the end of the text.
- Set `collapseAt` to collapse long text behind "Show more".

Use `tone="inverse"` on an accent fill (the user bubble). Outside a `ChatMessage`, RichText has its own image viewer.

API: `AgentOffice.RichText` (component) and `AgentOffice.rich.parse(markdown)` (React elements). `AgentOffice.rich.tokens(markdown)` gives the token tree; `AgentOffice.rich.safeUrl(url, kind)` gives the safe URL or `null`.

**The consumer provides:** the text and, if necessary, the format, the tone and the collapse length.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `text` | yes | `string` |
| `format` | no | `"plain" \| "markdown"` |
| `tone` | no | `"default" \| "inverse"` |
| `collapseAt` | no | `number` |
| `className` | no | `string` |
