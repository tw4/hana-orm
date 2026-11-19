---
title: Several files and formatting
parent: Schema
nav_order: 7
---

# Several files and formatting
{: .no_toc }

1. TOC
{:toc}

## A schema folder

A large schema can be split into several files. Put them in a folder and point the CLI at it
(or name the folder `schema/` so it is found by default):

```
schema/
├── _datasource.hana    # datasource and generator blocks
├── customers.hana
├── orders.hana
├── catalog.hana
└── migrations/
```

```sh
npx hana-orm generate --schema schema/
```

- Every `*.hana` file directly inside the folder is read, sorted by file name, and merged into
  one schema. Subfolders are not read.
- Models may reference models and enums in other files.
- There is exactly one `datasource` block in the whole folder.
- `migrations/` lives inside the folder, and generator `output` paths are relative to it.
- Errors name the file they occur in.
- `db pull` writes a single file: point it at one file of the folder
  (`--schema schema/legacy.hana`) or use `--print`.

## Formatting

```sh
npx hana-orm format           # rewrite the schema file(s) in place
npx hana-orm format --check   # list files that are not formatted, exit 1 (for CI)
```

The formatter:

- aligns field names, types and attributes in columns;
- orders field attributes as `@id @default @unique @updatedAt @ignore @relation @map @db.*`;
- orders block attributes as `@@id @@unique @@index @@fulltext @@check @@map @@schema @@ignore`
  (`@@check` lines keep their relative order);
- normalizes spacing and blank lines and keeps all comments.

It is idempotent and refuses to touch a file with syntax errors. The
[VS Code extension](../tools/vscode.html) formats on save with the same rules.

## Validating

```sh
npx hana-orm validate
```

```
schema/orders.hana:4:3 - Unknown type 'Custmer' for field 'Order.customer'
```

`validate` exits with 1 on errors, so it fits into CI next to `format --check`.
