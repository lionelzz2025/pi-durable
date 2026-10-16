import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Cursor, type Harness } from "@earendil-works/pi-durable";
import { openAssistantStore } from "../assistant/storage.ts";
import { ASSISTANT_RECEIPT_KIND, ASSISTANT_TODO_KIND, ReceiptDoc, TodoDoc,
  type ReceiptRecord, type TodoRecord } from "../assistant/store.ts";
import { TodoIndex, TODO_INDEX_CAP } from "./tools/todo.ts";

export const LegacyMigration = defineDoc<{
  schemaVersion: number; sourceHash: string; todoCount: number; receiptCount: number;
}>({ kind: "wechat.legacy-migration", version: 1, scope: "session", initial: () => ({
  schemaVersion: 1, sourceHash: "", todoCount: 0, receiptCount: 0,
}) });

export type LegacyExport = { todos: TodoRecord[]; receipts: ReceiptRecord[]; sourceHash: string };

/** Read only a stopped legacy service. Source and destination must be different
 * SQLite files; the old store remains untouched. The exclusive open rejects a
 * still-running legacy owner instead of taking an inconsistent live snapshot. */
export const exportLegacyTodos = async (sourcePath: string): Promise<LegacyExport> => {
  const store = await openAssistantStore(sourcePath);
  try {
    const todos: TodoRecord[] = [];
    const receipts: ReceiptRecord[] = [];
    for (const [kind, family, output] of [
      [ASSISTANT_TODO_KIND, TodoDoc, todos],
      [ASSISTANT_RECEIPT_KIND, ReceiptDoc, receipts],
    ] as const) {
      let cursor: Cursor | undefined;
      do {
        const page = await store.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 100, cursor, BACKGROUND_CONTEXT);
        for (const record of page.items) {
          if (record.key === undefined) throw Error("Legacy family member lacks a key");
          const value = family === TodoDoc
            ? await store.session.snapshot(TodoDoc, record.key, BACKGROUND_CONTEXT)
            : await store.session.snapshot(ReceiptDoc, record.key, BACKGROUND_CONTEXT);
          if (!value) throw Error("Legacy document vanished during export");
          (output as (TodoRecord | ReceiptRecord)[]).push({ ...value });
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    if (todos.length > TODO_INDEX_CAP) throw Error("Legacy todo count exceeds destination capacity");
    const ids = new Set(todos.map((todo) => todo.id));
    if (ids.size !== todos.length || receipts.some((receipt) => !ids.has(receipt.todo.id))) {
      throw Error("Legacy todo/receipt integrity mismatch");
    }
    const sourceHash = createHash("sha256").update(JSON.stringify({ todos, receipts })).digest("hex");
    return { todos, receipts, sourceHash };
  } finally { await store.close(); }
};

/** One transaction owns marker, index, todos and receipts. A crash either leaves
 * none or all. A repeated import with the same fingerprint is a no-op. */
export const importLegacyTodos = async (harness: Harness, source: LegacyExport): Promise<"imported" | "already_imported"> => {
  if (source.todos.length > TODO_INDEX_CAP) throw Error("Legacy todo count exceeds destination capacity");
  const hash = createHash("sha256").update(JSON.stringify({ todos: source.todos, receipts: source.receipts })).digest("hex");
  if (hash !== source.sourceHash) throw Error("Legacy export hash mismatch");
  return harness.commit(async (tx) => {
    const marker = await tx.doc(LegacyMigration);
    if (marker.sourceHash) {
      if (marker.sourceHash !== hash || marker.todoCount !== source.todos.length || marker.receiptCount !== source.receipts.length) {
        throw Error("Different legacy data was already imported");
      }
      return "already_imported" as const;
    }
    const index = await tx.doc(TodoIndex);
    if (index.ids.length) throw Error("Destination has existing todos; refusing merge");
    const ids = new Set<string>();
    for (const todo of source.todos) {
      if (ids.has(todo.id)) throw Error("Duplicate legacy todo ID");
      ids.add(todo.id);
      const stored = await tx.doc(TodoDoc, todo.id, { id: todo.id, title: todo.title, createdAt: todo.createdAt });
      if (stored.id !== todo.id || stored.title !== todo.title || stored.createdAt !== todo.createdAt || stored.status !== "open") {
        throw Error("Destination todo already exists");
      }
      stored.status = todo.status;
      stored.completedAt = todo.completedAt;
      index.ids.push(todo.id);
    }
    const operations = new Set<string>();
    for (const receipt of source.receipts) {
      if (operations.has(receipt.operationId) || !ids.has(receipt.todo.id)) throw Error("Invalid legacy receipt");
      operations.add(receipt.operationId);
      const stored = await tx.doc(ReceiptDoc, receipt.operationId, receipt);
      if (stored.operationId !== receipt.operationId || stored.fingerprint !== receipt.fingerprint ||
        stored.requestKind !== receipt.requestKind || JSON.stringify(stored.todo) !== JSON.stringify(receipt.todo)) {
        throw Error("Destination receipt already exists");
      }
    }
    marker.sourceHash = hash;
    marker.todoCount = source.todos.length;
    marker.receiptCount = source.receipts.length;
    return "imported" as const;
  }, BACKGROUND_CONTEXT);
};

export const requireSeparateMigrationPaths = (sourcePath: string, destinationPath: string): void => {
  if (resolve(sourcePath).toLowerCase() === resolve(destinationPath).toLowerCase()) throw Error("Source and destination databases must differ");
};
