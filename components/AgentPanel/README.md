# AgentPanel

The panel that opens when you select a bot: a header with the bot, its role badges and model, then tabs. **Chat** is the conversation. **Trace** is the plan, cost and every step of the run (delegations, tool calls, checkpoints). **Sessions** lists the runs of the agent. **Agent** is the agent card (identity, tools, knowledge, skills, channels).

- **Extra tabs.** Pass `extraTabs` to add tabs: `[{ id, label, icon?, count?, after?, render(bot) }]`. An extra tab goes last, or after the tab named in `after`. `render` gets the bot and returns the content. An id that is the same as a built-in tab is ignored.
- **Hide tabs.** Pass `hideTabs`, for example `["trace"]`, to remove built-in tabs. If the open tab is hidden, the first tab shows.
- **Change.** `onTabChange(id)` runs when the person picks a tab.

**The consumer provides:** the bot, the messages, the steps, the plan, the cost and the handlers.

## Props

AgentPanel takes the props of `AgentChat` and these:

| Prop | Required | Type |
| --- | --- | --- |
| `tab` | no | `"chat" \| "trace" \| "sessions" \| "agent"` |
| `steps` | no | `TraceStep[]` |
| `plan` | no | `{ goal?: string; steps: PlanCardProps["steps"] } \| null` |
| `cost` | no | `CostMeterProps` |
| `agent` | no | `AgentCardProps["agent"]` |
| `onRollback` | no | `(cp: unknown) => void` |
| `extraTabs` | no | `{ id: string; label: string; icon?: string; count?: number \| null; after?: string; render: (bot) => ReactNode }[]` |
| `hideTabs` | no | `("chat" \| "trace" \| "sessions" \| "agent")[]` |
| `onTabChange` | no | `(id: string) => void` |
