# HermesOffice

The Hermes orchestrator office. Floor 4 Command holds **Hermes** (the orchestrator) with the cron scheduler, memory curator and skill librarian. Floor 3 Tools Lab holds the sandbox (terminal, code execution, browser) and an MCP bay. Floor 2 is the subagent pool. Floor 1 Gateway holds the channel bots (API server, CLI, Discord, voice).

Every few seconds the mock runs one full orchestration: Hermes loads a skill, plans 3 steps, delegates to a pool agent (a dashed line flies between the desks), spawns a temporary subagent for step 2, which calls a tool, takes a checkpoint and returns, then Hermes replies. Click Hermes and open **Trace** to see the plan and every step.
