# 0009: Earned trust is a proposal, never an automatic rule

Status: accepted (spec #143, issue #153)

## Context

A user who answers the same request many times wants it to stop asking. The Security room already holds the rules, and a looser rule needs the painted Confirm (`confirmed: true`). The office has the answers (`trust.mjs`, `persisted.trust.ledger`), so it can see a pattern. If it applied that pattern itself, an agent could earn freedom by asking in a harmless way until a rule loosened. The user would not have decided it.

## Decision

- The office only proposes. A proposal is one building-scope cell for one agent kind (`trust.propose`). It applies only through the same path as a rule from the wall: `POST /api/trust/apply` calls `setRule`, which answers 409 without `confirmed: true`. No timer, no count and no agent action applies a rule.
- Evidence is the streak of the user's own answers in one cell (agent kind, building, row). Five approvals in a row (`MIN_APPROVALS`). A decline, or a high-risk call, ends the streak. An approval of a call that cannot be named safely (a compound shell command) is no evidence.
- Never proposed: the Secrets rows (`settings`, `secrets`), the Agents rows, a cell that is already Allow or Deny. A proposal is never a Deny, and never a change to another agent kind or building.
- A cell has no command pattern, so an Allow covers every call of that row in that building for that kind. The pattern ("npm test") is evidence, and the proposal text says the rule is wider than the evidence. A narrower rule needs a rule grammar the Security room does not have. That is a separate decision.
- A grant records the cell it replaced (`persisted.trust.grants`). Withdraw puts that cell back in one click, with no Confirm, because it never loosens. A cell the user changed after the grant is left as the user set it.
- A persona or working style never counts as evidence and never changes a rule (ADR for #150). The ledger knows the agent kind only.
- The trust card per agent kind (clean runs, declined calls, rules granted) reads the same ledger and the past sessions. It shows why a kind has the freedom it has. It is information, not a score that opens anything.
- Only an answer the user gave on the page is recorded. A request a rule answered, a hold that timed out and a hold that went back to the terminal are not.

## Consequences

- The ledger holds the last 400 answers in `state.json` (written with `writeSecret`). It stores the command's first two words only, never the full text.
- The rules still apply only while the office runs. Say so wherever enforcement is described.
- A user can ignore every proposal ("Not now"). A dismissed proposal returns only after a decline in its cell.
