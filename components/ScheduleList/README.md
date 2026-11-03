# ScheduleList

Cron jobs and event triggers: name, when, the agent, the next run, and Pause or Resume. Hermes cron jobs and Copilot Studio autonomous triggers both fit here.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `jobs` | yes | `{ id: string; name: string; when: string; kind?: "cron" \| "event"; bot?: string; next?: string; paused?: boolean }[]` |
| `onToggle` | no | `(job: unknown) => void` |
