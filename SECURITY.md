# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/calven-ai/demoverse/security/advisories/new)
("Report a vulnerability"). Do not open a public issue for security reports.

You can expect an acknowledgement within a few business days. Include
reproduction steps and the impact you believe the issue has.

## Scope notes

- Demoverse itself runs locally and stores credentials only in your untracked
  `.env` and service-account files. Never commit credentials. The shipped
  `.gitignore` excludes every `.env*` variant (the tracked `.env.example`
  template excepted) plus the usual key-file names.
- Two guards back that up, and both are worth turning on before you paste a
  token in. `npm run secrets:hook` installs a pre-commit hook that refuses a
  commit containing a credential file or a filled-in `.env.example`. The same
  check runs in CI as `npm run secrets:check`. The hook is the one that matters
  most, because CI can only tell you about a secret that has already been
  pushed, and at that point the only real remedy is to rotate it.
- The connectors act on external systems **you** configure. Reports about
  misuse of a user's own credentials or orgs are out of scope. In scope:
  defects that cause the engine to leak credentials, write outside its
  configured destinations, or bypass its dry-run/confirm guards.
