import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/checkSingleVersion.mjs <package-name>");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");

function findCopies(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // unreadable or gone: nothing to report
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === ".bin" || entry.name === ".cache") continue;

    const path = join(dir, entry.name);

    // A scope directory (@types, @tanstack) holds packages, not a package.
    if (entry.name.startsWith("@")) {
      findCopies(path, found);
      continue;
    }

    const manifest = join(path, "package.json");
    try {
      if (statSync(manifest).isFile()) {
        const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
        if (name === target) found.push([version, path]);
      }
    } catch {
      // not a package directory
    }

    const nested = join(path, "node_modules");
    try {
      if (statSync(nested).isDirectory()) findCopies(nested, found);
    } catch {
      // no nested tree
    }
  }

  return found;
}

const copies = findCopies(join(root, "node_modules"));
const versions = [...new Set(copies.map(([version]) => version))].sort();

if (copies.length === 0) {
  console.error(`${target}: not installed`);
  process.exit(1);
}

if (versions.length > 1) {
  console.error(`${target}: ${versions.length} versions installed, expected 1\n`);
  for (const [version, path] of copies.sort()) {
    console.error(`  ${version}  ${path.slice(root.length + 1)}`);
  }
  console.error(
    `\nThe ingest pipeline and the browser viewer must extract PDF text` +
      `\nidentically. Pin an exact version in both manifests and in the root` +
      `\n"overrides", then reinstall.`,
  );
  process.exit(1);
}

console.log(`${target}: ${versions[0]} (${copies.length} copy${copies.length === 1 ? "" : "ies"})`);
