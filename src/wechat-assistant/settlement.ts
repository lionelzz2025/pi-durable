import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";

/** Reconstruct local state from committed receipts, never from provider text.
 * Answer/outbox creation remains B4; settled does not mean delivered. */
export const reconcileInbox = async (harness: Harness): Promise<void> => {
  const state = await harness.snapshot(ChannelState, context);
  for (const record of state?.inbox ?? []) {
    if (record.status !== "submitted" || record.submissionId === null) continue;
    const submission = await harness.submission(record.submissionId, context);
    if (!submission) throw Error("Inbox submission receipt missing");
    const receipt = await submission.status(context);
    if (receipt.status !== "done" && receipt.status !== "unanswered") continue;
    await harness.commit(async (tx) => {
      const target = (await tx.doc(ChannelState)).inbox.find((item) => item.key === record.key);
      if (target?.submissionId === record.submissionId) target.status = "settled";
    }, context);
  }
};
