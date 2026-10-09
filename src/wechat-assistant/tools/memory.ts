// Durable memory tools. Each mutation is one commit over the single memory
// document; `memory_add` is idempotent on `operationId` so a replay after recovery
// cannot duplicate a fact. Correct/forget are naturally idempotent setters.
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { normalizeOperationId } from "../../assistant/store.ts";
import {
  MEMORY_LIMITS,
  MemoryStore,
  normalizeMemoryContent,
  normalizeMemoryId,
  normalizeMemorySource,
  normalizeSearchLimit,
  normalizeSearchQuery,
  searchMemories,
  type MemoryRecord,
} from "../memory.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const nowIso = () => new Date().toISOString();

type AddArgs = { content?: unknown; source?: unknown; operationId?: unknown };
type SearchArgs = { query?: unknown; limit?: unknown };
type CorrectArgs = { id?: unknown; content?: unknown };
type ForgetArgs = { id?: unknown };

export const memoryAdd = defineTool({
  name: "memory_add",
  description: "Store a durable fact about the user. Safe to retry: one operationId stores one memory.",
  parameters: Type.Object({
    content: Type.String({ description: "The fact to remember", maxLength: MEMORY_LIMITS.maxContentChars }),
    source: Type.Optional(Type.String({ description: "Provenance label", maxLength: MEMORY_LIMITS.maxSourceChars })),
    operationId: Type.Optional(Type.String({ description: "Idempotency key; defaults to the tool call id" })),
  }),
  replay: "safe",
  executionMode: "sequential",
  execute: async (args, api, context) => {
    const typed = args as AddArgs;
    const operationId = normalizeOperationId(typed.operationId ?? api.callId);
    const content = normalizeMemoryContent(typed.content);
    const source = normalizeMemorySource(typed.source);
    const record = await api.commit(async (tx) => {
      const store = await tx.doc(MemoryStore);
      const existing = store.entries.find((entry) => entry.operationId === operationId);
      if (existing) {
        if (existing.content !== content) throw new Error("operationId already stored a different memory");
        return { ...existing };
      }
      if (store.entries.length >= MEMORY_LIMITS.maxEntries) throw new Error("Memory capacity reached");
      const created: MemoryRecord = {
        id: randomUUID(),
        content,
        source,
        operationId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        active: true,
      };
      store.entries.push(created);
      return { ...created };
    }, context);
    return text(JSON.stringify(record));
  },
});

export const memorySearch = defineTool({
  name: "memory_search",
  description: "Search durable memories. Omit query to list the most recently updated.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Case-insensitive substring match", maxLength: MEMORY_LIMITS.searchQueryMaxChars })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MEMORY_LIMITS.maxEntries })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const typed = args as SearchArgs;
    const query = normalizeSearchQuery(typed.query);
    const limit = normalizeSearchLimit(typed.limit);
    const store = await api.snapshot(MemoryStore, context);
    const items = searchMemories(store?.entries ?? [], query, limit);
    return text(JSON.stringify({ items }));
  },
});

export const memoryCorrect = defineTool({
  name: "memory_correct",
  description: "Replace the content of an existing memory.",
  parameters: Type.Object({
    id: Type.String({ description: "Memory UUID" }),
    content: Type.String({ description: "Corrected fact", maxLength: MEMORY_LIMITS.maxContentChars }),
  }),
  replay: "safe",
  executionMode: "sequential",
  execute: async (args, api, context) => {
    const typed = args as CorrectArgs;
    const id = normalizeMemoryId(typed.id);
    const content = normalizeMemoryContent(typed.content);
    const record = await api.commit(async (tx) => {
      const store = await tx.doc(MemoryStore);
      const entry = store.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`no memory with id ${id}`);
      if (!entry.active) throw new Error("memory has been forgotten; add a new one instead");
      entry.content = content;
      entry.updatedAt = nowIso();
      return { ...entry };
    }, context);
    return text(JSON.stringify(record));
  },
});

export const memoryForget = defineTool({
  name: "memory_forget",
  description: "Forget a memory. The record is kept inactive for audit and is no longer surfaced.",
  parameters: Type.Object({ id: Type.String({ description: "Memory UUID" }) }),
  replay: "safe",
  executionMode: "sequential",
  execute: async (args, api, context) => {
    const id = normalizeMemoryId((args as ForgetArgs).id);
    const record = await api.commit(async (tx) => {
      const store = await tx.doc(MemoryStore);
      const entry = store.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`no memory with id ${id}`);
      if (entry.active) {
        entry.active = false;
        entry.updatedAt = nowIso();
      }
      return { ...entry };
    }, context);
    return text(JSON.stringify(record));
  },
});

export const memoryTools = [memoryAdd, memorySearch, memoryCorrect, memoryForget];
