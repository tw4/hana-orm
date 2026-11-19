# Releasing

Releases are staged on npm by `.github/workflows/release.yml` when a version tag is pushed, and
published when a maintainer approves them with 2FA.

| version | npm dist-tag | `npm install hana-orm` gets it | GitHub release |
|---|---|---|---|
| `0.2.0-beta.1` (has a `-`) | `next` | no (`npm install hana-orm@next`) | pre-release |
| `0.2.0` | `latest` | yes | release |

## Steps

1. Run `npm run ci:local -- --bench` on the commit to release. The HANA integration tests do not
   run in GitHub Actions, so this is the only place they run.
2. Move the entries under `## [Unreleased]` in `CHANGELOG.md` to a new `## [<version>]` section
   (keep **Upgrade notes** for anything that needs action when upgrading) and add its link at the
   bottom.
3. Set the version and create the tag: `npm version 0.2.0-beta.1` (or `npm version 0.2.0`). This
   commits `package.json` and tags `v0.2.0-beta.1`.
4. `git push --follow-tags`.
5. Wait for the Release workflow. It stages the version on npm and creates the GitHub release.
6. Approve the staged version with 2FA: `npm stage list hana-orm`, then
   `npm stage approve <id>` (or on npmjs.com). Only then can it be installed.

When the version bump and changelog come in through a pull request (as for `1.0.0-rc.1`), skip
step 3's commit and only tag the merge commit: `git tag v1.0.0-rc.1 <commit>` and
`git push origin v1.0.0-rc.1`.

The workflow checks that the tag equals `v<package.json version>` and that `CHANGELOG.md` has a
section for it, runs typecheck, tests and the build, stages the package with
`npm stage publish --provenance --tag next|latest`, and creates the GitHub release with that
changelog section as notes. The release page exists before the version is approved on npm.

## One-time setup

- npm: either add a granular access token with read and write access as the `NPM_TOKEN`
  repository secret (it does not need to bypass 2FA, because the workflow only stages), or
  configure [trusted publishing](https://docs.npmjs.com/trusted-publishers) for this repository
  and the `release.yml` workflow on npmjs.com, allowing staged publishes
  (`npm trust … --allow-stage-publish`).
- The maintainer who approves releases needs 2FA on their npm account.
- The package is published with `--access public`.

## Benchmarks

Copy the benchmark results of step 1 (`.local/ci/bench-results.md` / `.json`) to `bench/results/<version>.md` (see
`bench/README.md`, when present).
