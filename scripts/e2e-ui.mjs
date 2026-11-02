#!/usr/bin/env node
/**
 * Browser end-to-end test of the BUILT bundle (bundle/), without Anna.
 *
 * A small stand-in for the Anna host serves bundle/ plus a fake
 * `/static/anna-apps/_sdk/latest/index.js` whose AnnaAppRuntime.connect()
 * forwards `storage.get/set` and `tools.invoke` to this process:
 *   - storage  -> an in-memory Map (like the legacy runtime_state)
 *   - tools.invoke -> spawns the REAL Executa binary, performs initialize(v2),
 *     sends `invoke`, and answers the tool's reverse sampling/createMessage from
 *     the mock fixture. (This test host is NOT part of the shipped app.)
 *
 * Usage: node scripts/e2e-ui.mjs [--exe <binary>]   (needs Playwright + Chromium)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const exe = resolve(argv.includes("--exe") ? argv[argv.indexOf("--exe") + 1] : join(root, ".build", process.platform === "win32" ? "mini-notes-summarizer.exe" : "mini-notes-summarizer"));
const fixturePath = join(root, "executas", "mini-notes-summarizer", "fixtures", "sampling.jsonl");
const fixtures = readFileSync(fixturePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (!existsSync(exe)) throw new Error(`binary not found: ${exe} (run: node scripts/protocol-test.mjs first)`);

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const SDK = `
export const AnnaAppRuntime = { async connect() {
  const rpc = async (ns, method, args) => {
    const r = await fetch("/__rpc", { method: "POST", body: JSON.stringify({ ns, method, args }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  };
  return {
    storage: { get: (a) => rpc("storage", "get", a), set: (a) => rpc("storage", "set", a) },
    tools: { invoke: (a) => rpc("tools", "invoke", a) },
  };
} };`;

const store = new Map();
const hostLog = []; // evidence of what reached the "host"
let noLlm = false;

function runTool(args) {
  return new Promise((res, rej) => {
    const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
    const send = (f) => child.stdin.write(JSON.stringify(f) + "\n");
    let stage = 0;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const f = JSON.parse(line);
      if (f.method === "sampling/createMessage") {
        hostLog.push({ type: "sampling/createMessage", metadata: f.params.metadata });
        const text = f.params.messages[0].content.text;
        const fx = fixtures.find((x) => x.match?.contentIncludes && text.includes(x.match.contentIncludes)) ?? fixtures.find((x) => !x.match);
        send({ jsonrpc: "2.0", id: f.id, result: fx.result });
      } else if (f.id === 1 && stage === 0) {
        stage = 1;
        send({ jsonrpc: "2.0", id: 2, method: "invoke", params: { tool: args.method, arguments: args.args, invoke_id: "e2e-" + Date.now() } });
      } else if (f.id === 2) {
        child.stdin.end();
        f.error ? rej(new Error(`[${f.error.code}] ${f.error.message}`)) : res(f.result);
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2.0" } });
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/static/anna-apps/_sdk/latest/index.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(SDK);
  if (url.pathname === "/__rpc") {
    let body = "";
    for await (const c of req) body += c;
    const { ns, method, args } = JSON.parse(body);
    hostLog.push({ type: `${ns}.${method}`, key: args?.key });
    try {
      let result;
      if (ns === "storage" && method === "get") result = store.has(args.key) ? { value: store.get(args.key) } : {};
      else if (ns === "storage" && method === "set") (store.set(args.key, args.value), (result = { ok: true }));
      else if (ns === "tools" && method === "invoke") {
        if (noLlm) throw new Error("[-32603] harness started with --no-llm");
        result = await runTool(args);
      } else throw new Error(`unsupported ${ns}.${method}`);
      res.writeHead(200).end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(200).end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const file = join(root, "bundle", url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(join(root, "bundle")) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

let failed = 0;
const check = (name, ok, detail = "") => (console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  -> " + detail : ""}`), ok || failed++);

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(base);
await page.waitForSelector("#conn.badge--on");

const texts = () => page.$$eval(".note__text", (n) => n.map((x) => x.textContent));
const seqs = () => page.$$eval(".note__seq", (n) => n.map((x) => x.textContent));

check("connected badge shown", (await page.textContent("#conn")).includes("Connected"));
check("empty state visible, Summarize disabled", (await page.isVisible("#empty")) && (await page.isDisabled("#summarize-btn")));

await page.click("#add-btn");
check("empty input is not saved", (await texts()).length === 0 && (await page.isVisible("#form-error")));

for (const t of ["明天跟客户 follow up", "修复登录 bug", "Workshop 内容想法"]) {
  const expectedCount = (await texts()).length + 1;
  await page.fill("#note-input", t);
  await page.click("#add-btn");
  await page.waitForFunction((n) => document.querySelectorAll(".note").length === n, expectedCount);
}
check("three notes listed with order #1..#3", JSON.stringify(await seqs()) === '["#1","#2","#3"]', JSON.stringify(await seqs()));
check("input cleared after save", (await page.inputValue("#note-input")) === "");
const saved = JSON.parse(store.get("mini-notes:v1"));
check("notes were written via storage.set (JSON in Anna storage)", saved.notes.length === 3 && hostLog.some((l) => l.type === "storage.set"));

await page.click('button[aria-label="Delete note #2"]');
await page.waitForFunction(() => document.querySelectorAll(".note").length === 2);
check("delete updates the list immediately", JSON.stringify(await texts()) === JSON.stringify(["明天跟客户 follow up", "Workshop 内容想法"]));
check("delete persisted through storage.set", JSON.parse(store.get("mini-notes:v1")).notes.length === 2);

await page.reload();
await page.waitForSelector("#conn.badge--on");
check("after reload notes come back from storage", (await texts()).length === 2);

// Summarize -> tools.invoke -> real binary -> reverse sampling answered by the fixture
hostLog.length = 0;
await page.click("#summarize-btn");
await page.waitForSelector(".summary__text", { timeout: 15000 });
const summary = await page.textContent(".summary__text");
check("summary shows the sampling (fixture) text", summary.startsWith("[mock-sampling] Follow up with the client"), summary);
check("host saw tools.invoke then sampling/createMessage", hostLog.map((l) => l.type).join(",").includes("tools.invoke,sampling/createMessage"), JSON.stringify(hostLog));
check("sampling metadata carries an invoke id", /^e2e-/.test(hostLog.find((l) => l.type === "sampling/createMessage")?.metadata?.executa_invoke_id ?? ""));
check("meta line mentions sampling/createMessage", (await page.textContent(".summary__meta")).includes("sampling/createMessage"));

// --no-llm behaviour
noLlm = true;
await page.click("#summarize-btn");
await page.waitForSelector(".summary__error");
check("--no-llm error is shown", (await page.textContent(".summary__error")).includes("[-32603] harness started with --no-llm"));
check("--no-llm explanatory hint shown", await page.isVisible(".summary__hint"));

const auditLines = await page.$$eval("#audit li", (l) => l.map((x) => x.textContent));
console.log("  Audit entries after reload:", JSON.stringify(auditLines));
check("audit has 5 entries: reload get + two (get, invoke) attempts", auditLines.length === 5 && (await page.textContent("#audit-count")) === "(5)", JSON.stringify(auditLines));
check("Host API activity panel lists storage.get + tools.invoke calls (log restarts on reload)", auditLines.some((l) => l.includes("storage.get")) && auditLines.filter((l) => l.includes("tools.invoke")).length === 2, JSON.stringify(auditLines));
check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

mkdirSync(join(root, "logs"), { recursive: true });
await page.screenshot({ path: join(root, "logs", "ui.png"), fullPage: true });
await browser.close();
server.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL UI CHECKS PASSED");
process.exit(failed ? 1 : 0);
