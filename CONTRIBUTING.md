# Contributing

Thank you for helping. This page tells you how to make a change that can be merged.

## Before you start

- Read [docs/development.md](docs/development.md). It has the commands, the file map and how the office works.
- Read [CLAUDE.md](CLAUDE.md). It has the rules for each file. Extend the file that owns the concern before you add a new file.
- Read the decision records in [docs/adr](docs/adr) before you change approvals, providers or the Security room.
- The office has no dependencies. Do not add one without asking in an issue first.
- The office runs on Windows first. Node.js 22 or newer is required.

## Make a change

1. Open an issue, or comment on one, so the work is not done twice.
2. Make one branch for each change. Name it for the change, for example `fix/notes-merge` or `feat/floor-search`. Never work on `main`.
3. Keep the change small. One change does one thing.
4. Write or update a test in `test/` for every change in behavior. Tests run offline and need no paid call.
5. Run the checks below. Fix every failure.
6. Open a pull request. Fill in the template. A pull request needs a passing CI run.

## Checks

```
npm test            # offline tests
npm run gate:jobs   # steps of the five core jobs, for a change to the page (needs Chrome or Edge)
```

For a change to the page or the design system, run the design system checker. The command, with its file list, is in [docs/development.md](docs/development.md#commands):

```
python kit/check.py <the files listed there>
```

Then look at screenshots in Day, Night, Sublevel, Fluent and Fluent Dark at 1360, 1100 and 400 px.

Final browser tests run on the port of your branch (`npm run start:branch`). Never use port 4317: that is the port of your own office.

## The design system rules

The design system (DS) is law for anything visual. Read [DS-README.md](docs/design-system/DS-README.md), [Recipes.md](docs/design-system/Recipes.md) and [Reference.md](docs/design-system/Reference.md) first.

- Use DS tokens for every color, size and duration. Write no literal color.
- Use the DS icon set and DS components. Use no emoji.
- Write copy in Simplified Technical English: short sentences, active voice. A button says its result. Do not write "Oops", "Sorry", "please" or an exclamation mark.
- A DS change goes in `components/`, `kit/` and the tokens, with a row in the [Changelog](docs/design-system/Changelog.md).

## Security

Do not report a vulnerability in an issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your work uses the [MIT license](LICENSE).
