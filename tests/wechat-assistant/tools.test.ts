import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { PromptInput, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { openAssistantStore, type AssistantStore } from "../../src/assistant/storage.ts";
import { memorySection } from "../../src/wechat-assistant/memory-prompt.ts";
import { MemoryStore, renderMemoryPrompt, type MemoryRecord } from "../../src/wechat-assistant/memory.ts";
import { memoryAdd, memoryCorrect, memoryForget, memorySearch } from "../../src/wechat-assistant/tools/memory.ts";
import { todoComplete, todoCreate, todoGet, todoList } from "../../src/wechat-assistant/tools/todo.ts";

const open = async (): Promise<AssistantStore> => {
  const dir = resolve("data/test-runs", `tools-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return openAssistantStore(resolve(dir, "assistant.sqlite"));
};

/** The tools touch only these api members; the cast keeps unused surface out of the test.
 * Reads (`snapshot`) and `commit` are the real Session, so document semantics are real. */
const apiFor = (store: AssistantStore, callId: string): ToolExecutionApi =>
  ({ callId, commit: (change: never, ctx: never) => store.session.commit(change, ctx), snapshot: (token: never, ctx: never) => store.session.snapshot(token, ctx) }) as unknown as ToolExecutionApi;

const invoke = async (tool: ToolRegistration, store: AssistantStore, callId: string, args: object): Promise<unknown> => {
  const result = await tool.execute(args as never, apiFor(store, callId), context);
  const block = result.content?.[0];
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("expected a text tool result");
  return JSON.parse(block.text) as unknown;
};

test("todo tools create/list/get/complete with replay-safe idempotency", async () => {
  const store = await open();
  try {
    const created = (await invoke(todoCreate, store, "call-1", { title: "  buy milk " })) as { id: string; title: string; status: string };
    assert.equal(created.title, "buy milk");
    assert.equal(created.status, "open");
    const replay = (await invoke(todoCreate, store, "call-1", { title: "buy milk" })) as { id: string };
    assert.equal(replay.id, created.id, "same callId must not create a second todo");
    await assert.rejects(invoke(todoCreate, store, "call-1", { title: "something else" }), /different request/);
    const opened = (await invoke(todoList, store, "call-2", {})) as { items: Array<{ id: string }> };
    assert.equal(opened.items.length, 1);
    assert.equal(opened.items[0]?.id, created.id);
    const done = (await invoke(todoComplete, store, "call-3", { id: created.id })) as { status: string; completedAt: string };
    assert.equal(done.status, "done");
    assert.ok(done.completedAt);
    const doneReplay = (await invoke(todoComplete, store, "call-3", { id: created.id })) as { status: string };
    assert.equal(doneReplay.status, "done");
    assert.equal(((await invoke(todoList, store, "call-4", { status: "open" })) as { items: unknown[] }).items.length, 0);
    assert.equal(((await invoke(todoList, store, "call-5", { status: "all" })) as { items: unknown[] }).items.length, 1);
    await assert.rejects(invoke(todoGet, store, "call-6", { id: randomUUID() }), /no todo/);
  } finally {
    await store.close();
  }
});

test("todo_list paginates in creation order without skipping or duplicating", async () => {
  const store = await open();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(((await invoke(todoCreate, store, `create-${index}`, { title: `todo ${index}` })) as { id: string }).id);
    }
    const first = (await invoke(todoList, store, "page-1", { limit: 2 })) as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
    assert.ok(first.nextCursor);
    const second = (await invoke(todoList, store, "page-2", { limit: 2, cursor: first.nextCursor! })) as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.deepEqual(second.items.map((item) => item.id), ids.slice(2, 4));
    const third = (await invoke(todoList, store, "page-3", { limit: 2, cursor: second.nextCursor! })) as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.deepEqual(third.items.map((item) => item.id), ids.slice(4));
    assert.equal(third.nextCursor, null);
  } finally {
    await store.close();
  }
});

test("memory add/search/correct/forget is idempotent and excludes forgotten facts", async () => {
  const store = await open();
  try {
    const first = (await invoke(memoryAdd, store, "mem-1", { content: "prefers tea", source: "chat" })) as { id: string };
    const replay = (await invoke(memoryAdd, store, "mem-1", { content: "prefers tea", source: "chat" })) as { id: string };
    assert.equal(replay.id, first.id);
    await assert.rejects(invoke(memoryAdd, store, "mem-1", { content: "prefers coffee" }), /different memory/);
    await invoke(memoryAdd, store, "mem-2", { content: "works in Shanghai" });
    const search = (await invoke(memorySearch, store, "mem-3", { query: "tea" })) as { items: Array<{ id: string }> };
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.id, first.id);
    const corrected = (await invoke(memoryCorrect, store, "mem-4", { id: first.id, content: "prefers green tea" })) as { content: string };
    assert.equal(corrected.content, "prefers green tea");
    await invoke(memoryForget, store, "mem-5", { id: first.id });
    assert.equal(((await invoke(memorySearch, store, "mem-6", { query: "tea" })) as { items: unknown[] }).items.length, 0);
    await assert.rejects(invoke(memoryCorrect, store, "mem-7", { id: first.id, content: "again" }), /forgotten/);
    await assert.rejects(invoke(memoryForget, store, "mem-8", { id: randomUUID() }), /no memory/);
  } finally {
    await store.close();
  }
});

test("memory prompt section injects active facts within the byte budget and survives reopen", async () => {
  const store = await open();
  try {
    await invoke(memoryAdd, store, "s-1", { content: "likes concise answers", source: "chat" });
    await invoke(memoryAdd, store, "s-2", { content: "timezone UTC+8" });
    const section = memorySection(4096);
    const rendered = await section.render({ read: store.session } as unknown as PromptInput, context);
    assert.ok(rendered?.includes("likes concise answers"));
    assert.ok(rendered?.includes("timezone UTC+8"));
    assert.ok(Buffer.byteLength(rendered!, "utf8") <= 4096);
    const tiny = await memorySection(100).render({ read: store.session } as unknown as PromptInput, context);
    assert.equal(tiny, undefined, "a budget too small for one entry injects nothing rather than a fragment");
  } finally {
    await store.close();
  }
  const reopened = await openAssistantStore(store.databasePath);
  try {
    assert.equal((await reopened.session.snapshot(MemoryStore, context))?.entries.length, 2);
  } finally {
    await reopened.close();
  }
});

test("a created todo and its receipt survive reopen; replay returns the same id", async () => {
  const store = await open();
  let id: string;
  try {
    id = ((await invoke(todoCreate, store, "persist-1", { title: "keep me" })) as { id: string }).id;
  } finally {
    await store.close();
  }
  const reopened = await openAssistantStore(store.databasePath);
  try {
    const replay = (await invoke(todoCreate, reopened, "persist-1", { title: "keep me" })) as { id: string };
    assert.equal(replay.id, id, "a persisted receipt replays after restart instead of creating a new todo");
    assert.equal(((await invoke(todoList, reopened, "persist-2", {})) as { items: unknown[] }).items.length, 1);
  } finally {
    await reopened.close();
  }
});

test("memory prompt injection degrades by omission, never mid-entry, at the budget", () => {
  const entries: MemoryRecord[] = Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    content: `fact number ${index} `.repeat(8).trim(),
    source: "chat",
    operationId: `op-${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:0${index}.000Z`,
    active: true,
  }));
  const rendered = renderMemoryPrompt(entries, 800);
  assert.ok(rendered);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 800);
  assert.ok(rendered.includes("另有"), "an over-budget set notes the omitted count");
  for (const line of rendered.split("\n").filter((entry) => entry.startsWith("- "))) {
    assert.ok(entries.some((entry) => line.includes(entry.content)), "every injected line is a complete stored fact");
  }
  assert.equal(renderMemoryPrompt([], 800), undefined);
});
