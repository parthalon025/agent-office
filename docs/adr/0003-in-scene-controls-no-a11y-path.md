# 0003: In-scene controls have no keyboard or screen reader path

Status: accepted (owner decision, 2026-11-04)

## Context

The Security room puts its controls on wall screens in the 3D scene: one screen per topic (Files, Commands, Network, Secrets, Agents, Spend). The user clicks a cell on the screen to cycle Ask, Allow and Deny, and confirms a looser rule with a painted Confirm. No panel opens. The DS Definition of done asks for visible focus on every control, and the DS Concepts cover accessibility. A painted control has no DOM element, so it has neither by itself.

## Decision

In-scene controls get no keyboard path and no screen reader mirror, now or later. Do not add one in a later change.

## Consequences

- `docs/design-system/DS-README.md` Definition of done has an exception line for in-scene controls.
- A user who cannot use a pointer cannot change Security room rules in the scene.
- DOM controls (dialogs, the dock, the chat) keep the full Definition of done.
