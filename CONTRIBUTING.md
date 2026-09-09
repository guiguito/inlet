# Contributing to Inlet

Thanks for looking. Issues and pull requests are both welcome.

## Before a large change

Open an issue first. Inlet has a written product specification
([docs/PRD.md](docs/PRD.md)) and a written record of every technical decision
([docs/DECISIONS.md](docs/DECISIONS.md)); a feature that contradicts either needs a
conversation before it needs code, and it is kinder to have that conversation before
you have written it.

Small fixes — a bug, a typo, a clearer error message — need no ceremony. Send them.

## Getting set up

Node.js 22 or newer.

```bash
npm install
npm run services:up      # local PostgreSQL and MinIO binaries, no Docker needed
cp .env.example .env
npm run dev              # API on :3000, web on :5173
```

`npm run services:down` stops them again.

## What is expected of a change

```bash
npm run typecheck
npm run lint
npm run test:all
```

All three pass before a pull request is ready. `test:all` needs the local services up.

**Tests are not optional for logic.** The existing suite is 441 unit and integration
tests plus 58 end-to-end, and it is the reason the project can be changed confidently.
A behavioural change without a test that fails before it and passes after is not
finished. Conversely, do not add a test that cannot fail.

**Requirements are cited in the code.** Notice the `FR-xxx` references in comments;
they point at [docs/PRD.md](docs/PRD.md). If you implement something the PRD covers,
cite it. If you implement something it does not cover, say so in the pull request so
the PRD can catch up.

**Migrations are generated, then named.** `npm run db:generate` after a schema change,
then rename the file to something a human can read (`0005_saved_filters.sql`) and
update the tag in `apps/api/drizzle/meta/_journal.json` to match. Migrations are
additive: adding tables and columns, not rewriting or dropping data.

**Match the surrounding code.** This codebase comments the *why*, not the *what*, and
it is fairly consistent about it. A comment explaining that a loop iterates is noise; a
comment explaining why the joins are in that order is the difference between a fix and
a regression. Prose in the interface follows the voice in PRD section 20.6: second
person, present tense, plain words, no exclamation marks.

## Regenerating the API document

`docs/openapi.json` is generated from the Zod schemas, never edited by hand:

```bash
npm run openapi
```

Commit the result alongside a route or schema change.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains
what to do instead.

## Licensing

Contributions are accepted under the [MIT License](LICENSE), the same terms as the rest
of the project. By opening a pull request you agree your contribution may be
distributed under it.
