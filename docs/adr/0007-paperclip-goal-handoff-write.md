# 0007: The goal handoff is Paperclip's second and last allowed write

Status: accepted, 2026-11-06. From #158 (spec #130, Manager board; plan sources #155). Amends [ADR 0005](0005-paperclip-watched-not-driven.md), which stays accepted. Related: #76.

## Context

ADR 0005 made Supervise in office the one write the office makes to Paperclip. Spec #130 adds a Manager board with two plan sources. With the Paperclip source the office only reads. With the Office source the office Manager plans a goal. When a company is connected, the owner can hand an office goal to Paperclip, so that Paperclip runs it with its own agents, budgets and routines. That needs the office to create tasks in Paperclip. It is a second write, so it needs a decision of its own (owner choice C on #130).

## Decision

- The office may create Paperclip tasks for one goal, after a painted Confirm, and does nothing else. This is the second and last allowed write. ADR 0005 is amended only in this: the writes are Supervise in office and the goal handoff.
- Write surface, and no more:
  - `PATCH /api/agents/:id` (Supervise, ADR 0005, unchanged).
  - `POST` of a task, one per plan step, with title, description, parent goal and suggested agent. The route and body are from Paperclip 0.3.1 and are checked in a live run before the handoff ships.
  - The office never assigns to another agent, changes a task it did not create, runs a routine, sends a heartbeat, or changes a budget, an agent or a company.
- Named writer: one function in `paperclip.mjs` (`handoffGoal`), the only code that sends a task POST. It goes through the same `call()` as every Paperclip request: loopback `http://127.0.0.1:<port>` only, no `localhost`, `redirect: 'error'`, no credentials. No other module opens a connection to Paperclip.
- Confirm: the page sends `confirmed: true` after the painted Confirm, which shows the exact task list first. The route refuses without it (409). The server reads the company again before the first POST and writes only into the company the goal's building is connected to.
- Idempotency: every task carries the office goal id and the step id in its metadata. Before each POST the writer lists the company's tasks and skips a step whose marker already exists. If Paperclip accepts an idempotency key, the writer also sends one per step (`<goal id>:<step id>`). The check by marker is the rule, because it does not depend on that support. A retry therefore never doubles a task.
- Partial failure: the office records each written step (step id, Paperclip task id) after its POST succeeds. A failure after N tasks leaves the goal in the state Handoff failed, which lists the written tasks and the steps left. Retry continues from the record and the marker check. The office never deletes a task it created, also not on failure: removing it is a Paperclip action.
- After success the goal belongs to the Paperclip source: the board shows its tasks read-only with a link back to the office goal, and the office stops dispatching it.

## Consequences

- Test: a fake Paperclip that records every request. It asserts that the set of non-GET requests is exactly the Supervise PATCH and the task POST (method and route), that nothing is written without `confirmed: true`, the exact task bodies, and that a failure after N tasks followed by Retry creates only the rest. A new non-GET request fails this test until a new ADR allows it.
- Any other write (budgets, assignment, routines, heartbeats) needs a new ADR.
- The office still keeps no Paperclip secret and does not support authenticated mode.
- A task the owner changes or deletes in Paperclip after the handoff is Paperclip's state. The office shows what it reads and never rewrites it.
