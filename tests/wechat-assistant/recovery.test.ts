import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { AssistantDatabaseBusyError } from "../../src/assistant/storage.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";

type Event = { event: string; conversationId: string; submissionId: string; result: { status: string; answer?: unknown }; entries: Array<{ kind: string; data: unknown }>; effects: string[]; provider: unknown };
const start = (db: string, mode: string, marker: string) => {
  const child = spawn(process.execPath, [resolve("tests/wechat-assistant/fixtures/recovery-child.ts"), db, mode, marker], { stdio: ["ignore", "pipe", "pipe"] });
  const events: Event[] = [];
  let output = "", errors = "";
  const waiters = new Set<() => void>();
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      try { events.push(JSON.parse(line)); } catch { /* non-JSON diagnostic */ }
    }
    for (const notify of waiters) notify();
  });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { done(code); for (const notify of waiters) notify(); });
  });
  const wait = (name: string): Promise<Event> => new Promise((done, reject) => {
    const timer = setTimeout(() => finish(new Error(`timeout ${name}: ${errors}`)), 20_000);
    const finish = (error?: Error, event?: Event) => {
      clearTimeout(timer); waiters.delete(check);
      if (error) reject(error); else done(event!);
    };
    const check = () => {
      const found = events.find((item) => item.event === name);
      if (found) finish(undefined, found);
      else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`child exited before ${name}: ${errors}`));
    };
    waiters.add(check); check();
  });
  return { wait, exited, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
};
const paths = async () => {
  const dir = resolve("data/test-runs", `wechat-b0-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return { db: resolve(dir, "assistant.sqlite"), marker: resolve(dir, "effect.txt") };
};

for (const mode of ["crash-model", "crash-safe", "crash-unsafe"]) {
  test(`B0 ${mode}: hard kill then resume without duplicate input/effect`, { timeout: 60_000 }, async () => {
    const { db, marker } = await paths();
    const crashed = start(db, mode, marker);
    let admitted: Event;
    try {
      admitted = await crashed.wait("admitted");
      await crashed.wait(mode === "crash-model" ? "model-started" : "effect-committed");
    } finally { await crashed.stop(); }
    const recovered = start(db, mode === "crash-unsafe" ? "recover-unsafe" : "recover", marker);
    let settled: Event;
    try {
      settled = await recovered.wait("settled");
      assert.equal(await recovered.exited, 0);
    } finally { await recovered.stop(); }
    assert.equal(settled.conversationId, admitted.conversationId);
    assert.equal(settled.submissionId, admitted.submissionId);
    assert.equal(settled.result.status, "done");
    assert.equal(settled.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    if (mode === "crash-safe") assert.equal(settled.effects.length, 1);
    if (mode === "crash-unsafe") {
      assert.equal(await readFile(marker, "utf8"), "external-effect\n");
      assert.match(JSON.stringify(settled.entries), /interrupted/i);
    }
    const again = start(db, "recover", marker);
    try {
      const reopened = await again.wait("settled");
      assert.equal(await again.exited, 0);
      assert.equal(reopened.submissionId, settled.submissionId);
      assert.deepEqual(reopened.provider, settled.provider);
      assert.deepEqual(reopened.entries, settled.entries, "committed answer available on reopen without new generation");
    } finally { await again.stop(); }
  });
}

test("B0 Harness exclusive storage refuses a second owner and releases after hard kill", { timeout: 40_000 }, async () => {
  const { db, marker } = await paths();
  const holder = start(db, "hold", marker);
  const models = createModels(); models.setProvider(fauxProvider().provider);
  try {
    await holder.wait("holding");
    await assert.rejects(openWechatHarness(db, { models, registry: createRegistry() }), AssistantDatabaseBusyError);
  } finally { await holder.stop(); }
  const harness = await openWechatHarness(db, { models, registry: createRegistry() });
  await harness.close(BACKGROUND_CONTEXT);
});
