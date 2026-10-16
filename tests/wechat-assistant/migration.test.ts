import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { openAssistantStore } from "../../src/assistant/storage.ts";
import { createTodoService, ReceiptDoc, TodoDoc } from "../../src/assistant/store.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { exportLegacyTodos, importLegacyTodos, LegacyMigration, requireSeparateMigrationPaths } from "../../src/wechat-assistant/migration.ts";
import { runWechatCli } from "../../src/wechat-assistant/main.ts";
import { writeFile } from "node:fs/promises";
import { TodoIndex } from "../../src/wechat-assistant/tools/todo.ts";

const context = BACKGROUND_CONTEXT;
test("stopped legacy source imports todos and operation receipts once without changing the source", async () => {
  const dir = resolve("data/test-runs", `migration-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const oldDb = resolve(dir, "old.sqlite"), newDb = resolve(dir, "new.sqlite");
  const old = await openAssistantStore(oldDb);
  let id: string;
  try {
    const service = createTodoService(old);
    const created = await service.createTodo({ operationId: "legacy-create", title: "buy tea" });
    id = created.id;
    await service.completeTodo({ operationId: "legacy-complete", id });
    await assert.rejects(exportLegacyTodos(oldDb), /already in use/);
  } finally { await old.close(); }
  requireSeparateMigrationPaths(oldDb, newDb);
  assert.throws(() => requireSeparateMigrationPaths(oldDb, oldDb), /differ/);
  const exported = await exportLegacyTodos(oldDb);
  assert.equal(exported.todos.length, 1); assert.equal(exported.receipts.length, 2);
  const harness = await openWechatHarness(newDb, { models: createModels(), registry: createRegistry() });
  try {
    assert.equal(await importLegacyTodos(harness, exported), "imported");
    assert.equal(await importLegacyTodos(harness, exported), "already_imported");
    assert.deepEqual((await harness.snapshot(TodoIndex, context))?.ids, [id!]);
    assert.equal((await harness.snapshot(TodoDoc, id!, context))?.status, "done");
    assert.equal((await harness.snapshot(ReceiptDoc, "legacy-create", context))?.todo.id, id!);
    assert.equal((await harness.snapshot(ReceiptDoc, "legacy-complete", context))?.todo.status, "done");
    assert.deepEqual(await harness.snapshot(LegacyMigration, context), { schemaVersion: 1, sourceHash: exported.sourceHash, todoCount: 1, receiptCount: 2 });
    await assert.rejects(importLegacyTodos(harness, { ...exported, sourceHash: "bad" }), /hash mismatch/);
    await assert.rejects(importLegacyTodos(harness, { ...exported, todos: [] }), /hash mismatch/);
  } finally { await harness.close(context); }
  assert.deepEqual(await exportLegacyTodos(oldDb), exported, "legacy DB remains unchanged");
});

test("offline CLI requires explicit approval, preserves a backup and repeats without duplicate import", async () => {
  const dir = resolve("data/test-runs", `migration-cli-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const oldDb = resolve(dir, "old.sqlite"), newDb = resolve(dir, "new", "assistant.sqlite"), backupDb = resolve(dir, "old-backup.sqlite");
  const old = await openAssistantStore(oldDb);
  try { await createTodoService(old).createTodo({ operationId: "cli-op", title: "legacy" }); }
  finally { await old.close(); }
  const config = resolve(dir, "config.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, dataDir: "new", workspaceDir: "workspace", accountId: "bot", boundUserId: "user", model: { provider: "faux", modelId: "faux-1" } }));
  await assert.rejects(runWechatCli(["migrate", "--config", config, "--source", oldDb, "--destination", backupDb]), /allow-migration/);
  await runWechatCli(["migrate", "--config", config, "--source", oldDb, "--destination", backupDb, "--allow-migration"]);
  assert.equal((await exportLegacyTodos(backupDb)).receipts.length, 1);
  const harness = await openWechatHarness(newDb, { models: createModels(), registry: createRegistry() });
  try { assert.equal((await harness.snapshot(TodoIndex, context))?.ids.length, 1); }
  finally { await harness.close(context); }
  // A second import from the existing backup is still idempotent via the marker.
  const exported = await exportLegacyTodos(backupDb);
  const reopened = await openWechatHarness(newDb, { models: createModels(), registry: createRegistry() });
  try { assert.equal(await importLegacyTodos(reopened, exported), "already_imported"); }
  finally { await reopened.close(context); }
});

test("failed migration transaction leaves no marker, index or partial documents", async () => {
  const dir = resolve("data/test-runs", `migration-rollback-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const oldDb = resolve(dir, "old.sqlite"), newDb = resolve(dir, "new.sqlite");
  const old = await openAssistantStore(oldDb);
  try { await createTodoService(old).createTodo({ operationId: "op", title: "one" }); }
  finally { await old.close(); }
  const exported = await exportLegacyTodos(oldDb);
  const harness = await openWechatHarness(newDb, { models: createModels(), registry: createRegistry() });
  try {
    const tampered = { ...exported, receipts: [...exported.receipts, { ...exported.receipts[0]!, operationId: "duplicate", todo: { ...exported.receipts[0]!.todo, id: randomUUID() } }] };
    const { createHash } = await import("node:crypto");
    tampered.sourceHash = createHash("sha256").update(JSON.stringify({ todos: tampered.todos, receipts: tampered.receipts })).digest("hex");
    await assert.rejects(importLegacyTodos(harness, tampered), /Invalid legacy receipt/);
    assert.equal((await harness.snapshot(LegacyMigration, context))?.sourceHash ?? "", "");
    assert.deepEqual((await harness.snapshot(TodoIndex, context))?.ids ?? [], []);
    assert.equal(await harness.snapshot(TodoDoc, exported.todos[0]!.id, context), undefined);
    assert.equal(await importLegacyTodos(harness, exported), "imported");
  } finally { await harness.close(context); }
});
