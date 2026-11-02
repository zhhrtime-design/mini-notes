#!/usr/bin/env node
/**
 * Builds the UI bundle that Anna loads.
 *
 *   src/index.html  ─┐
 *   src/styles.css  ─┼─►  bundle/index.html, bundle/style.css, bundle/app.js (+ .map)
 *   src/**\/*.ts    ─┘
 *
 * `manifest.json` -> ui.bundle.entry ("index.html") is relative to the built
 * `bundle/` directory, i.e. it points at bundle/index.html produced here.
 *
 * Output is plain ES modules with NO inline scripts (the bundle CSP is
 * `script-src 'self'`). Set NODE_ENV=development to skip minification.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "bundle");
const dev = process.env.NODE_ENV === "development";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { absWorkingDir: root, bundle: true, logLevel: "info", minify: !dev, legalComments: "none" };

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "bundle/app.js",
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: "linked",
});

await build({
  ...common,
  entryPoints: ["src/styles.css"],
  outfile: "bundle/style.css",
  sourcemap: false,
});

copyFileSync(join(root, "src", "index.html"), join(out, "index.html"));
// Publishing replaces this sidecar with server-minted tool ids.
const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
const toolIds = Object.fromEntries(Object.entries(app.bundled_executas).map(([handle, spec]) => [
  handle, JSON.parse(readFileSync(join(root, spec.path, "executa.json"), "utf8")).tool_id,
]));
writeFileSync(join(out, "anna-tool-ids.js"), `window.__ANNA_TOOL_IDS__ = ${JSON.stringify(toolIds)};\n`);

// Fail loudly if the manifest entry does not exist in the build output.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const entry = join(out, manifest.ui.bundle.entry);
if (!existsSync(entry)) {
  console.error(`manifest ui.bundle.entry '${manifest.ui.bundle.entry}' not found in bundle/`);
  process.exit(1);
}
const html = readFileSync(entry, "utf8");
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
  console.error("bundle/index.html contains an inline <script>; the bundle CSP forbids it");
  process.exit(1);
}
for (const f of ["index.html", "app.js", "style.css"]) {
  console.log(`  bundle/${f}  ${statSync(join(out, f)).size} bytes`);
}
console.log(`Built Anna App bundle -> bundle/ (entry: ${manifest.ui.bundle.entry})`);
