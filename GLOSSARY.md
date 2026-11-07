# Glossary

The vocabulary of the office layout (#88). Plain company terms only.

| Term | Meaning |
| --- | --- |
| Campus | The city: all buildings |
| Building | One repository (or Other folders, for folders outside git) |
| Archetype | A preset of floors for a kind of work: Software product, Knowledge base, Operations Hub, General (`archetypes.mjs`) |
| Function catalog | Every floor type, grouped in wings: Product and tech, Go to market, Corporate, Operations, Leadership |
| Wing | A group of floors in the elevator panel |
| Floor | One function. Set by the archetype, changed only by the user at the Reception |
| Lobby | Ground floor of every building: the Reception, the directory board, the Security room, open desks for agents with no role |
| Records | Top floor of every building: where merged changes are filed (#93) |
| Reception | The lobby room with the reception desk and its memo (the archetype memo, then Since you left) |
| Elevator panel | The floor list: floors in wings, each number lit by the worst state of its desks; empty floors dimmed and skipped |
| Role | The floor an agent sits on: the Manager's role, the floor of the open desk the user clicked, its agent type, else the Lobby |
| Room | One workspace (a worktree or a folder) on one floor where an agent of it sits, named from its task: Manager goal, linked issue, first prompt, branch. The main checkout is named by its branch only |
| Shared workspace | A room where two or more agents work, or the main checkout |
| Private | An agent room with one agent |
| Desk | One agent. Its nameplate shows name, model lane and cost |
| Open desk | A desk with no agent. Two clicks start an agent there with the floor's role |
| Model lane | Haiku, Sonnet, Opus or Fable, from the model id |
| Worst state | Error, needs you, review ready, working, finished, resting: shown on the room door, the elevator button and the city windows |
| Folder | One change (PR) as a scene object (#93) |
| Delivery pipeline | Intake, Build, Check, Review, Gate, Merge, Release, Record (#93) |
| Ready to merge tray | The one place where every change that passed checks and review waits for the user (#93) |
| Main cabinet | Where merged folders are filed, in Records (#93) |
| Pinned screen | A DOM layer laid over a focused screen in the scene (#89) |
| Decision summary | The key point first, one line per decision, a recommended default |
| HQ | A Paperclip company shown in the office: its building in the campus and its full-page view. Not a repository building |
| Employee | A Paperclip agent of an HQ. An office session is an agent; an employee is the Paperclip record it runs as |
| Hire | Creating an employee from the office, behind a Confirm, supervised and with a budget |
| Company memory | The shared, searchable memory of one company: what its employees learned, each item with where it came from |
| Orientation | The first-run walk through the whole office, step by step and skippable: agent kinds, Security room, spend limit, company setup, company memory, Start with Windows, remote access, the tour |
| Write grid | The HQ setting of what the office may write to Paperclip, per write kind: Confirm, Allow or Deny |
| Self-approval | An employee approving its own work, only for the approval kinds the user allows in the write grid |
| Office adapter | The Paperclip adapter that hands an employee run to the office, which runs it with the employee agent kind under supervision |
