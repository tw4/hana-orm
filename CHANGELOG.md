# Changelog

All notable changes to hana-orm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may
contain breaking changes; they are listed under **Upgrade notes**.

Each release section is used as the GitHub release notes (see [RELEASING.md](RELEASING.md)).

## [Unreleased]

### Fixed

- Json filters that compare a number at a path (`{ path: "$.score", gte: 0.5 }`) failed on HANA:
  `JSON_VALUE … RETURNING DOUBLE` is not supported there. They now use `RETURNING DECIMAL`, and a
  non-numeric value at the path no longer fails the query.

## [1.0.0-rc.1] - 2026-11-19

Release candidate for 1.0: every v0.2, v0.3 and v1.0 roadmap item, including the data browser
(`hana-orm studio`, #37). Published under the `next` tag. The integration tests and benchmarks
(`npm run ci:local -- --bench`) passed on this version against HANA Express 2.00.088.

### Added

- Migrations: `migrate squash` and `migrate split` (#21); check constraints, sequences and `///`
  comments as database comments (#24); full-text indexes with the `search` filter (#10).
- Client: Json filters (`path`, `string_*`, `array_*`) (#9); `decimal` generator option (#16);
  computed fields via `$extends({ result })` (#7); `$on` events and `$metrics` (#12); query plan
  cache and optional prepared statement reuse (#14); typed raw SQL from `.sql` files (#11);
  connection pool health checks, reconnect, `statementTimeout` and graceful shutdown (#15).
- SQL-like query builder with typed tables (#28), `sql` fragments in object-API `where` (#31),
  prepared queries with placeholders (#30), `$batch` (#32), schema definitions in TypeScript (#29).
- `npm run ci:local`: typecheck, unit tests, build and every integration test against a local
  HANA Express (#33), optionally with benchmarks against the raw driver (#39); release workflow
  publishing to npm with `next` / `latest` tags (#38). HANA does not run in GitHub Actions.
- `hana-orm studio`: a local web page to browse, filter and edit the data of every model, with
  foreign-key navigation and a `--read-only` mode (#37).
- Documentation site at <https://tw4.github.io/hana-orm/> with guides for moving from Prisma,
  TypeORM and `@sap/hana-client` (#36).
- VS Code extension for `.hana` files: highlighting, diagnostics, formatting, go to definition and
  completion (`editors/vscode`, #35).

### Fixed

- `migrate show <id>` never matched an id.
- Introspection failed on a real HANA (`invalid column name: COLUMN_NAME`), which broke `db push`,
  `db pull`, `migrate plan` and drift checks: `SYS.FULLTEXT_INDEXES` has no column name, so it is
  now read from `SYS.INDEX_COLUMNS`.

### Upgrade notes

- **Query logging no longer includes parameter values** unless the client is created with
  `logParams: true`; this also applies to a `log: (e) => …` callback (#12).
- **`db pull` prefers the database comment** over an existing `///` doc, because `///` is now the
  database comment (#24). Projects whose migrations predate this get a migration that sets the
  comments on the next `migrate plan`.
- Whole-document equality on `Json` fields compares `TO_NVARCHAR(column)`; HANA cannot compare an
  NCLOB with `=` (#9).

## [0.1.0-alpha.0]

First preview: `.hana` schema language and contract, typed client generator, object API
(`findMany` … `groupBy`, nested writes, `$transaction`, `$extends`, `omit`, `distinct`, cursor
pagination, relation ordering, implicit many-to-many), migrations (`plan`, `deploy`, `status`,
`resolve`, `baseline`, `diff`, `reset`, locking with heartbeat, renames and schema moves),
`db pull` / `push` / `seed` / `execute`, the formatter and multi-file schemas.

[Unreleased]: https://github.com/tw4/hana-orm/compare/v1.0.0-rc.1...main
[1.0.0-rc.1]: https://github.com/tw4/hana-orm/releases/tag/v1.0.0-rc.1
[0.1.0-alpha.0]: https://github.com/tw4/hana-orm/commits/main
