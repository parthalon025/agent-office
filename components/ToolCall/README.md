# ToolCall

One tool call: status, tool name, kind (MCP, connector, code, terminal, browser, computer use, agent flow, knowledge, skill, memory, API) and time. Open it to see the arguments and the result.

**The consumer provides:** the call data.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `call` | yes | `ToolCallData` |
| `open` | no | `boolean` |
