# AgentCard

One agent's identity and reach: platform, owner, identity, model (and fallback), tools, knowledge, skills, channels, triggers and cost. It is the Agent tab of the AgentPanel.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `agent` | yes | `{ name: string; shape?: Shape; color?: string; status?: Status; platform?: string; owner?: string; identity?: string; model?: string; fallback?: string; tools?: string[]; knowledge?: string[]; skills?: string[]; channels?: string[]; triggers?: string[]; cost?: string }` |
