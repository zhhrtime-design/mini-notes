import { SDK_URL } from "../config";
import type { AnnaHost } from "./types";

interface SdkModule {
  AnnaAppRuntime: { connect(): Promise<unknown> };
}

/**
 * Connects this iframe to the Anna host via AnnaAppRuntime.connect().
 *
 * The SDK is loaded with a dynamic import so that opening the bundle outside
 * Anna (no SDK, no `wid`/`t` URL params) fails here — and the UI can show a
 * clear "not connected" state — instead of breaking module loading entirely.
 * There is deliberately no fallback storage: without Anna, nothing is saved.
 */
export async function connectAnna(): Promise<AnnaHost> {
  const sdk = (await import(/* @vite-ignore */ SDK_URL)) as SdkModule;
  const anna = (await sdk.AnnaAppRuntime.connect()) as Partial<AnnaHost> | null;
  if (!anna?.storage || !anna?.tools) {
    throw new Error("Anna runtime connected but storage/tools Host API are unavailable (check manifest ui.host_api)");
  }
  return anna as AnnaHost;
}
