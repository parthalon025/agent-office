# Manager board

The Manager board shows one plan for each goal: the steps, who works on each step and what it costs. A plan comes from one of two sources. Open the board from the dialogs in Ctrl+K (**Manager board**). When a plan waits for you, the Ctrl+K entry says so.

## The two plan sources

- **Office.** The office Manager turns one goal into steps and hands each step to an agent that is free. Steps run one after the other. You approve the plan first. The Manager checks the spend limit before every step it starts, never after. A goal that can reach a paid agent gets the default spend limit (set in **Attach sessions**). A goal that only local agents can take has none, because they cost $0. Agent mail inside a goal has a hop cap and a message cap, so a reply chain stops.
- **Paperclip goals.** When a company is connected, the board also shows its goals as a tree, above the plans. You can make a goal, change its title, description, status or owner, through the write grid (**Goals**, Confirm by default). See [Paperclip HQ](paperclip.md).
- **Paperclip.** When a company is connected, the board lists its tasks as plans. This source is read only: no button on the board writes to Paperclip, except the handoff below. If Paperclip is not connected, its last plan shows as frozen and is never shown as current. See [Paperclip HQ](paperclip.md).

## Managers as Paperclip employees

An office Manager can work in Paperclip as an employee. Paperclip has no manager role, so the Manager has the Project manager role, and the office marks it as its Manager. This is on top of the quick office goal: a goal you type in the office still works with no Paperclip at all.

1. **Hire the Manager.** Connect a company, open the Manager board, pick a building and click **Hire Manager**. The Manager is hired like every employee at the HR desk (see [Hiring at the HR desk](paperclip.md#hiring-at-the-hr-desk)): give a name if you like and a monthly budget, which is required. Hires use the write grid cell **Hires** (Confirm by default), so the dialog then shows exactly what the hire creates: one employee with the Project manager role on the office adapter, with its budget. Nothing is sent before **Confirm hire**. If the company asks the board to approve new employees, Paperclip keeps the hire waiting for that approval, and the office says so. A building has one Manager in Paperclip.
2. **Assign it a task.** A task in Paperclip that is assigned to the Manager becomes an office goal in that building. The task text is the plan: one step for each line of the description, or the title when there is no description. The goal tag says **From the Paperclip task** and its number. You approve the plan first, as for every office goal. The office sets the task to in progress.
3. **Steps are sub-issues.** Each step is a sub-issue of the task, assigned to nobody. When a step starts, ends or fails, its sub-issue moves to in progress, done or blocked.
4. **The result goes on the task.** When the goal ends, the Manager writes a comment on the task with the result and one line for each step. A finished goal sets the task to done. A stopped or blocked goal leaves the task open.

All of these are writes of the write grid (**Tasks** and **Comments**, Allow by default). If you set them to Confirm or Deny, the goal still runs in the office, the feed says that the report waits, and the office tries again after 30 seconds. The office never assigns the sub-issues and never deletes a task. A task that already has a goal is never taken twice.

The one board lists both kinds of goal: the goals of the office (also those from a Paperclip task) and the tasks of the company.

## What you can do

- **Approve** a plan that waits for approval. Nothing starts before that.
- **Retry** a step that failed.
- **Cancel goal** while it is open. The office stops the steps that run.
- **Hand a goal to Paperclip.** When a company is connected, an office goal can become Paperclip tasks. The dialog **Hand this goal to Paperclip** lists the exact tasks first, and **Create** is the Confirm. The office creates one backlog task for each step, and does nothing else: it never assigns a task, runs a routine, sends a heartbeat or changes a budget. Each task starts with the goal id and the step id, so a retry after a partial failure writes only the steps that are still missing. After the handoff the goal belongs to Paperclip, the board shows **Handed to Paperclip**, and the office stops dispatching it. The decision record is [ADR 0007](adr/0007-paperclip-goal-handoff-write.md).

The rules of the Manager are in `manager.mjs` and the board words in `public/vocab.js` (`plan`). The Security room rules apply to every agent a goal starts, as to any other agent ([Security](security.md)).
