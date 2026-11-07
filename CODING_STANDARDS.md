# Coding standards

The reviewer reads this file when it reviews a diff. These are judgement rules: a test or a check cannot decide them. Mechanical rules live in the tests (`npm test`), the design system checker (`kit/check.py`) and the core-jobs gate (`npm run gate:jobs`), so they are not repeated here.

## Another system's API

- Each route, method, body field, enum and answer shape that the office sends to Paperclip, or reads from it, comes from the pinned release (`npm run paperclip:source`, then the contract test `test/paperclip-contract.test.mjs`). It never comes from memory, from a newer source tree or from the fake. If the diff adds a request the contract test does not cover, ask where its shape came from.
- The fake (`test/fixtures/fake-paperclip.mjs`) and `test/fixtures/paperclip-shapes.json` follow the release. A fake that changes in the same diff as the code that calls it must give the reason in the release's source. Read wrapped answers carefully: for example, `agent-hires` answers `{ agent, approval }`, not the agent itself.
- The same rules apply to other agents' protocols (ACP, Copilot, OpenClaw): use a recorded handshake or the source at a named version.

## Writes

- Every Paperclip write goes through `hq.write`: one row in `PLANS` and one `WRITE_KINDS` cell. A second sender anywhere is a defect. This includes a "temporary" `fetch`.
- A write that changes money, people, access or secrets defaults to Confirm. Secrets never take Allow.
- The board key, the tokens and secret values never reach a page answer, a feed line, an error text or `state.json`.

## The page

- At 400 px a person can reach and press every ask-first Confirm with no scroll they have to find. A Confirm that appears below the fold scrolls into view.
- A new control works through Ctrl+K and is reachable on the phone view. Do not judge a UI diff only from what `kit/check.py` passes: ask for the screenshots of the DS Definition of done.

## Tests

- A test exercises behaviour through the module's interface (`startInProcess`, the provider seam, the fake), not its private helpers.
- A test writes only inside its own temp folders. If a diff adds a path under the user's home, `%LOCALAPPDATA%` or the repo folder, it must give the reason.
- A path compare goes through the real path (`realpathSync.native`) or the place rules (`place.mjs`). It never uses the text of a path that might be a short name, a junction or another case.

## Scope

- One ticket does one thing. When a ticket's acceptance item is not met, the diff says so, and a follow-up issue exists. Do not let the item pass quietly.
