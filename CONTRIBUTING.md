# Contributing to Demoverse

Thanks for wanting to make the demo world better. Contributions of every size
are welcome — docs fixes, new connectors, prose-bank improvements, bug reports.

## Getting set up

```bash
git clone https://github.com/calven-ai/demoverse
cd demoverse
npm ci
npm run typecheck && npm test    # should be green before you start
```

The engine runs entirely locally with no credentials; see
[docs/getting-started.md](docs/getting-started.md).

## Development guardrails

- `npm run typecheck` — strict TypeScript, no errors.
- `npx eslint .` and `npm run format:check` — lint and formatting must pass.
- `npm test` — the suite includes a **golden-seed snapshot** that pins the
  simulation's deterministic draws. If your change intentionally alters
  simulation behavior, regenerate it with `UPDATE_GOLDEN=1 npm test` and say
  so in the PR; never regenerate it to silence a diff you don't understand.
- Determinism is the core property: seeded Rng streams are keyed by purpose
  (`|variety|`, `|shape|`, …). Never reorder existing draws; add new streams
  instead.
- `npm run lint` is the *domain* coherence linter (cross-system story
  consistency), separate from code lint. Keep both clean.

## Adding a connector

Follow [docs/connectors/build-your-own.md](docs/connectors/build-your-own.md):
implement the `Connector` interface, register it, add its `connectors.yaml`
block and docs page, and include disabled/no-credential no-op behavior with
tests.

## Pull requests

- Small, focused PRs review faster.
- Describe what changed and how you verified it (commands + output).
- CI (typecheck, eslint, tests) must be green.
- By contributing you agree your contributions are licensed under the
  [MIT License](LICENSE).

## Reporting bugs / proposing features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md)
— never open a public issue.
