import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";

/** Single-account v1 uses reserved root: if killed before mapping commit,
 * root() reopens the same ID, not an orphan/new conversation. */
export const ensureBoundConversation = async (harness: Harness, binding: {
  accountId: string; userId: string; model: ModelRef;
}) => {
  const prior = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
  if (!binding.accountId || !binding.userId || prior && prior.accountId &&
    (prior.accountId !== binding.accountId || prior.userId !== binding.userId)) throw Error("Channel binding mismatch");
  if (prior?.conversationId) {
    const conversation = await harness.conversation(prior.conversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw Error("Bound conversation is missing; refusing replacement");
    return conversation;
  }
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: binding.model } });
  await harness.commit(async (tx) => {
    const state = await tx.doc(ChannelState);
    if (state.accountId && (state.accountId !== binding.accountId || state.userId !== binding.userId)) throw Error("Channel binding mismatch");
    if (state.conversationId && state.conversationId !== root.id) throw Error("Concurrent binding change");
    state.accountId = binding.accountId; state.userId = binding.userId; state.conversationId = root.id;
  }, BACKGROUND_CONTEXT);
  return root;
};

/** Stable requestId compensates the submit -> association crash window.
 * This is a single-owner pump, not a second in-memory authoritative queue. */
export const submitReceivedInbox = async (harness: Harness): Promise<void> => {
  const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
  if (!state?.conversationId) throw Error("Inbox has no bound conversation");
  const conversation = await harness.conversation(state.conversationId, BACKGROUND_CONTEXT);
  if (!conversation) throw Error("Bound conversation missing");
  for (const record of state.inbox) {
    if (record.status !== "received") continue;
    const payload = JSON.parse(record.payload) as { items: Array<{ type: number; text_item?: { text?: unknown }; voice_item?: { text?: unknown } }> };
    const text = payload.items.map((item) => {
      const value = item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : undefined;
      return typeof value === "string" ? value : "[Unsupported attachment; media integration pending]";
    }).join("\n");
    const submission = await conversation.submit({ type: "input", requestId: record.requestId, content: text, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const current = await tx.doc(ChannelState);
      const target = current.inbox.find((item) => item.key === record.key);
      if (!target || target.payloadHash !== record.payloadHash) throw Error("Inbox association changed");
      target.submissionId = submission.id; target.status = "submitted";
    }, BACKGROUND_CONTEXT);
  }
};
