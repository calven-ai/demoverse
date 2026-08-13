# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/calven-ai/demoverse/security/advisories/new)
("Report a vulnerability"). Do not open a public issue for security reports.

You can expect an acknowledgement within a few business days. Please include
reproduction steps and the impact you believe the issue has.

## Scope notes

- Demoverse itself runs locally and stores credentials only in your untracked
  `.env` / `.env.local` and service-account files. Never commit credentials;
  the shipped `.gitignore` excludes the standard locations.
- The connectors act on external systems **you** configure. Reports about
  misuse of a user's own credentials or orgs are out of scope; defects that
  cause the engine to leak credentials, write outside its configured
  destinations, or bypass its dry-run/confirm guards are very much in scope.
