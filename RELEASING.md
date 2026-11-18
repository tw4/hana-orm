# Releasing

Releases are published by `.github/workflows/release.yml` when a version tag is pushed.

| version | npm dist-tag | `npm install hana-orm` gets it | GitHub release |
|---|---|---|---|
| `0.2.0-beta.1` (has a `-`) | `next` | no (`npm install hana-orm@next`) | pre-release |
| `0.2.0` | `latest` | yes | release |

## Steps

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` to a new `## [<version>]` section
   (keep **Upgrade notes** for anything that needs action when upgrading) and add its link at the
   bottom.
2. Set the version and create the tag: `npm version 0.2.0-beta.1` (or `npm version 0.2.0`). This
   commits `package.json` and tags `v0.2.0-beta.1`.
3. `git push --follow-tags`.

The workflow checks that the tag equals `v<package.json version>` and that `CHANGELOG.md` has a
section for it, runs typecheck, tests and the build, publishes with
`npm publish --provenance --tag next|latest`, and creates the GitHub release with that
changelog section as notes.

## One-time setup

- npm: either add an automation token as the `NPM_TOKEN` repository secret, or configure
  [trusted publishing](https://docs.npmjs.com/trusted-publishers) for this repository and the
  `release.yml` workflow on npmjs.com.
- The package is published with `--access public`.

## Benchmarks

Copy the HANA benchmark results of the release commit to `bench/results/<version>.md` (see
`bench/README.md`, when present).
