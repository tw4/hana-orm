// Release helpers used by .github/workflows/release.yml.
//
//   node scripts/release-notes.ts check <tag>   fails unless <tag> is v<package.json version>
//   node scripts/release-notes.ts dist-tag       prints "next" for a pre-release version, else "latest";
//                                                a pre-release is "latest" while npm has no stable version yet
//   node scripts/release-notes.ts notes <version> prints the CHANGELOG section of <version>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { name: string; version: string };
const version = pkg.version;

/**
 * Pre-releases (`1.2.0-beta.1`) go to `next` and stable versions to `latest`. While npm has no
 * stable version yet, a pre-release goes to `latest` too, so `npm install hana-orm` and the npm
 * page show it (instead of nothing, or the `0.0.0-stage` placeholder of staged publishing).
 */
export function distTag(v: string, published: readonly string[] = []): "next" | "latest" {
  if (!v.includes("-")) return "latest";
  const hasStable = published.some((p) => !p.includes("-"));
  return hasStable ? "next" : "latest";
}

/** Versions of the package on npm; empty when it is not published or npm cannot be reached. */
function publishedVersions(): string[] {
  try {
    const out = execFileSync("npm", ["view", pkg.name, "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = JSON.parse(out) as string | string[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** The body of `## [<version>]` (up to the next `## ` heading), without the heading. */
export function changelogSection(changelog: string, v: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## |^\[[^\]]+\]: /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

const [cmd, value] = process.argv.slice(2);
if (cmd === "check") {
  if (value !== `v${version}`) {
    console.error(`Tag ${value} does not match package.json version ${version}; tag v${version} instead.`);
    process.exit(1);
  }
  console.log(`Releasing ${version} as '${distTag(version, publishedVersions())}'`);
} else if (cmd === "dist-tag") {
  console.log(distTag(version, publishedVersions()));
} else if (cmd === "notes") {
  const v = value ?? version;
  const section = changelogSection(readFileSync(new URL("CHANGELOG.md", root), "utf8"), v);
  if (!section) {
    console.error(`CHANGELOG.md has no section '## [${v}]'; add the release notes before tagging.`);
    process.exit(1);
  }
  console.log(section);
} else if (cmd !== undefined) {
  console.error("usage: release-notes.ts check <tag> | dist-tag | notes [version]");
  process.exit(1);
}
