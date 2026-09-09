import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const STORAGE = process.env["NOTEBOOK_SANDBOX_DIR"] ?? join(ROOT, "storage-sandbox");

const [entry, ...rest] = process.argv.slice(2);
if (entry === undefined) {
  console.error("usage: node scripts/sandbox.mjs <entry.ts> [args...]");
  process.exit(2);
}

mkdirSync(join(STORAGE, "sources"), { recursive: true });
mkdirSync(join(STORAGE, "tmp"), { recursive: true });

console.log(`sandbox storage: ${STORAGE}`);
console.log(`real storage is untouched: ${join(ROOT, "storage")}\n`);

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", join(ROOT, entry), ...rest],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      NOTEBOOK_STORAGE_DIR: STORAGE,
      NOTEBOOK_API_PORT: process.env["NOTEBOOK_API_PORT"] ?? "8788",
    },
  },
);

child.on("exit", (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
