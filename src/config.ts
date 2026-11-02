/**
 * Every identifier that must stay in sync with manifest.json and the Executa
 * lives here. `npm run check:consistency` fails if any of them drift.
 */

/** Executa identity: manifest `required_executas` = "bundled:<slug>", Executa `describe().name`. */
export const TOOL_SLUG = "mini-notes-summarizer";

/** Tool name inside the Executa (`describe().tools[].name`), sent as `method`. */
export const TOOL_METHOD = "summarize";

/**
 * tool_id used by local `anna-app dev`, where the bundled executa is registered
 * under a placeholder id. At publish time Anna mints the real id and exposes it
 * via `window.__ANNA_TOOL_IDS__[TOOL_SLUG]`, which takes precedence.
 */
export const DEV_FALLBACK_TOOL_ID = `tool-test-${TOOL_SLUG}-12345678`;

/** The single Anna storage key holding all notes (JSON string). */
export const STORAGE_KEY = "mini-notes:v1";

export const MAX_NOTE_LENGTH = 500;

/** Anna App Runtime SDK, served by the host at this absolute path. */
export const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";
