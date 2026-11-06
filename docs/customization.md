# Customization

Make the office fit how you work: give agents a character, group them into teams, choose what a wall screen shows, and set how much the office talks. Everything here is yours to change, and none of it changes what an agent may do. The Security room never reads a persona or a team.

## Personas

A persona is the character of an agent: a name, a look (shape, accessory and color of its bot), a short role text and a working style. The style changes the tone of what the agent says, never what it may do:

| Style | Tone |
| --- | --- |
| Careful | Checks its work, says what it verified and what it is unsure about. |
| Fast | Short replies that lead with the result. |
| Chatty | Friendly, thinks out loud in short notes, says what it plans to do next. |

The bot shapes are round, square, tall and wide. The accessories are none, glasses, hat, headset and scarf. A bot body cue (a small motion that follows its status) comes from adapter events only, so a bot never moves by itself, and there is none under reduced motion. The office offers three starter personas, **Reviewer**, **Fixer** and **Researcher**. It adds a starter only when you do not have it yet, and never overwrites yours.

## Teams

A team template is a list of persona names, at most eight. Starting a team opens one session for each member in the folder you pick, each with its persona. The starter team **Fix and review** has the members Researcher, Fixer and Reviewer. A member that does not start (for example a kind that is not ready) shows its own error, and the others still start. This is not the same as an Agent Framework team (see [Agent kinds](agents.md#agent-framework-teams)).

## Wall screens

Each room has a blackboard. You choose which view it shows. Overview is the default, and choosing it clears your choice. The choice is saved for the room.

## Export and import

All of the above (personas, teams, wall screens and room layouts) can be exported as one JSON file and imported again, for example on another PC. The file has the format name `agent-office-customization`. The office cleans every entry on import and refuses a file of another format. Nothing else of the office state goes in the file: no sessions, notes, schedules or rules.

## Rituals and Focus mode

- **Weekly recap.** The recap dialog shows the last seven days: what merged, what it cost and the attention measure (approvals for each merge, minutes from done to merged, interruptions for each hour).
- **While you were away.** A list of what happened since you last closed the recap.
- **Stand-up.** An agent of a given name that starts for the first time on a day can begin with a short stand-up line in its prompt: one note in the room notes board with Yesterday, Today and Blocked. It is only text in a prompt.
- **The merged moment.** A short moment on screen when a change you confirmed merges.
- **Focus mode.** Turn it on in the recap dialog. It turns off sound, the body language of the bots, the merged moment and the stand-up. Reduced motion in your system settings turns the same rituals off. A ritual never covers or delays a request: a moment waits while any request is open.

## Session export

Open a session and click **Export** to get it as Markdown. This works for every agent kind, live or past. Keys and token values in commands are masked in the export.
