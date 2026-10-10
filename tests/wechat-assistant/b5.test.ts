import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { resolveWorkspacePath, workspaceRead, workspaceWrite } from "../../src/wechat-assistant/workspace.ts";
import { safeMediaName, storeWechatMedia } from "../../src/wechat-assistant/media.ts";

const testDir = async (prefix: string) => {
  const root = join("data/test-runs", `${prefix}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};
test("workspace confines paths and uses compare-before-write for edits", async () => {
  const root = await testDir("wechat-ws");
  const policy = { root, maxBytes: 1024 };
  const hash = await workspaceWrite(policy, "sub/file.txt", "hello");
  assert.equal(await workspaceRead(policy, "sub/file.txt"), "hello");
  await assert.rejects(workspaceWrite(policy, "sub/file.txt", "bye", "0".repeat(64)), /conflict/);
  assert.equal((await readFile(join(root, "sub/file.txt"), "utf8")), "hello");
  await assert.rejects(resolveWorkspacePath(policy, "../escape"), /escapes/);
  assert.equal(hash.length, 64);
  for (const path of [".env", ".env.local", ".git/config", "keys/private.pem", "credentials.json", ".pi/auth.json"]) {
    await assert.rejects(workspaceWrite(policy, path, "secret"), /Sensitive/);
    await assert.rejects(workspaceRead(policy, path), /Sensitive/);
  }
  await assert.rejects(workspaceWrite(policy, "sub/oversize.txt", "x".repeat(1025)), /limit/);
  const outside = await testDir("wechat-ws-outside");
  await writeFile(join(outside, "secret.txt"), "private");
  await symlink(resolve(outside), join(root, "link"), "junction");
  await assert.rejects(workspaceRead(policy, "link/secret.txt"), /symlink/);
  await assert.rejects(workspaceWrite(policy, "link/secret.txt", "leak"), /symlink/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
});
test("media names and stored artifacts are bounded and rooted", async () => {
  const root = await testDir("wechat-media");
  assert.equal(safeMediaName("../../secret.txt"), ".._.._secret.txt");
  await assert.rejects(storeWechatMedia({ bytes: Buffer.alloc(5), root, name: "x", kind: "file", maxBytes: 4 }), /size/);
  const saved = await storeWechatMedia({ bytes: Buffer.from("safe"), root, name: "x.txt", kind: "file", maxBytes: 4 });
  assert.equal(await readFile(saved.path, "utf8"), "safe");
  const absoluteRoot = resolve(root);
  assert.ok(isAbsolute(saved.path));
  assert.ok(saved.path === absoluteRoot || saved.path.startsWith(absoluteRoot + sep));
});
