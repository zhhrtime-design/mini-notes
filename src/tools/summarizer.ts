import { DEV_FALLBACK_TOOL_ID, TOOL_METHOD, TOOL_SLUG } from "../config";
import type { ToolsApi } from "../anna/types";
import type { Note } from "../storage/notesStore";

export interface SummaryResult {
  summary: string;
  model?: string;
  invokeId?: string;
  samplingRequestId?: string;
  source?: string;
  noteCount?: number;
}

/** The minted id Anna injects at publish/dev time, else the local-dev placeholder. */
export function resolveToolId(): string {
  return (typeof window !== "undefined" && window.__ANNA_TOOL_IDS__?.[TOOL_SLUG]) || DEV_FALLBACK_TOOL_ID;
}

/**
 * Asks the bundled Executa to summarize the notes:
 *
 *   anna.tools.invoke  ->  Executa `invoke`  ->  reverse sampling/createMessage  ->  host LLM
 *
 * The returned text is whatever the Executa reports from the host's sampling
 * response. This function never builds a summary itself; on any error (or an
 * empty result) it throws so the UI shows the failure instead of fake output.
 */
export async function summarizeNotes(tools: ToolsApi, notes: readonly Note[], toolId: string = resolveToolId()): Promise<SummaryResult> {
  if (notes.length === 0) throw new Error("There are no notes to summarize");

  const res = await tools.invoke({
    tool_id: toolId,
    method: TOOL_METHOD,
    args: { notes: notes.map(({ seq, text }) => ({ seq, text })) },
  });

  const data = unwrap(res);
  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (!summary) throw new Error("The summarize tool returned no summary");

  return {
    summary,
    model: str(data.model),
    invokeId: str(data.invoke_id),
    samplingRequestId: str(data.sampling_request_id),
    source: str(data.source),
    noteCount: typeof data.note_count === "number" ? data.note_count : undefined,
  };
}

/** Executa replies `{ success, tool, data: {...} }`; tolerate the host passing `data` or the bare object. */
function unwrap(res: unknown): Record<string, unknown> {
  const r = (res ?? {}) as Record<string, unknown>;
  if (r.data && typeof r.data === "object") return r.data as Record<string, unknown>;
  const inner = r.result as Record<string, unknown> | undefined;
  if (inner?.data && typeof inner.data === "object") return inner.data as Record<string, unknown>;
  return r;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for the harness error produced by `anna-app dev --no-llm`. */
export function isNoLlmError(message: string): boolean {
  return /--no-llm/.test(message);
}
