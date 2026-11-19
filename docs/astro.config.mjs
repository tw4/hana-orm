// @ts-check
import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Syntax highlighting for ```hana blocks, from the VS Code extension's grammar.
const hanaGrammar = {
  ...JSON.parse(readFileSync(new URL("../editors/vscode/syntaxes/hana.tmLanguage.json", import.meta.url), "utf8")),
  name: "hana",
};

export default defineConfig({
  site: "https://tw4.github.io",
  base: "/hana-orm",
  integrations: [
    starlight({
      title: "hana-orm",
      description: "A type-safe TypeScript ORM for SAP HANA: a declarative schema, a generated client and reviewable SQL migrations.",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/tw4/hana-orm" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/hana-orm" },
      ],
      editLink: { baseUrl: "https://github.com/tw4/hana-orm/edit/main/docs/" },
      lastUpdated: true,
      expressiveCode: {
        shiki: { langs: [hanaGrammar] },
        styleOverrides: { borderRadius: "0.6rem" },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
            { slug: "concepts" },
          ],
        },
        { label: "Schema", items: [{ autogenerate: { directory: "schema" } }] },
        { label: "Client", items: [{ autogenerate: { directory: "client" } }] },
        { label: "Migrations", items: [{ autogenerate: { directory: "migrations" } }] },
        { label: "Tools", items: [{ autogenerate: { directory: "tools" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Changelog", link: "https://github.com/tw4/hana-orm/blob/main/CHANGELOG.md", attrs: { target: "_blank" } },
      ],
    }),
  ],
});
