/** The slice of the Anna Host API this app uses (see manifest ui.host_api). */

export interface StorageApi {
  get(args: { key: string }): Promise<{ value?: unknown } | null | undefined>;
  set(args: { key: string; value: unknown }): Promise<unknown>;
}

export interface ToolsApi {
  invoke(args: { tool_id: string; method: string; args: Record<string, unknown> }): Promise<unknown>;
}

export interface AnnaHost {
  storage: StorageApi;
  tools: ToolsApi;
}

declare global {
  interface Window {
    /** Written by `anna-app apps publish` / dev: slug -> minted tool_id. */
    __ANNA_TOOL_IDS__?: Record<string, string>;
  }
}
