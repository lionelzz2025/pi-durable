import type { Harness } from "@earendil-works/pi-durable";
import { dispatchDueReminders, reconcileReminders } from "./reminders.ts";

/** Periodic local scan, independent of incoming messages. The durable occurrence
 * and outbox records remain the source of truth across shutdown and restart. */
export const runReminderScheduler = async (
  harness: Harness,
  signal: AbortSignal,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): Promise<void> => {
  const intervalMs = options.intervalMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw Error("Invalid reminder scan interval");
  while (!signal.aborted) {
    try {
      await dispatchDueReminders(harness, {});
      await reconcileReminders(harness);
    } catch (error) {
      options.onError?.(error);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, intervalMs);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
};
