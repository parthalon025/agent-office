# AgentPanel

The panel that opens when you select a bot: a header with the bot, its role badges and model, then tabs. **Chat** is the conversation. **Trace** is the plan, cost and every step of the run (delegations, tool calls, checkpoints). **Sessions** lists the runs of the agent. **Agent** is the agent card (identity, tools, knowledge, skills, channels).

- **Extra tabs.** Pass `extraTabs` to add tabs: `[{ id, label, icon?, count?, after?, render(bot) }]`. An extra tab goes last, or after the tab named in `after`. `render` gets the bot and returns the content.
  - An id has letters, digits and dashes only (`terminal`, `dev-log-2`). The panel uses the id in element ids. An extra tab with any other id (a space, an underscore, a dot, an empty id) is ignored.
  - An extra tab with the id of a built-in tab, or the id of an earlier extra tab, is ignored.
  - If `after` names a tab that is hidden (see `hideTabs`) or that does not exist, the extra tab goes last.
- **Hide tabs.** Pass `hideTabs`, for example `["trace"]`, to remove built-in tabs. If the open tab is hidden, the first tab shows, and `onTabChange` runs once with its id.
- **Change.** `onTabChange(id)` runs when the person picks a tab. It also runs when the panel moves to the first tab because the open tab is hidden or gone.
- **Controlled tab.** Without `activeTab`, `tab` is only the first tab and the panel keeps the open tab itself (as before). Pass `activeTab` (a tab id, built-in or extra) to control it: the panel then shows that tab and changes only when you change `activeTab`. Keep it in step with `onTabChange`. An `activeTab` that is hidden or unknown shows the first tab, and `onTabChange` runs with its id so you can correct your state. In `OfficeScene`, the prop is `agentTab`.

**The consumer provides:** the bot, the messages, the steps, the plan, the cost and the handlers.

## Props

AgentPanel takes the props of `AgentChat` and these:

| Prop | Required | Type |
| --- | --- | --- |
| `tab` | no | `"chat" \| "trace" \| "sessions" \| "agent"` |
| `activeTab` | no | `string` |
| `steps` | no | `TraceStep[]` |
| `plan` | no | `{ goal?: string; steps: PlanCardProps["steps"] } \| null` |
| `cost` | no | `CostMeterProps` |
| `agent` | no | `AgentCardProps["agent"]` |
| `onRollback` | no | `(cp: unknown) => void` |
| `extraTabs` | no | `{ id: string; label: string; icon?: string; count?: number \| null; after?: string; render: (bot) => ReactNode }[]` |
| `hideTabs` | no | `("chat" \| "trace" \| "sessions" \| "agent")[]` |
| `onTabChange` | no | `(id: string) => void` |
