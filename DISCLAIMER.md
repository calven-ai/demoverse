# Disclaimer: synthetic data, used responsibly

Demoverse manufactures **clearly-fabricated demo data** for a **fictional
company**. It exists so you can build, test and demo B2B software against a
world that behaves like production without touching anything real. Using it
responsibly means:

- **Isolated destinations only.** Point the connectors exclusively at systems
  that exist for this purpose: a Salesforce Developer Edition org, a dedicated
  HubSpot test portal, a throwaway Slack workspace, a Drive folder owned by a
  service account. Never a production CRM, never a shared company workspace.
- **No real people.** Contacts, reps and Slack personas are always fictional.
  The engine fabricates every person and gives contacts non-resolving
  `.example` email domains by design. Keep it that way.
- **Real company names are opt-in and stay private.** You *may* ground your
  fictional pipeline in real target-account names (your own prospect lists, via
  the optional `prospects` block: see
  [docs/operations.md](docs/operations.md#real-target-account-names-optional-advanced))
  or name real competitor vendors. The reference deployment does. If you do, the
  fabricated outcomes attached to those names (won/lost, pricing feedback,
  quotes) must remain inside your private demo systems. Never publish, post or
  present fabricated data about a real company where it could be mistaken for
  fact.
- **No deception.** Don't use generated content to fake reviews, testimonials,
  traction, or anything shown to people who don't know it's synthetic. Demo
  audiences should be told the data is fabricated.
- **Your systems, your responsibility.** You are responsible for complying
  with the terms of service of every platform you connect and the laws that
  apply to you.

The software is provided as-is under the [MIT License](LICENSE), without
warranty of any kind.
