---
title: VS Code extension
description: "Highlighting, diagnostics, formatting, go to definition and completion for .hana files."
sidebar:
  order: 3
---

Language support for `.hana` schema files.

- **Syntax highlighting** for `datasource` and `generator` blocks, models, views, enums, field
  types, attributes and `///` docs.
- **Diagnostics** from the hana-orm schema compiler itself: the same messages as
  `hana-orm validate`, at the right place, while you type. The files of a schema folder are
  checked together.
- **Formatting** with the `hana-orm format` rules. Format on save is on for `.hana` files.
- **Go to definition** for model and enum types, also across the files of a schema folder.
- **Completion** for top-level blocks, field types (scalars, models, enums), field and block
  attributes, `@db.*` native types and `@default(…)` functions.

The extension bundles the schema compiler, so it needs nothing else installed.

## Install

The extension lives in the repository under `editors/vscode`. Build and install it locally:

```sh
git clone https://github.com/tw4/hana-orm.git
cd hana-orm/editors/vscode
npm install
npm run package                          # creates hana-orm-vscode-<version>.vsix
code --install-extension hana-orm-vscode-*.vsix
```

## Other editors

`.hana` files are close to Prisma's schema language, so a Prisma syntax highlighter gives
reasonable colors in editors without a dedicated extension. Run `hana-orm format` and
`hana-orm validate` from the command line or a pre-commit hook.
