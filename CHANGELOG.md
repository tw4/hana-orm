# Changelog

All notable changes to hana-orm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may
contain breaking changes; they are listed under **Upgrade notes**.

Each release section is used as the GitHub release notes (see [RELEASING.md](RELEASING.md)).

## [Unreleased]

## [1.0.0-rc.3] - 2026-11-23

Fixes from using the release candidate against an existing schema. `1.0.0-rc.1` and
`1.0.0-rc.2` were staged on npm but never approved, so this is the first release candidate that
`npm install hana-orm` installs (#81). No breaking changes since `1.0.0-rc.2`.

### Fixed

- Editors suggest field names again inside `where`, `select`, `orderBy` and filter objects of
  `findMany`, `findFirst`, `findFirstOrThrow` and `count` (in an empty object and after a comma).
  The `= {}` type parameter default that broke TypeScript's completion is replaced by an
  overload for the call without arguments; result types are unchanged (#82).
- `mode: "insensitive"` and `ilike()` no longer miss rows that contain the Turkish `İ`. On column
  tables HANA could turn `LOWER(a) = LOWER(b)` (and on some versions `LIKE`) into a comparison
  that does not match `İ` with `i`; the value side is now `LOWER(?) || ''` (#83).
- `insert().values(...).toSQL()` returns the INSERT instead of throwing: `params` of the first
  row and `rows` with the parameters of every row. New `toSQLStatements()` lists every statement
  when the rows set different fields; `prepare()` on an insert now says why it is not
  supported (#84).
- `db pull` writes the "no primary key" comment only on models without a primary key and without
  a unique constraint, and says what is missing (`update`, `upsert`, `delete`) instead of calling
  the model read-only (#85).

## [1.0.0-rc.2] - 2026-11-19

The first version that shows up on npm with its README: `1.0.0-rc.1` was staged but never
published. No API changes since `1.0.0-rc.1`.

### Changed

- Until 1.0 is out, release candidates are published under the `latest` tag as well, so
  `npm install hana-orm` installs them (`@next` still works).
- package.json: a clearer description, more keywords, `author`, `homepage` and `bugs`.
- README: an overview for GitHub and npm, with a feature list and a comparison.
- Documentation site rebuilt with Astro Starlight and redesigned: an animated home page, section
  overviews with cards, a dark theme by default, and a description for every page (#76, #78, #79).
  Tables no longer push the header off-screen on phones.

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
- Json filters that compare a number at a path (`{ path: "$.score", gte: 0.5 }`) failed on HANA:
  `JSON_VALUE … RETURNING DOUBLE` is not supported there. They now use `RETURNING DECIMAL`, and a
  non-numeric value at the path no longer fails the query.

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

[Unreleased]: https://github.com/tw4/hana-orm/compare/v1.0.0-rc.3...main
[1.0.0-rc.3]: https://github.com/tw4/hana-orm/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/tw4/hana-orm/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/tw4/hana-orm/releases/tag/v1.0.0-rc.1
[0.1.0-alpha.0]: https://github.com/tw4/hana-orm/commits/main
