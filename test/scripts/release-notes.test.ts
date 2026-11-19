import { test } from "node:test";
import assert from "node:assert/strict";
import { changelogSection, distTag } from "../../scripts/release-notes.ts";

test("pre-releases go to next once a stable version exists, and to latest before that", () => {
  assert.equal(distTag("1.0.0"), "latest");
  assert.equal(distTag("1.0.0", ["0.9.0"]), "latest");
  assert.equal(distTag("1.1.0-beta.1", ["1.0.0"]), "next");
  assert.equal(distTag("1.0.0-rc.2", []), "latest");
  assert.equal(distTag("1.0.0-rc.2", ["0.0.0-stage"]), "latest", "the staged-publishing placeholder is not a stable version");
  assert.equal(distTag("1.0.0-rc.2", ["0.0.0-stage", "1.0.0-rc.1"]), "latest");
});

test("changelogSection returns the body of one version", () => {
  const log = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- a\n\n## [0.9.0]\n\n- b\n\n[1.0.0]: https://x\n";
  assert.equal(changelogSection(log, "1.0.0"), "### Added\n\n- a");
  assert.equal(changelogSection(log, "0.9.0"), "- b");
  assert.equal(changelogSection(log, "2.0.0"), null);
});
