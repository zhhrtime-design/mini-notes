#!/usr/bin/env node
/**
 * Verifies that the Executa tool identity is identical everywhere it appears:
 *
 *   manifest.json   required_executas[].tool_id   "bundled:<slug>"
 *   manifest.json   ui.host_api.tools             covers the required executa
 *   src/config.ts   TOOL_SLUG / TOOL_METHOD       what the frontend calls
 *   executa.json    tool_id                       tool-test-<slug>-12345678
 *   manifest.go     toolSlug / toolSummarize      what `describe` returns (name / tools[].name)
 *   package_executa.py reads `describe`, so the archive manifest "name" follows the Go code.
 *
 * Exit code 1 and a list of mismatches if anything drifted.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const grab = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`could not find ${what}`);
  return m[1];
};

const manifest = JSON.parse(read("manifest.json"));
const app = JSON.parse(read("app.json"));
const execaJson = JSON.parse(read("executas/mini-notes-summarizer/executa.json"));
const goSrc = read("executas/mini-notes-summarizer/manifest.go");
const tsCfg = read("src/config.ts");

const required = manifest.required_executas ?? [];
const failures = [];
const rows = [];
const expect = (label, actual, want) => {
  const ok = actual === want;
  rows.push([ok ? "ok " : "BAD", label, actual]);
  if (!ok) failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
};

if (required.length !== 1) failures.push(`expected exactly 1 required executa, found ${required.length}`);
const toolId = required[0]?.tool_id ?? "";
const slug = toolId.replace(/^bundled:/, "");
expect("app.json bundled_executas path", app.bundled_executas?.[slug]?.path, `executas/${slug}`);
expect("manifest.required_executas[0].tool_id", toolId, `bundled:${slug}`);

expect("src/config.ts TOOL_SLUG", grab(tsCfg, /TOOL_SLUG\s*=\s*"([^"]+)"/, "TOOL_SLUG"), slug);
expect("manifest.go toolSlug (== describe().name)", grab(goSrc, /toolSlug\s*=\s*"([^"]+)"/, "toolSlug"), slug);
expect("executa.json tool_id", execaJson.tool_id, `tool-test-${slug}-12345678`);

const method = grab(tsCfg, /TOOL_METHOD\s*=\s*"([^"]+)"/, "TOOL_METHOD");
expect("manifest.go toolSummarize (== describe().tools[0].name)", grab(goSrc, /toolSummarize\s*=\s*"([^"]+)"/, "toolSummarize"), method);

const hostTools = manifest.ui?.host_api?.tools ?? [];
const covers = hostTools.includes("required:*") || hostTools.includes(`required:${toolId}`) || hostTools.includes(toolId);
rows.push([covers ? "ok " : "BAD", "manifest.ui.host_api.tools covers the executa", JSON.stringify(hostTools)]);
if (!covers) failures.push(`ui.host_api.tools ${JSON.stringify(hostTools)} does not cover ${toolId}`);

const storage = manifest.ui?.host_api?.storage ?? [];
const hasStorage = ["get", "set"].every((m) => storage.includes(m));
rows.push([hasStorage ? "ok " : "BAD", "manifest.ui.host_api.storage has get+set", JSON.stringify(storage)]);
if (!hasStorage) failures.push("ui.host_api.storage must include get and set");

for (const [s, l, v] of rows) console.log(`  ${s}  ${l}  ->  ${v}`);
if (failures.length) {
  console.error("\nIdentity mismatch:\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log(`\nConsistent: tool "${slug}", method "${method}".`);
