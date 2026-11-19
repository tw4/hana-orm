# hana-orm documentation

The site at <https://tw4.github.io/hana-orm/>, built with [Astro Starlight](https://starlight.astro.build/).

```sh
cd docs
npm install
npm run dev      # http://localhost:4321/hana-orm/
npm run build    # static site in docs/dist
```

Pages are Markdown files in `src/content/docs/`; the sidebar follows the folders and each
page's `sidebar.order`. Links between pages use absolute paths (`/hana-orm/client/reading/`).
`hana` code blocks are highlighted with the VS Code extension's grammar
(`editors/vscode/syntaxes/hana.tmLanguage.json`). The site is published by
`.github/workflows/docs.yml` on every push to `main` that touches `docs/`.
