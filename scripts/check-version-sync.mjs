#!/usr/bin/env node
// pre-commit check: the 4 hardcoded version locations must all agree with
// package.json. Catches a partial/manual version edit before it's committed.
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const mainTs = readFileSync("src/main.ts", "utf8");
const gremlinTs = readFileSync("src/client/gremlin.ts", "utf8");

const checks = [
  ["package-lock.json (root \"version\")", lock.version],
  ['package-lock.json (packages[""].version)', lock.packages?.[""]?.version],
  ["src/main.ts", mainTs.match(/version:\s*"([\d.]+)"/)?.[1]],
  ["src/client/gremlin.ts", gremlinTs.match(/@gremlin\/gremlin-mcp\/([\d.]+)/)?.[1]],
];

const mismatches = checks.filter(([, v]) => v !== version);

if (mismatches.length > 0) {
  console.error(`\n✖ Version mismatch: package.json is ${version}, but:`);
  for (const [name, v] of mismatches) {
    console.error(`  - ${name}: ${v ?? "(not found)"}`);
  }
  console.error(`\n  Run: make bump VERSION=<major|minor|patch>, or fix manually to ${version}.\n`);
  process.exit(1);
}
