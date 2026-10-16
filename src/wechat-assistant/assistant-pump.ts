import { setTimeout as delay } from "node:timers/promises";
import type { Harness } from "@earendil-works/pi-durable";
import type { WechatCdn } from "./channel/cdn.ts";
import { submitReceivedInbox } from "./conversations.ts";
import { reconcileInbox } from "./settlement.ts";
import { enqueueAnswers, drainOutbox, type OutboxSender } from "./outbox.ts";
import { dispatchDueReminders, reconcileReminders } from "./reminders.ts";
import { drainMediaOutbox } from "./media-outbox.ts";
import type { WechatApi } from "./channel/api.ts";
import type { WorkspacePolicy } from "./workspace.ts";
import { abortExpiredRuns } from "./run-deadlines.ts";

/** One owner drives recovery even while WeChat has no incoming messages.
 * Poll admission is independent; its durable cursor is never advanced here.
 * A failed round must be reported, not silently treated as delivered. */
export const runAssistantPump = async (harness: Harness, options: {
  recipient: string;
  signal: AbortSignal;
  sender: OutboxSender;
  media?: { root: string; maxBytes: number; cdn: WechatCdn };
  mediaSender?: { policy: WorkspacePolicy; api: WechatApi; cdn: WechatCdn; token: string };
  intervalMs?: number;
  runTimeoutMs?: number;
  onError?: (error: unknown) => void;
}): Promise<void> => {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw Error("Invalid assistant pump interval");
  while (!options.signal.aborted) {
    try {
      if (options.runTimeoutMs !== undefined) await abortExpiredRuns(harness, options.runTimeoutMs);
      await submitReceivedInbox(harness, options.media && { ...options.media, signal: options.signal });
      await reconcileInbox(harness);
      await enqueueAnswers(harness, { recipient: options.recipient });
      await dispatchDueReminders(harness, {});
      await drainOutbox(harness, options.sender, { recipient: options.recipient });
      if (options.mediaSender) await drainMediaOutbox(harness, { ...options.mediaSender, signal: options.signal });
      await reconcileReminders(harness);
    } catch (error) {
      if (options.signal.aborted) break;
      if (!options.onError) throw error;
      options.onError(error);
    }
    if (options.signal.aborted) break;
    try { await delay(intervalMs, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
};
