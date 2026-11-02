import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageApi } from "../src/anna/types";
import { EmptyNoteError, NotesStore, StorageCorruptError } from "../src/storage/notesStore";

/** A fake Anna storage that records every call, like the legacy in-memory runtime_state. */
function fakeStorage(initial?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  const calls: string[] = [];
  const api: StorageApi = {
    async get({ key }) {
      calls.push(`get:${key}`);
      await Promise.resolve();
      return data.has(key) ? { value: data.get(key) } : {};
    },
    async set({ key, value }) {
      calls.push(`set:${key}`);
      await new Promise((r) => setTimeout(r, 1)); // widen the race window
      data.set(key, value);
      return { ok: true };
    },
  };
  return { api, data, calls };
}

test("add persists through storage.set and assigns increasing order", async () => {
  const s = fakeStorage();
  const store = new NotesStore(s.api, "k");
  await store.add("明天跟客户 follow up");
  const st = await store.add("修复登录 bug");
  assert.deepEqual(st.notes.map((n) => [n.seq, n.text]), [[1, "明天跟客户 follow up"], [2, "修复登录 bug"]]);
  assert.ok(s.calls.includes("set:k"));
  assert.equal(typeof s.data.get("k"), "string");
});

test("empty or whitespace input is rejected and nothing is written", async () => {
  const s = fakeStorage();
  const store = new NotesStore(s.api, "k");
  await assert.rejects(store.add(""), EmptyNoteError);
  await assert.rejects(store.add("   \n"), EmptyNoteError);
  assert.equal(s.calls.length, 0);
});

test("delete updates storage and seq numbers are never reused", async () => {
  const s = fakeStorage();
  const store = new NotesStore(s.api, "k");
  await store.add("a");
  const two = await store.add("b");
  const afterDelete = await store.remove(two.notes[1]!.id);
  assert.deepEqual(afterDelete.notes.map((n) => n.text), ["a"]);
  const again = await store.add("c");
  assert.deepEqual(again.notes.map((n) => n.seq), [1, 3]);
  const persisted = JSON.parse(s.data.get("k") as string);
  assert.equal(persisted.notes.length, 2);
});

test("load reads back from storage, not from a local copy", async () => {
  const s = fakeStorage();
  await new NotesStore(s.api, "k").add("hello");
  const fresh = new NotesStore(s.api, "k"); // new instance, no memory
  assert.deepEqual((await fresh.load()).notes.map((n) => n.text), ["hello"]);
  assert.ok(s.calls.filter((c) => c === "get:k").length >= 1);
});

test("concurrent adds do not lose notes", async () => {
  const s = fakeStorage();
  const store = new NotesStore(s.api, "k");
  await Promise.all(["1", "2", "3", "4", "5"].map((t) => store.add(t)));
  const st = await store.load();
  assert.deepEqual(st.notes.map((n) => n.text), ["1", "2", "3", "4", "5"]);
});

test("corrupt stored data is reported and never overwritten", async () => {
  const s = fakeStorage({ k: "{not json" });
  const store = new NotesStore(s.api, "k");
  await assert.rejects(store.load(), StorageCorruptError);
  await assert.rejects(store.add("x"), StorageCorruptError);
  assert.equal(s.data.get("k"), "{not json");
  assert.ok(!s.calls.includes("set:k"));
});

test("a failing storage.set surfaces and a later call still works", async () => {
  let fail = true;
  const s = fakeStorage();
  const api: StorageApi = { get: s.api.get, set: async (a) => (fail ? Promise.reject(new Error("denied")) : s.api.set(a)) };
  const store = new NotesStore(api, "k");
  await assert.rejects(store.add("x"), /denied/);
  fail = false;
  assert.equal((await store.add("y")).notes.length, 1);
});
