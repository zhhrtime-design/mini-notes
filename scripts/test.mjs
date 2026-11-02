#!/usr/bin/env node
/**
 * Runs tests/*.test.ts with Node's built-in test runner.
 * The TypeScript sources are bundled by esbuild first (no extra test deps).
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, ".build", "tests");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entries = readdirSync(join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join("tests", f));

await build({
  absWorkingDir: root,
  entryPoints: entries,
  outdir: ".build/tests",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});

const files = entries.map((e) => join(outdir, e.replace(/^tests[\\/]/, "").replace(/\.ts$/, ".mjs")));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
