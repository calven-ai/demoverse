# Contributing to Demoverse

Thanks for wanting to make the demo world better. Contributions of every size
are welcome: docs fixes, new connectors, prose-bank improvements, bug reports.

## Getting set up

```bash
git clone https://github.com/calven-ai/demoverse
cd demoverse
npm ci
npm run typecheck && npm test    # should be green before you start
```

That is the whole setup. You do **not** need to configure a world to work on
the engine: the suite loads `config/templates/*.yaml` directly (see
`tests/fixture.ts`), and CI runs exactly what a fresh clone runs. Treat the
templates as the spec the tests assert against, and keep the Zod defaults in
`src/config/schema.ts` in agreement with them.

The engine runs entirely locally, with no credentials. See
[docs/getting-started.md](docs/getting-started.md).

## Never commit a world to this repo

Demoverse is both a tool and, for its users, a template they fill in. Those two
uses share a directory layout, so be deliberate about which one you are in:

- Contributing to the engine: your clone should keep `config/` at templates
  only and `state/` empty. Nothing else belongs in a PR here.
- Running a world of your own: use your own copy of the template repository,
  where committing `config/*.yaml` and `state/world.json` is the point.

If you built a world first and want to send a fix upstream, make the PR from a
branch that carries no `config/*.yaml`, no `state/world.json`, and no
`state/content/`. Those files hold account names, buying-group contacts and
connector record ids from whatever systems you pointed at.

## Development guardrails

- `npm run typecheck` runs strict TypeScript. It must report no errors.
- `npx eslint .` and `npm run format:check` must both pass.
- `npm test` runs a suite that includes a **golden-seed snapshot** pinning the
  simulation's deterministic draws. If your change intentionally alters
  simulation behavior, regenerate it with `UPDATE_GOLDEN=1 npm test` and say so
  in the PR. Never regenerate it to silence a diff you don't understand.
- Determinism is the core property. Seeded Rng streams are keyed by purpose
  (`|variety|`, `|shape|`, …), so never reorder existing draws. Add new
  streams instead.
- `npm run lint` is the *domain* coherence linter (cross-system story
  consistency), separate from code lint. It needs a configured world, so it is
  deliberately **not** in CI. Don't "fix" CI by adding it.
- `npm run secrets:check` runs first in CI and refuses a credential in tracked
  files. `npm run secrets:hook` installs the same check as a local pre-commit
  hook. It is optional and repo-local (it sets `core.hooksPath` to `.githooks`,
  replacing any other hook path in this clone). Uninstall with
  `git config --unset core.hooksPath`.
- `npm run lint:prose` enforces one house style rule on the repo's own text: no
  em dashes, in docs, comments or output strings. They are the loudest tell that
  a paragraph came out of a language model, and this project's whole job is
  producing text that doesn't read that way. Rewrite the sentence. A period
  usually does it. A line that genuinely needs one (an external record name)
  opts out with a `prose-lint: allow-emdash` comment.

## Adding a connector

Follow [docs/connectors/build-your-own.md](docs/connectors/build-your-own.md).
Implement the `Connector` interface, register it, then add its
`connectors.yaml` block and docs page. Disabled and no-credential runs must
no-op cleanly, and that behavior needs tests.

## Pull requests

- Small, focused PRs review faster.
- Describe what changed and how you verified it (commands + output).
- CI (typecheck, eslint, tests) must be green.
- By contributing you agree your contributions are licensed under the
  [MIT License](LICENSE).

## Reporting bugs / proposing features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md).
Never open a public issue for one.
