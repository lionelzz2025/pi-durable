import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";
import { isBoundSender, validateCredentials } from "./channel/identity.ts";
import type { Credentials, GetUpdatesResp } from "./channel/types.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class InboxCapacityError extends Error {}

/** Whole batch, cursor and context are committed together; rejection log bounded
 * separately from dedup receipts (never silently clear the latter).
 */
export const admitWechatBatch = async (harness: Harness, input: {
  credentials: Credentials; batch: GetUpdatesResp; messageBytes: number;
  pendingLimit: number; receiptLimit: number; now?: number;
}): Promise<void> => {
  const credentials = validateCredentials(input.credentials);
  for (const limit of [input.messageBytes, input.pendingLimit, input.receiptLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid inbox limits");
  }
  if (!Array.isArray(input.batch.msgs) || typeof input.batch.get_updates_buf !== "string" || input.batch.ret !== 0) throw Error("Invalid poll batch");
  const now = input.now ?? Date.now();
  await harness.commit(async (tx) => {
    const state = await tx.doc(ChannelState);
    if (state.schemaVersion !== 1 || state.accountId &&
      (state.accountId !== credentials.accountId || state.userId !== credentials.userId)) throw Error("Channel binding mismatch");
    state.accountId = credentials.accountId; state.userId = credentials.userId;
    const reject = (reason: string) => {
      state.rejected.push({ reason, at: now });
      if (state.rejected.length > 100) state.rejected.shift();
    };
    for (const message of input.batch.msgs) {
      if (!message || typeof message !== "object" || !isBoundSender(message, credentials)) { reject("unauthorized-or-invalid-sender"); continue; }
      const id = message.message_id;
      if (!(typeof id === "string" && id.trim() || typeof id === "number" && Number.isSafeInteger(id))) { reject("missing-message-id"); continue; }
      const key = hash(JSON.stringify([credentials.accountId, credentials.userId, String(id)]));
      // Context rotates independently of message payload; retry must not conflict
      // merely because server supplied a fresh transport context token.
      const payload = JSON.stringify({ items: message.item_list, createdAt: message.create_time_ms });
      if (Buffer.byteLength(payload) > input.messageBytes || !Array.isArray(message.item_list) || message.item_list.length === 0 ||
        message.item_list.some((item) => !item || typeof item !== "object" || !Number.isSafeInteger(item.type) ||
          item.type === 1 && typeof item.text_item?.text !== "string")) { reject("invalid-or-oversize-message"); continue; }
      const payloadHash = hash(payload);
      const prior = state.inbox.find((record) => record.key === key);
      if (prior && prior.payloadHash !== payloadHash) { reject("message-id-conflict"); continue; }
      if (!prior) {
        if (state.inbox.length >= input.receiptLimit || state.inbox.filter((record) => record.status === "received" || record.status === "submitted").length >= input.pendingLimit) {
          throw new InboxCapacityError("Inbox capacity exhausted; cursor not advanced");
        }
        state.inbox.push({ key, payloadHash, payload, receivedAt: now, requestId: `wechat:${key}`,
          submissionId: null, status: "received" });
      }
      if (typeof message.context_token === "string" && message.context_token) state.contextToken = message.context_token;
    }
    state.cursor = input.batch.get_updates_buf;
  }, BACKGROUND_CONTEXT);
};
