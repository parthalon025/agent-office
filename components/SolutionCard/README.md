# SolutionCard

A solution template: a ready-made building for one kind of customer work. It lists the floors and rooms. `AgentOffice.solutions` holds the templates; pass the id as `solution` to OfficeScene.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `solution` | yes | `{ id: string; label: string; summary: string; building: BuildingDef }` |
| `onUse` | no | `() => void` |
