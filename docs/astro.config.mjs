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
      customCss: ["./src/styles/theme.css", "./src/styles/docs.css", "./src/styles/landing.css"],
      components: {
        Hero: "./src/components/Hero.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Pagination: "./src/components/Pagination.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap",
          },
        },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/tw4/hana-orm" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/hana-orm" },
      ],
      editLink: { baseUrl: "https://github.com/tw4/hana-orm/edit/main/docs/" },
      lastUpdated: true,
      expressiveCode: {
        shiki: { langs: [hanaGrammar] },
        styleOverrides: { borderRadius: "0.6rem" },
        // Starlight switches themes with data-theme; the media-query fallback would override it.
        useDarkModeMediaQuery: false,
        // The home page is always dark: never apply the light code theme there.
        themeCssSelector: (theme) => (theme.type === "dark" ? "[data-theme='dark']" : "[data-theme='light']:not([data-has-hero])"),
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
