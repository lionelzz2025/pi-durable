import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { PROJECT_ROOT } from "../../src/wechat-assistant/config.ts";

test("standalone CLI selftest starts from another cwd without config, WeChat or paid model", async () => {
  const other = resolve(PROJECT_ROOT, "data/test-runs", `selftest-cwd-${randomUUID()}`); await mkdir(other, { recursive: true });
  const { stdout } = await promisify(execFile)(process.execPath,
    [resolve(PROJECT_ROOT, "src/wechat-assistant/main.ts"), "selftest"], { cwd: other, timeout: 45_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.result, "offline-pass");
  assert.equal(result.sent, 1);
  assert.ok(result.database.startsWith(resolve(PROJECT_ROOT, "data/test-runs") + "\\"));
});
