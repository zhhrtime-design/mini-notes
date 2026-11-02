#!/usr/bin/env node
/**
 * Manual / CI protocol test for the Executa binary.
 *
 * It plays the role of the Anna host over stdio:
 *   initialize (v2) -> describe -> health -> invoke(summarize)
 * and, while `invoke` is in flight, ANSWERS the tool's reverse
 * `sampling/createMessage` request on the same stdin using the mock-sampling
 * fixture. Every frame in both directions is recorded as evidence.
 *
 * Usage:
 *   node scripts/protocol-test.mjs                      # build from source, full test
 *   node scripts/protocol-test.mjs --exe path/to/binary # test a built binary
 *   node scripts/protocol-test.mjs --exe <bin> --smoke  # describe/initialize/health only (CI smoke)
 *
 * Options:
 *   --fixture <file>   mock sampling fixture (default: executas/.../fixtures/sampling.jsonl)
 *   --evidence <file>  where to write the frame log (default: logs/protocol-evidence.jsonl)
 *
 * Exit code 0 = every check passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execaDir = join(root, "executas", "mini-notes-summarizer");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const smokeOnly = flag("--smoke");
const fixturePath = resolve(opt("--fixture", join(execaDir, "fixtures", "sampling.jsonl")));
const evidencePath = resolve(opt("--evidence", join(root, "logs", "protocol-evidence.jsonl")));
let exe = opt("--exe", null);

// ── locate / build the binary ────────────────────────────────────────
if (!exe) {
  const out = join(root, ".build", process.platform === "win32" ? "mini-notes-summarizer.exe" : "mini-notes-summarizer");
  mkdirSync(dirname(out), { recursive: true });
  console.log(`# building from source -> ${out}`);
  const r = spawnSync("go", ["build", "-o", out, "."], { cwd: execaDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("go build failed (is Go installed? use --exe to test a prebuilt binary)");
    process.exit(2);
  }
  exe = out;
}
exe = resolve(exe);
if (!existsSync(exe)) {
  console.error(`binary not found: ${exe}`);
  process.exit(2);
}

// ── fixture ──────────────────────────────────────────────────────────
const fixtures = readFileSync(fixturePath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith("#"))
  .map((l) => JSON.parse(l))
  .filter((e) => e.ns === "sampling" && e.method === "createMessage");

function pickFixture(promptText) {
  const hit = fixtures.find((f) => f.match?.contentIncludes && promptText.includes(f.match.contentIncludes));
  return hit ?? fixtures.find((f) => !f.match);
}

// ── process + frame plumbing ─────────────────────────────────────────
const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
const evidence = [];
const stderrLines = [];
const nonJsonStdout = [];
const pending = new Map();
let nextId = 1;
const checks = [];

function record(dir, frame) {
  evidence.push({ t: new Date().toISOString(), dir, frame });
}
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
function send(frame) {
  record("host->tool", frame);
  child.stdin.write(JSON.stringify(frame) + "\n");
}
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for response to ${method}`)), 10_000);
    pending.set(id, (f) => (clearTimeout(t), res(f)));
  });
  send({ jsonrpc: "2.0", id, method, params });
  return p;
}

const reverseRequests = [];
function onStdoutLine(line) {
  if (!line.trim()) return;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    nonJsonStdout.push(line);
    return;
  }
  record("tool->host", f);

  if (f.method === "sampling/createMessage") {
    // Reverse request from the tool: answer it like the host LLM would.
    reverseRequests.push(f);
    const prompt = f.params?.messages?.map((m) => m.content?.text ?? "").join("\n") ?? "";
    const fx = pickFixture(prompt);
    send(fx ? { jsonrpc: "2.0", id: f.id, result: fx.result } : { jsonrpc: "2.0", id: f.id, error: { code: -32603, message: "no matching mock fixture" } });
    return;
  }
  if (f.id !== undefined && pending.has(f.id)) {
    const cb = pending.get(f.id);
    pending.delete(f.id);
    cb(f);
  }
}

createInterface({ input: child.stdout }).on("line", onStdoutLine);
createInterface({ input: child.stderr }).on("line", (l) => stderrLines.push(l));
const exited = new Promise((res) => child.on("exit", (code, sig) => res({ code, sig })));

// ── the test ─────────────────────────────────────────────────────────
const NOTES = [
  { seq: 1, text: "明天跟客户 follow up" },
  { seq: 2, text: "修复登录 bug" },
  { seq: 3, text: "Workshop 内容想法" },
];
const INVOKE_ID = "protocol-test-invoke-1";

console.log(`# binary:   ${exe}`);
console.log(`# mode:     ${smokeOnly ? "smoke (initialize/describe/health)" : "full (incl. invoke + reverse sampling)"}`);
if (!smokeOnly) console.log(`# fixture:  ${fixturePath}`);
console.log("");

try {
  const init = await request("initialize", { protocolVersion: "2.0" });
  check("initialize: protocolVersion negotiated to 2.0", init.result?.protocolVersion === "2.0", JSON.stringify(init));
  check("initialize: client_capabilities.sampling declared", init.result?.client_capabilities && "sampling" in init.result.client_capabilities);

  const desc = await request("describe");
  const m = desc.result ?? {};
  for (const k of ["name", "display_name", "version", "description", "host_capabilities", "tools", "runtime"]) {
    check(`describe: has "${k}"`, k in m);
  }
  check('describe: host_capabilities == ["llm.sample"]', JSON.stringify(m.host_capabilities) === '["llm.sample"]');
  check("describe: tool uses parameters[] (no input_schema)", Array.isArray(m.tools?.[0]?.parameters) && !("input_schema" in (m.tools?.[0] ?? {})));
  check('describe: tools[0].name == "summarize"', m.tools?.[0]?.name === "summarize");

  const health = await request("health");
  check("health: status == healthy", health.result?.status === "healthy");

  if (!smokeOnly) {
    const inv = await request("invoke", { tool: "summarize", arguments: { notes: NOTES }, invoke_id: INVOKE_ID });
    const sreq = reverseRequests[0];
    check("invoke: tool issued reverse sampling/createMessage", !!sreq, "no reverse request observed on stdout");
    check("sampling request: metadata.executa_invoke_id == invoke_id", sreq?.params?.metadata?.executa_invoke_id === INVOKE_ID, JSON.stringify(sreq?.params?.metadata));
    const promptText = sreq?.params?.messages?.[0]?.content?.text ?? "";
    check("sampling request: prompt contains every note", NOTES.every((n) => promptText.includes(n.text)), promptText);
    check("sampling request: maxTokens > 0", sreq?.params?.maxTokens > 0);

    const expected = pickFixture(promptText)?.result?.content?.text;
    check("invoke: success envelope", inv.result?.success === true && inv.result?.tool === "summarize", JSON.stringify(inv));
    check("invoke: summary === text returned by sampling (verbatim)", !!expected && inv.result?.data?.summary === expected, `got ${JSON.stringify(inv.result?.data?.summary)}`);
    check('invoke: data.source == "sampling/createMessage"', inv.result?.data?.source === "sampling/createMessage");
  }

  // EOF -> clean exit (process must keep running until stdin closes)
  child.stdin.end();
  const { code } = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: "timeout" }), 5000))]);
  check("process exits 0 after stdin EOF (and not before)", code === 0, `exit=${code}`);
} catch (e) {
  check("protocol run completed", false, e.message);
  child.kill();
}

check("stdout carried JSON-RPC only (no logs/banners)", nonJsonStdout.length === 0, nonJsonStdout.join(" | "));
check("stderr carries the logs", stderrLines.some((l) => l.includes("started")));

// ── evidence ─────────────────────────────────────────────────────────
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, evidence.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`\n# evidence frames: ${evidence.length} -> ${evidencePath}`);
if (!smokeOnly) {
  console.log("# stderr of the tool (sampling is logged here):");
  for (const l of stderrLines) console.log("#   " + l);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${checks.length - failed.length}/${checks.length})`);
process.exit(failed.length === 0 ? 0 : 1);
