# Security policy

## Report a vulnerability

Report it in private. Do not open a public issue.

Use **Report a vulnerability** on the [Security tab](https://github.com/parthalon025/agent-office/security/advisories/new) of this repository. The report goes to the maintainer only. Say what you did, what you saw and what you expected. Add the version (`git rev-parse HEAD`) and your Windows and Node.js versions.

The maintainer answers in 7 days. A fix for a confirmed problem is made in private. It is released with a note of credit, if you want one.

## What is in scope

The office runs on your PC. These parts are in scope:

- The local server: its routes, the Host and Origin checks, and the one-time launch link.
- The tokens: the agent token, the page token, the page cookie and the files that keep them.
- The Security room rules and the risk rating of a tool call, when a call is allowed that a rule or the rating should hold.
- The files the office writes, and who can read them.
- Remote access through Cloudflare Tunnel and Access, when you turn it on.
- Anything that lets an agent approve its own request, or reach a route of the other token group.

## What is out of scope

- A problem that needs a person with full control of your Windows account or of the office folder.
- A problem in Claude Code, Node.js, Git or another agent. Report it to its own project.
- A weakness of a setting that you chose to loosen, such as Allow on a cell after the Confirm.
- Missing features. The office does not offer remote access without a real login.

## Read more

How the office keeps agents in check is in [docs/security.md](docs/security.md). The audit is in [docs/security-review.md](docs/security-review.md).
