---
title: Installation
sidebar:
  order: 1
---

## Requirements

- **Node.js 22.12 or newer.**
- **SAP HANA 2.0, SAP HANA Cloud or HANA Express.** The integration tests run against HANA
  Express 2.00.088.
- **TypeScript** is recommended. The generated client is a TypeScript file, and most of
  hana-orm's value is in its types.

## Install the packages

```sh
npm install hana-orm @sap/hana-client
```

- `hana-orm` contains the CLI (`npx hana-orm …`), the runtime the generated client uses
  (`hana-orm/runtime`) and the migration engine (`hana-orm/migrate`).
- `@sap/hana-client` is SAP's Node.js driver, the only native dependency. It is a peer
  dependency, so you pick its version (2.20 or newer). hana-orm loads it from your project.

The release candidate is published under the `next` tag:

```sh
npm install hana-orm@next @sap/hana-client
```

### Optional: decimal.js

If you want `Decimal` columns as [decimal.js](https://mikemcl.github.io/decimal.js/) objects
instead of strings, install it as well and set `decimal = "decimal.js"` in the generator block
(see [Decimal, BigInt, Json and dates](/hana-orm/client/values/)):

```sh
npm install decimal.js
```

## Running the generated client

`hana-orm generate` writes a TypeScript file, `<output>/index.ts`. It only uses type syntax that
can be erased (no `enum`s, no namespaces), so any of these works:

- **Node.js type stripping.** Node.js 22.18+ and 23.6+ run `.ts` files directly
  (`node src/main.ts`). On 22.12–22.17 add `--experimental-strip-types`.
- **`tsc`.** Import the client with its `.ts` extension and turn on
  `rewriteRelativeImportExtensions` (TypeScript 5.7+) so the emitted JavaScript imports `.js`.
- **A bundler or runner** (Vite, esbuild, tsx, Bun) with `allowImportingTsExtensions`.

A `tsconfig.json` that works for Node.js with type stripping, together with `"type": "module"`
in `package.json` (so top-level `await` works):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

## Check the installation

```sh
npx hana-orm version
npx hana-orm --help
```

## Editor support

Install the [VS Code extension](/hana-orm/tools/vscode/) for highlighting, diagnostics, formatting
and completion in `.hana` files.

Next: [Connecting to HANA](/hana-orm/getting-started/connecting/).
