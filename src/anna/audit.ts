import type { AnnaHost } from "./types";

export interface AuditEntry {
  id: number;
  at: string;
  api: "storage.get" | "storage.set" | "tools.invoke";
  detail: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Records every Host API call the app makes. It is the evidence trail that
 * notes go through `anna.storage.*` and summaries through `anna.tools.invoke`:
 * it is rendered in the "Host API activity" panel and mirrored to the console
 * as `[anna-call] ...`.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  list(): readonly AuditEntry[] {
    return this.entries;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(e: Omit<AuditEntry, "id" | "at">): void {
    const entry: AuditEntry = { id: ++this.seq, at: new Date().toISOString(), ...e };
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();
    console.info(`[anna-call] ${entry.api} ${entry.detail} ${entry.ok ? "ok" : "ERROR " + entry.error} (${entry.ms}ms)`);
    this.listeners.forEach((fn) => fn());
  }
}

/** Wraps a host so every call is timed and logged; behaviour is otherwise unchanged. */
export function withAudit(host: AnnaHost, log: AuditLog): AnnaHost {
  async function track<T>(api: AuditEntry["api"], detail: string, call: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      const res = await call();
      log.record({ api, detail, ok: true, ms: Math.round(performance.now() - t0) });
      return res;
    } catch (e) {
      log.record({ api, detail, ok: false, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  return {
    storage: {
      get: (a) => track("storage.get", `key=${a.key}`, () => host.storage.get(a)),
      set: (a) => {
        const size = typeof a.value === "string" ? ` (${a.value.length} chars)` : "";
        return track("storage.set", `key=${a.key}${size}`, () => host.storage.set(a));
      },
    },
    tools: {
      invoke: (a) => track("tools.invoke", `${a.tool_id} method=${a.method}`, () => host.tools.invoke(a)),
    },
  };
}
