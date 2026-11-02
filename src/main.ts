import { AuditLog, withAudit } from "./anna/audit";
import { connectAnna } from "./anna/runtime";
import { EmptyNoteError, NotesStore, type Note } from "./storage/notesStore";
import { errorMessage, summarizeNotes } from "./tools/summarizer";
import {
  queryEls,
  renderAudit,
  renderNotes,
  renderSummaryError,
  renderSummaryIdle,
  renderSummaryLoading,
  renderSummaryResult,
  setConnection,
  setError,
} from "./ui/view";

async function main(): Promise<void> {
  const els = queryEls();
  const audit = new AuditLog();
  audit.subscribe(() => renderAudit(els, audit.list()));
  renderSummaryIdle(els);
  renderNotes(els, [], () => {});

  const controls = [els.input, els.addBtn, els.reloadBtn, els.summarizeBtn];
  controls.forEach((c) => (c.disabled = true));

  let anna;
  try {
    anna = withAudit(await connectAnna(), audit);
    setConnection(els, "on", "Connected to Anna");
  } catch (e) {
    setConnection(els, "off", "Not connected");
    setError(els.listError, `Open this app through Anna (\`anna-app dev\`). Nothing is saved outside Anna. (${errorMessage(e)})`);
    return;
  }

  const store = new NotesStore(anna.storage);
  let notes: readonly Note[] = [];

  const show = (next: readonly Note[]): void => {
    notes = next;
    renderNotes(els, notes, (id) => void remove(id));
    els.summarizeBtn.disabled = notes.length === 0;
  };

  const load = async (): Promise<void> => {
    setError(els.listError, null);
    try {
      show((await store.load()).notes);
    } catch (e) {
      setError(els.listError, `Could not load notes: ${errorMessage(e)}`);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setError(els.listError, null);
    try {
      show((await store.remove(id)).notes);
    } catch (e) {
      setError(els.listError, `Could not delete note: ${errorMessage(e)}`);
    }
  };

  els.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      setError(els.formError, null);
      els.addBtn.disabled = true;
      try {
        show((await store.add(els.input.value)).notes);
        els.input.value = ""; // cleared only after the note was persisted
        els.input.focus();
      } catch (e) {
        setError(els.formError, e instanceof EmptyNoteError ? "Please write something first." : `Could not save note: ${errorMessage(e)}`);
      } finally {
        els.addBtn.disabled = false;
      }
    })();
  });

  els.reloadBtn.addEventListener("click", () => void load());

  els.summarizeBtn.addEventListener("click", () => {
    void (async () => {
      els.summarizeBtn.disabled = true;
      renderSummaryLoading(els);
      try {
        // Read the current notes from Anna storage (not from a UI copy).
        const current = (await store.load()).notes;
        show(current);
        renderSummaryResult(els, await summarizeNotes(anna.tools, current));
      } catch (e) {
        renderSummaryError(els, errorMessage(e));
      } finally {
        els.summarizeBtn.disabled = notes.length === 0;
      }
    })();
  });

  controls.forEach((c) => (c.disabled = false));
  els.summarizeBtn.disabled = true;
  await load();
}

void main();
