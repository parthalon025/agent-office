# AgentChat

The conversation with one bot: header with portrait, status line and role, the message log, quick actions, and a text box. An approval request shows as a card with Approve and Decline. Messages go to the adapter as `message` commands; the bot's reply comes back as a `message` event.

Messages show Markdown, images, files, links, video and audio (see `ChatMessage` and `RichText`).

Quick actions send plain messages (Status, Summarize, Pause or Resume), plus Retry when the bot has an error.

To attach files, the user can:

- Select the attach button ("Attach a file") and select files.
- Paste an image into the text box.
- Drag files onto the chat and drop them.

The files show above the text box with a remove button. The user can send files with no text. `onSend(text, attachments)` gets the files as `ChatAttachment` objects: raster images up to 5 MB as `data:` URLs, other files as `blob:` URLs. The Composer removes its `blob:` URLs when it closes, so keep or upload the files before that. Set `attach={false}` to remove the attach button, paste and drop.

**The consumer provides:** the bot, the messages, `connected`, and the send, action and close handlers. Set `loading` while history loads and `disabled` when nothing can be sent. To send files to the agent, pass the second argument of `onSend` on: `office.message(botName, text, attachments)`.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `loading` | no | `boolean` |
| `disabled` | no | `boolean` |
| `bot` | yes | `{ name: string; shape: Shape; color: string; role?: Role; status: Status; task: string }` |
| `messages` | yes | `ChatMessageData[]` |
| `connected` | no | `boolean` |
| `attach` | no | `boolean` |
| `onSend` | no | `(text: string, attachments?: ChatAttachment[]) => void` |
| `onAction` | no | `(type: "approve" \| "decline" \| "retry", request?: unknown) => void` |
| `onClose` | no | `() => void` |
