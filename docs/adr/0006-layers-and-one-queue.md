# 0006: Layers and one queue are the UI rule

Status: accepted (spec #143, slice #145)

## Context

Every surface showed everything at once: tool calls, statuses, figures, Security room grids. Requests surfaced in six places. Supervising agents cost too much attention.

## Decision

Every place shows one layer of detail and opens the next with one tap.

- Glance: is all fine. A color and a mood per building or room. Text only when something needs the owner.
- Look: what is it doing, how is it going. One sentence of intent, goal progress, cost so far.
- Inspect: exactly what happened. Chat, terminal, timeline, diff, raw calls. One tap from Look.
- Deep: proof and rules. Security room, raw request text, logs. One tap from Inspect.

The facts are functions of `OfficeVocab.layers` in `public/vocab.js` (`order`, `opens`, `surfaces`, `mood`, `glance`, `look`, `remember`, `layerFor`). Page code reads them. It does not invent a detail rule.

Everything that waits on the owner is one queue across all buildings, oldest first (`officeAdapter.requests`). Toasts, bezels, the Needs you button and Ctrl+K open that queue. No surface keeps a second list.

A place remembers the layer the owner uses most and opens there. A new place opens at Glance.

## Consequences

- A raw command stays visible at Inspect and Deep. A summary never replaces it.
- A new surface declares its layer and the layer it opens in `layers.surfaces`.
- Fun and detail never cover or delay a request.
- The in-scene exception of ADR 0003 still holds: layers add no keyboard path to painted controls.
