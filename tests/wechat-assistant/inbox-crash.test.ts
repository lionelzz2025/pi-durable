import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
const start = (db: string, mode: string) => {
  const child = spawn(process.execPath, [resolve("tests/wechat-assistant/fixtures/inbox-child.ts"), db, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
  const event = (name: string): Promise<Record<string, unknown>> => new Promise((done, reject) => {
    const finish = () => {
      const line = output.split("\n").find((line) => line.includes(`"event":"${name}"`));
      if (line) { cleanup(); done(JSON.parse(line)); }
      else if (child.exitCode !== null || child.signalCode !== null) { cleanup(); reject(Error(`Fixture exited: ${errors}`)); }
    };
    const timer = setTimeout(() => { cleanup(); reject(Error(`Fixture timeout: ${errors}`)); }, 20000);
    const cleanup = () => { clearTimeout(timer); child.stdout.off("data", finish); child.off("exit", finish); };
    child.stdout.on("data", finish); child.on("exit", finish); finish();
  });
  return { event, exited, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
};
for (const mode of ["after-inbox", "after-submit"]) test(`B2 hard kill ${mode} recovers without user resend or duplicate input`, { timeout: 60000 }, async () => {
  const dir = resolve("data/test-runs", `inbox-crash-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const first = start(db, mode);
  let id: unknown;
  try { id = (await first.event("kill-window")).conversationId; } finally { await first.stop(); }
  for (let pass = 0; pass < 2; pass++) {
    const recovered = start(db, "recover");
    try {
      const result = await recovered.event("recovered");
      assert.equal(await recovered.exited, 0);
      assert.equal(result.conversationId, id); assert.equal(result.users, 1);
      const state = result.state as { cursor: string; inbox: Array<{ status: string }> };
      assert.equal(state.cursor, "committed-cursor"); assert.equal(state.inbox[0]?.status, "settled");
    } finally { await recovered.stop(); }
  }
});
