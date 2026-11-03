# ChatMessage

One message in a chat. Three senders: the user (right, accent fill), the agent (left, chip fill) and the system (center, muted, plain text). A message to a group shows its target. A request message carries Approve and Decline until the user answers.

The body is Markdown by default (`format: "markdown"`), for the agent and for the user. `RichText` renders it. Set `format: "plain"` to show the text as is; bare URLs still become links.

Attachments show under the body:

- **Images** show in the bubble, 280 px high at most. Two or more images make a 2-column grid. Select an image to open the image viewer. Arrow keys move between the images of the message. Escape closes the viewer.
- **Files** show as a card with an icon, the name, the type, the size and a Download link.
- **Links** show as a card with the site, the title and the description. The office does not fetch link data: it shows only the data in the attachment.
- **Video and audio** use the browser controls.
- An image that does not load shows the card "Image not available".

An agent message with code, a table or an image grows to 92% of the chat width. A message longer than 1200 characters collapses. "Show more" opens it.

**The consumer provides:** the message (`from`, `text`, `time`, and optional `to`, `request`, `attachments`, `format`) and the action handler. URLs must be `http`, `https` or `mailto` (links), or raster `data:image` (images). Local attachments from the Composer can use `blob:`. Other URLs do not show.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `message` | yes | `ChatMessageData` |
| `collapseAt` | no | `number` |
| `onAction` | no | `(type: "approve" \| "decline", request?: unknown) => void` |
