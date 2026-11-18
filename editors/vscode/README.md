# hana-orm for VS Code

Language support for [hana-orm](https://github.com/tw4/hana-orm) `.hana` schema files.

- **Syntax highlighting** for datasource and generator blocks, models, views, enums, field types,
  attributes and `///` docs.
- **Diagnostics** from the hana-orm schema compiler itself: the same messages as
  `hana-orm validate`, at the right place. Files of a schema folder are checked together.
- **Formatting** with `hana-orm format` rules (format on save is on for `.hana` files).
- **Go to definition** for model and enum types, also across the files of a schema folder.
- **Completion** for top-level blocks, field types (scalars, models, enums), field and block
  attributes, `@db.*` native types and `@default(...)` functions.

## Build and install locally

```sh
cd editors/vscode
npm install
npm run package          # creates hana-orm-vscode-<version>.vsix
code --install-extension hana-orm-vscode-*.vsix
```

The extension bundles the schema compiler from this repository (`src/schema`), so it needs no
other installation.

## Publish

`npm run publish` publishes to the Visual Studio Marketplace under the `publisher` in
`package.json`; it needs a Marketplace publisher and a personal access token (`vsce login`).
