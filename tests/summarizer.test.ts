import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolsApi } from "../src/anna/types";
import { DEV_FALLBACK_TOOL_ID, TOOL_METHOD } from "../src/config";
import type { Note } from "../src/storage/notesStore";
import { isNoLlmError, summarizeNotes } from "../src/tools/summarizer";

const notes: Note[] = [
  { id: "a", seq: 1, text: "明天跟客户 follow up", created_at: "" },
  { id: "b", seq: 2, text: "修复登录 bug", created_at: "" },
];

test("invokes the tool via anna.tools.invoke with ordered notes and returns the tool's summary", async () => {
  let seen: Parameters<ToolsApi["invoke"]>[0] | undefined;
  const tools: ToolsApi = {
    async invoke(a) {
      seen = a;
      return { success: true, tool: "summarize", data: { summary: " HOST TEXT ", model: "m", invoke_id: "i1", source: "sampling/createMessage", note_count: 2 } };
    },
  };
  const r = await summarizeNotes(tools, notes);
  assert.equal(seen?.tool_id, DEV_FALLBACK_TOOL_ID);
  assert.equal(seen?.method, TOOL_METHOD);
  assert.deepEqual(seen?.args, { notes: [{ seq: 1, text: "明天跟客户 follow up" }, { seq: 2, text: "修复登录 bug" }] });
  assert.equal(r.summary, "HOST TEXT");
  assert.equal(r.source, "sampling/createMessage");
});

test("errors from the tool propagate; no local summary is invented", async () => {
  const tools: ToolsApi = { invoke: async () => Promise.reject(new Error("[-32603] harness started with --no-llm")) };
  await assert.rejects(summarizeNotes(tools, notes), (e: Error) => isNoLlmError(e.message));
});

test("an empty summary is an error, not a fallback", async () => {
  const tools: ToolsApi = { invoke: async () => ({ success: true, data: { summary: "  " } }) };
  await assert.rejects(summarizeNotes(tools, notes), /no summary/);
});

test("refuses to call the tool with zero notes", async () => {
  let called = false;
  const tools: ToolsApi = { invoke: async () => ((called = true), {}) };
  await assert.rejects(summarizeNotes(tools, []), /no notes/);
  assert.equal(called, false);
});
