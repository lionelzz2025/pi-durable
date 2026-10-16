import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { RunAdmission } from "./run-admission.ts";

/** Called by the single-owner pump. Marks expired durable generation tasks for
 * abort, including after restart. Provider/tool cancellation is cooperative;
 * an uncooperative external process is not a hard sandbox or deadline. */
export const abortExpiredRuns = async (harness: Harness, runTimeoutMs: number, now = Date.now()): Promise<number> => {
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 1) throw Error("Invalid run timeout");
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  let aborted = 0;
  for (const { record } of inspection.tasks) {
    if (record.kind !== "pi.generation" || record.abortRequested) continue;
    const admission = await harness.snapshot(RunAdmission, record.id, BACKGROUND_CONTEXT);
    const startedAt = record.startedAt ?? admission?.startedAt;
    if (startedAt && now - startedAt >= runTimeoutMs) {
      if (await harness.abortTask(record.id, BACKGROUND_CONTEXT) === "marked") aborted++;
    }
  }
  return aborted;
};
