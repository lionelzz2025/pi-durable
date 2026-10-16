import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { abortExpiredRuns } from "../../src/wechat-assistant/run-deadlines.ts";

test("pump deadline marks only expired admitted generation tasks, including recovered ones", async () => {
  const aborted: TaskId[] = [];
  const fake = {
    inspect: async () => ({ tasks: [
      { record: { id: 1, kind: "pi.generation", startedAt: 100 } },
      { record: { id: 2, kind: "pi.generation", startedAt: 650 } },
      { record: { id: 3, kind: "pi.tool", startedAt: 100 } },
      { record: { id: 4, kind: "pi.generation", abortRequested: true, startedAt: 100 } },
    ] }),
    snapshot: async (_token: unknown, id: number) => id === 1 ? { startedAt: 100 } : id === 2 ? { startedAt: 650 } : undefined,
    abortTask: async (id: TaskId) => { aborted.push(id); return "marked"; },
  } as unknown as Harness;
  assert.equal(await abortExpiredRuns(fake, 500, 700), 1);
  assert.deepEqual(aborted, [1]);
  await assert.rejects(abortExpiredRuns(fake, 0), /Invalid run timeout/);
});
