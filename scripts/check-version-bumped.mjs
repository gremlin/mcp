#!/usr/bin/env node
// pre-push check: if this branch changes real files vs the base branch,
// package.json's version must have moved too. Set SKIP_VERSION_CHECK=1 to
// bypass (e.g. hotfix/merge-back branches).
import { readFileSync } from "fs";
import { execSync } from "child_process";

if (process.env.SKIP_VERSION_CHECK) process.exit(0);

const BASE_BRANCH = process.env.VERSION_CHECK_BASE || "main";

function sh(cmd) {
  // stdio: 'pipe' for stdin/stdout/stderr — keeps expected git failures
  // (e.g. no "origin/main" remote-tracking branch) from printing to the console.
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
}

let currentBranch;
try {
  currentBranch = sh("git rev-parse --abbrev-ref HEAD");
} catch {
  process.exit(0); // no valid HEAD yet (e.g. empty repo) — nothing to check
}
if (currentBranch === BASE_BRANCH) process.exit(0); // on main itself — nothing to compare against

let base;
try {
  base = sh(`git merge-base HEAD origin/${BASE_BRANCH}`);
} catch {
  try {
    base = sh(`git merge-base HEAD ${BASE_BRANCH}`);
  } catch {
    console.warn(`[version-check] Couldn't find base branch "${BASE_BRANCH}" — skipping bump check.`);
    process.exit(0);
  }
}

const changedFiles = sh(`git diff --name-only ${base} HEAD`).split("\n").filter(Boolean);
// Docs, tests, and dev tooling scripts don't need a version bump; everything
// else does (including the version-carrying files themselves, since they're
// normal source/config files that can change for reasons unrelated to
// bumping). git diff --name-only
// always uses forward slashes, even on Windows, so these prefix checks are
// safe cross-platform.
const EXEMPT_PREFIXES = ["tests/", "scripts/"];
const meaningfulChanges = changedFiles.filter(
  (f) => !/\.md$/i.test(f) && !EXEMPT_PREFIXES.some((p) => f.startsWith(p))
);

if (meaningfulChanges.length === 0) process.exit(0);

const baseVersion = (() => {
  try {
    return sh(`git show ${base}:package.json`).match(/"version":\s*"([\d.]+)"/)?.[1];
  } catch {
    return undefined;
  }
})();
const headVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

if (baseVersion && baseVersion === headVersion) {
  console.error(
    `\n✖ package.json is still ${headVersion} (same as ${BASE_BRANCH}), but this branch changes:\n` +
      meaningfulChanges.map((f) => `  - ${f}`).join("\n") +
      `\n\n  Run: make bump VERSION=<major|minor|patch>\n` +
      `  (or set SKIP_VERSION_CHECK=1 to bypass for this push)\n`
  );
  process.exit(1);
}
