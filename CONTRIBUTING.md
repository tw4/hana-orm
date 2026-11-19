# Contributing

Thanks for your interest in hana-orm. Bug reports, documentation fixes and features are all
welcome.

## Ground rules

- **No private data.** Do not commit connection strings, host names, IP addresses,
  user names, passwords, company or customer names, or real business data. This applies
  to code, tests, fixtures, examples, issues and pull requests.
- Connection details are read from environment variables only (see `.env.example`).
- Test fixtures use synthetic schemas such as `User`, `Post`, `Order`.
- Integration tests must only write to local temporary tables (`#NAME`) or to a schema
  dedicated to testing.

## Workflow

1. Open an issue describing the change (small fixes can go straight to a pull request).
2. Create a branch from `main`.
3. Add tests for new behavior, and update the docs in `docs/` when behavior changes.
4. Open a pull request in English with a short description of the change and how it
   was tested.

Commit messages and pull requests are written in English.

## Development setup

```sh
npm install
npm run typecheck
npm test                    # unit and type tests, no database needed
npm run build
```

### Integration tests

The integration tests need a SAP HANA. They read the connection from `HANA_*` variables or from
the file named by `HANA_ORM_ENV_FILE` (for example `.env.test`), and skip themselves when there
is none. By default they only write to local temporary tables. With `HANA_ORM_ALLOW_DDL=1` the
tests that need DDL (migrations, `db pull`, `createMany`, many-to-many, full-text, Json) also run;
they create their own schemas (`HANA_ORM_IT_…`, `HANA_ORM_FT_…`) and drop them at the end, so use
a local or test database:

```sh
HANA_ORM_ENV_FILE=.env.test HANA_ORM_ALLOW_DDL=1 npm run test:integration
```

`docker-compose.hana.yml` starts a local SAP HANA Express (see the comments in the file; on
Apple Silicon it runs under emulation). HANA does not run in GitHub Actions: CI there runs
typecheck, unit tests and build only. Before a pull request is merged, the full check runs
locally:

```sh
npm run ci:local            # typecheck, unit tests, build, HANA check, all integration tests
npm run ci:local -- --bench # also the HANA benchmark
```

`ci:local` uses `.env.test` (or `HANA_ORM_ENV_FILE`), starts a stopped `hxe` or `hana-orm-hxe`
container when HANA does not answer (`HANA_CONTAINER` names another one), fails if any
integration test was skipped and writes its logs to `.local/ci/`.

### Documentation

The site in `docs/` is built with Astro Starlight:

```sh
cd docs
npm install
npm run dev      # http://localhost:4321/hana-orm/
```

See [docs/README.md](docs/README.md).

### Releases

See [RELEASING.md](RELEASING.md).
