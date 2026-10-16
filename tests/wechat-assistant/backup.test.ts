import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createTodoService } from "../../src/assistant/store.ts";
import { openAssistantStore } from "../../src/assistant/storage.ts";
import { backupStoppedDatabase, restoreDatabaseToNewPath } from "../../src/wechat-assistant/backup.ts";
import { exportLegacyTodos } from "../../src/wechat-assistant/migration.ts";

test("stopped SQLite WAL source has consistent backup and a separate restorable copy", async () => {
  const dir = resolve("data/test-runs", `backup-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const source = resolve(dir, "source.sqlite"), copy = resolve(dir, "copy.sqlite"), restored = resolve(dir, "restored.sqlite");
  const owner = await openAssistantStore(source);
  try {
    const service = createTodoService(owner);
    await service.createTodo({ operationId: "create", title: "offline" });
    await assert.rejects(backupStoppedDatabase(source, copy), /locked|busy/i);
  } finally { await owner.close(); }
  const before = await exportLegacyTodos(source);
  await backupStoppedDatabase(source, copy);
  assert.deepEqual(await exportLegacyTodos(copy), before);
  await assert.rejects(backupStoppedDatabase(source, copy), /EEXIST/);
  await restoreDatabaseToNewPath(copy, restored);
  assert.deepEqual(await exportLegacyTodos(restored), before);
  const damaged = resolve(dir, "damaged.sqlite"), refused = resolve(dir, "refused.sqlite");
  await writeFile(damaged, "not a database");
  await assert.rejects(restoreDatabaseToNewPath(damaged, refused));
  await assert.rejects(readFile(refused), /ENOENT/);
  assert.deepEqual(await exportLegacyTodos(copy), before);
});
