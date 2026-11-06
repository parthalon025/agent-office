# Manager board

The Manager board shows one plan for each goal: the steps, who works on each step and what it costs. A plan comes from one of two sources. Open the board from the dialogs in Ctrl+K (**Manager board**). When a plan waits for you, the Ctrl+K entry says so.

## The two plan sources

- **Office.** The office Manager turns one goal into steps and hands each step to an agent that is free. Steps run one after the other. You approve the plan first. The Manager checks the spend limit before every step it starts, never after. A goal that can reach a paid agent gets the default spend limit (set in **Attach sessions**). A goal that only local agents can take has none, because they cost $0. Agent mail inside a goal has a hop cap and a message cap, so a reply chain stops.
- **Paperclip.** When a company is connected, the board lists its tasks as plans. This source is read only: no button on the board writes to Paperclip, except the handoff below. If Paperclip is not connected, its last plan shows as frozen and is never shown as current. See [Paperclip HQ](paperclip.md).

## What you can do

- **Approve** a plan that waits for approval. Nothing starts before that.
- **Retry** a step that failed.
- **Cancel goal** while it is open. The office stops the steps that run.
- **Hand a goal to Paperclip.** When a company is connected, an office goal can become Paperclip tasks. The dialog **Hand this goal to Paperclip** lists the exact tasks first, and **Create** is the Confirm. The office creates one backlog task for each step, and does nothing else: it never assigns a task, runs a routine, sends a heartbeat or changes a budget. Each task starts with the goal id and the step id, so a retry after a partial failure writes only the steps that are still missing. After the handoff the goal belongs to Paperclip, the board shows **Handed to Paperclip**, and the office stops dispatching it. The decision record is [ADR 0007](adr/0007-paperclip-goal-handoff-write.md).

The rules of the Manager are in `manager.mjs` and the board words in `public/vocab.js` (`plan`). The Security room rules apply to every agent a goal starts, as to any other agent ([Security](security.md)).
