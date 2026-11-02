import { MAX_NOTE_LENGTH, STORAGE_KEY } from "../config";
import type { StorageApi } from "../anna/types";

export interface Note {
  id: string;
  /** Insertion order: 1, 2, 3 … never reused, even after deletions. */
  seq: number;
  text: string;
  created_at: string;
}

export interface NotesState {
  version: 1;
  next_seq: number;
  notes: Note[];
}

export class EmptyNoteError extends Error {
  constructor() {
    super("Note is empty");
    this.name = "EmptyNoteError";
  }
}

export class StorageCorruptError extends Error {
  constructor(detail: string) {
    super(`Stored notes are unreadable (${detail}). Nothing was overwritten.`);
    this.name = "StorageCorruptError";
  }
}

const emptyState = (): NotesState => ({ version: 1, next_seq: 1, notes: [] });

/** Decodes what `anna.storage.get` returned. Missing => empty; garbage => throws (never silently overwritten). */
export function parseState(raw: unknown): NotesState {
  if (raw === null || raw === undefined || raw === "") return emptyState();

  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new StorageCorruptError("not valid JSON");
    }
  }
  if (typeof data !== "object" || data === null) throw new StorageCorruptError("unexpected type");

  const obj = data as Partial<NotesState>;
  if (!Array.isArray(obj.notes)) throw new StorageCorruptError("missing notes array");

  const notes: Note[] = [];
  for (const n of obj.notes) {
    const note = n as Partial<Note> | null;
    if (!note || typeof note.id !== "string" || typeof note.seq !== "number" || typeof note.text !== "string") {
      throw new StorageCorruptError("malformed note entry");
    }
    notes.push({ id: note.id, seq: note.seq, text: note.text, created_at: typeof note.created_at === "string" ? note.created_at : "" });
  }
  const maxSeq = notes.reduce((m, n) => Math.max(m, n.seq), 0);
  const next = typeof obj.next_seq === "number" && obj.next_seq > maxSeq ? obj.next_seq : maxSeq + 1;
  return { version: 1, next_seq: next, notes };
}

/**
 * Notes persistence on top of Anna's storage Host API.
 *
 *   load()    -> anna.storage.get
 *   add()     -> anna.storage.get  then  anna.storage.set
 *   remove()  -> anna.storage.get  then  anna.storage.set
 *
 * It only talks to the injected `StorageApi` — no localStorage, IndexedDB,
 * files or in-memory copy are used as a source of truth. Every operation
 * re-reads from storage first, and operations are serialised so rapid clicks
 * cannot interleave their read-modify-write cycles and lose a note.
 */
export class NotesStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageApi,
    private readonly key: string = STORAGE_KEY,
    private readonly now: () => Date = () => new Date(),
  ) {}

  load(): Promise<NotesState> {
    return this.enqueue(() => this.read());
  }

  add(text: string): Promise<NotesState> {
    const clean = text.trim();
    if (!clean) return Promise.reject(new EmptyNoteError());
    if (clean.length > MAX_NOTE_LENGTH) return Promise.reject(new Error(`Note is too long (max ${MAX_NOTE_LENGTH} characters)`));

    return this.enqueue(async () => {
      const state = await this.read();
      const seq = state.next_seq;
      const note: Note = { id: `n${seq}-${this.now().getTime().toString(36)}`, seq, text: clean, created_at: this.now().toISOString() };
      const next: NotesState = { version: 1, next_seq: seq + 1, notes: [...state.notes, note] };
      await this.write(next);
      return next;
    });
  }

  remove(id: string): Promise<NotesState> {
    return this.enqueue(async () => {
      const state = await this.read();
      const notes = state.notes.filter((n) => n.id !== id);
      if (notes.length === state.notes.length) return state; // already gone: no write needed
      const next: NotesState = { ...state, notes };
      await this.write(next);
      return next;
    });
  }

  private async read(): Promise<NotesState> {
    const res = await this.storage.get({ key: this.key });
    return parseState(res?.value);
  }

  private async write(state: NotesState): Promise<void> {
    await this.storage.set({ key: this.key, value: JSON.stringify(state) });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined); // keep the chain alive after a failure
    return run;
  }
}
