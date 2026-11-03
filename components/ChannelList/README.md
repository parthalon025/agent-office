# ChannelList

Where requests come in and which agent each channel routes to: Hermes gateway platforms (CLI, Discord, API server, IDE) or Copilot channels (Teams, Microsoft 365 Copilot, website, email).

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `channels` | yes | `{ id: string; name: string; route?: string; today?: number }[]` |
