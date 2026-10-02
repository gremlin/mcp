#!/usr/bin/env node
// Bumps the server version everywhere it's hardcoded:
//   package.json, package-lock.json (x2), src/server.ts, src/client/gremlin.ts
//
// Usage: make bump VERSION=<major|minor|patch>
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bumpType = process.argv[2];

if (!["major", "minor", "patch"].includes(bumpType)) {
  console.error("Usage: make bump VERSION=<major|minor|patch>");
  process.exit(1);
}

function nextVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldVersion = pkg.version;
const newVersion = nextVersion(oldVersion, bumpType);

// package.json
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// package-lock.json (root "version" + packages[""].version)
const lockPath = path.join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = newVersion;
if (lock.packages?.[""]) lock.packages[""].version = newVersion;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");

// src/server.ts — export const SERVER_VERSION = "x.y.z"
//
// This lived in src/main.ts until server construction moved into src/server.ts, at which point
// the replacement below silently stopped matching: the warning is printed, but `make bump` still
// exits 0, so the only visible symptom was the pre-commit sync check failing afterwards.
const serverPath = path.join(root, "src/server.ts");
const server = readFileSync(serverPath, "utf8");
const nextServer = server.replace(
  /(SERVER_VERSION\s*=\s*)(['"])[\d.]+\2/,
  `$1$2${newVersion}$2`
);
if (nextServer === server) {
  console.error(`Warning: could not find a version string to replace in src/server.ts`);
} else {
  writeFileSync(serverPath, nextServer);
}

// src/client/gremlin.ts — userAgent = "@gremlin/gremlin-mcp/x.y.z"
const gremlinPath = path.join(root, "src/client/gremlin.ts");
const gremlin = readFileSync(gremlinPath, "utf8");
const nextGremlin = gremlin.replace(
  /@gremlin\/gremlin-mcp\/[\d.]+/,
  `@gremlin/gremlin-mcp/${newVersion}`
);
if (nextGremlin === gremlin) {
  console.error(`Warning: could not find a version string to replace in src/client/gremlin.ts`);
} else {
  writeFileSync(gremlinPath, nextGremlin);
}

console.log(`Bumped version: ${oldVersion} -> ${newVersion} (${bumpType})`);
