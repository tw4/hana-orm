---
title: Studio
parent: Tools
nav_order: 2
---

# Studio
{: .no_toc }

1. TOC
{:toc}

`hana-orm studio` starts a local web page to browse and edit the data of the database your
schema points at. It is meant for development and support work.

```sh
npx hana-orm studio
```

```
hana-orm studio for 5 model(s)
Open http://127.0.0.1:5555/?token=<random token>
Press Ctrl+C to stop.
```

Open the printed URL. Ctrl+C stops the server and closes the connection pool.

## Options

| option | default | |
|---|---|---|
| `--port <n>` | `5555` | port to listen on |
| `--host <address>` | `127.0.0.1` | address to listen on |
| `--read-only` | off | refuse every change |
| `--schema <path>` | | as for every command |

## What you can do

- **Browse** every model and view of the schema. Rows are paged (25 to 500 per page) and sorted
  by any column; the row key breaks ties, so paging stays stable.
- **Filter** by column with `=`, `≠`, `contains`, `starts with` (both case-insensitive), `>`,
  `≥`, `<`, `≤`, `is null` and `is not null`. Values are converted to the column type.
- **Follow foreign keys.** A foreign key value is a link that opens the referenced model,
  filtered to that row.
- **Edit inline.** Double-click a cell, Enter saves, Esc cancels. Enums and booleans get a
  select, `Json` a text area.
- **Add rows.** Fields with a default or `@updatedAt` can be left at "default".
- **Delete rows**, after a confirmation.

Everything goes through the same runtime as the generated client, so values are encoded and
decoded as in your application (`BigInt`, `Decimal`, enums with `@map`, dates), and database
errors are shown as HANA reports them, for example a unique or foreign key violation.

## Which rows can be changed

Rows are addressed by their primary key, or by a non-null unique field when there is none.
Models without either, and views, are read-only in studio.

## Security

- The server listens on `127.0.0.1` by default, so only your machine can reach it.
- Each run creates a random token. The page and every API call need it; the API takes it in a
  header that a page from another site cannot send. The page removes the token from the address
  bar after loading.
- Requests whose `Host` header is not the address the server listens on are refused, which
  blocks DNS rebinding attacks.
- The page has a strict Content Security Policy and renders values only as text.

{: .warning }
`--host 0.0.0.0` makes studio reachable from other machines, and anyone who has the URL can read
and change the data. Use it only on a trusted network, and prefer `--read-only`. Never point
studio at a production database with a user that can write.

## With several environments

Studio uses the same connection settings as the other commands. To open another database, pass
the environment explicitly:

```sh
HANA_HOST=staging-hana.internal HANA_USER=READER npx hana-orm studio --read-only
```
