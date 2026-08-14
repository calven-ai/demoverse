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

The engine runs entirely locally, with no credentials. See
[docs/getting-started.md](docs/getting-started.md).

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
  consistency), separate from code lint. Keep both clean.
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
