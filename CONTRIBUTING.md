# Contributing

Thanks for your interest in hana-orm.

## Ground rules

- **No private data.** Do not commit connection strings, host names, IP addresses,
  user names, passwords, company or customer names, or real business data. This applies
  to code, tests, fixtures, examples, issues and pull requests.
- Connection details are read from environment variables only (see `.env.example`).
- Test fixtures use synthetic schemas such as `User`, `Post`, `Order`.
- Integration tests must only write to local temporary tables (`#NAME`) or to a schema
  dedicated to testing.

## Workflow

1. Open an issue describing the change.
2. Create a branch from `main`.
3. Add tests for new behavior.
4. Open a pull request in English with a short description of the change and how it
   was tested.

Commit messages and pull requests are written in English.
