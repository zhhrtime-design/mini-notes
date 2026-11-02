import type { AuditEntry } from "../anna/audit";
import type { Note } from "../storage/notesStore";
import { isNoLlmError, type SummaryResult } from "../tools/summarizer";

/** DOM lookups + pure rendering. All text goes through textContent (no innerHTML). */
export interface Els {
  conn: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  addBtn: HTMLButtonElement;
  formError: HTMLElement;
  count: HTMLElement;
  reloadBtn: HTMLButtonElement;
  empty: HTMLElement;
  listError: HTMLElement;
  list: HTMLOListElement;
  summarizeBtn: HTMLButtonElement;
  summary: HTMLElement;
  audit: HTMLElement;
  auditCount: HTMLElement;
}

export function queryEls(doc: Document = document): Els {
  const get = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`missing #${id} in index.html`);
    return el as T;
  };
  return {
    conn: get("conn"),
    form: get("note-form"),
    input: get("note-input"),
    addBtn: get("add-btn"),
    formError: get("form-error"),
    count: get("count"),
    reloadBtn: get("reload-btn"),
    empty: get("empty"),
    listError: get("list-error"),
    list: get("notes"),
    summarizeBtn: get("summarize-btn"),
    summary: get("summary"),
    audit: get("audit"),
    auditCount: get("audit-count"),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function setConnection(els: Els, state: "connecting" | "on" | "off", label: string): void {
  els.conn.className = `badge ${state === "on" ? "badge--on" : state === "off" ? "badge--err" : "badge--off"}`;
  els.conn.textContent = label;
}

export function setError(node: HTMLElement, message: string | null): void {
  node.hidden = !message;
  node.textContent = message ?? "";
}

export function renderNotes(els: Els, notes: readonly Note[], onDelete: (id: string) => void): void {
  els.list.replaceChildren();
  els.count.textContent = notes.length ? `(${notes.length})` : "";
  els.empty.hidden = notes.length > 0;

  for (const n of notes) {
    const li = el("li", "note");
    li.dataset.noteId = n.id;
    li.append(el("span", "note__seq", `#${n.seq}`));

    const body = el("div");
    body.append(el("span", "note__text", n.text));
    if (n.created_at) body.append(el("time", "note__time", new Date(n.created_at).toLocaleString()));
    li.append(body);

    const del = el("button", "btn--danger", "Delete");
    del.type = "button";
    del.setAttribute("aria-label", `Delete note #${n.seq}`);
    del.addEventListener("click", () => onDelete(n.id));
    li.append(del);

    els.list.append(li);
  }
}

export function renderSummaryIdle(els: Els): void {
  els.summary.replaceChildren(el("p", "muted", "Click Summarize to ask the host LLM (via the Executa tool) for a short summary."));
}

export function renderSummaryLoading(els: Els): void {
  els.summary.replaceChildren(el("p", "muted", "Asking the host LLM through the Executa tool…"));
}

export function renderSummaryResult(els: Els, r: SummaryResult): void {
  const meta = [
    r.source && `via ${r.source}`,
    r.model && `model: ${r.model}`,
    r.noteCount !== undefined && `${r.noteCount} note(s)`,
    r.invokeId && `invoke_id: ${r.invokeId}`,
  ].filter(Boolean);
  els.summary.replaceChildren(el("p", "summary__text", r.summary), el("p", "summary__meta", meta.join(" · ")));
}

export function renderSummaryError(els: Els, message: string): void {
  const children: HTMLElement[] = [el("p", "summary__error", `Summarize failed: ${message}`)];
  if (isNoLlmError(message)) {
    children.push(
      el(
        "p",
        "summary__hint",
        "Expected in `anna-app dev --no-llm`: the harness disables LLM/sampling, so the tool call is routed correctly " +
          "but cannot be answered. This does not mean the Executa's sampling is broken — test that with " +
          "`anna-app executa dev --mock-sampling` (see README).",
      ),
    );
  }
  els.summary.replaceChildren(...children);
}

export function renderAudit(els: Els, entries: readonly AuditEntry[]): void {
  els.auditCount.textContent = entries.length ? `(${entries.length})` : "";
  const recent = entries.slice(-30).reverse();
  els.audit.replaceChildren(
    ...recent.map((e) => {
      const li = el("li", e.ok ? "audit__ok" : "audit__bad");
      const time = e.at.slice(11, 19);
      li.textContent = `${time} ${e.api} ${e.detail} ${e.ok ? "ok" : "ERROR: " + e.error} ${e.ms}ms`;
      return li;
    }),
  );
}
