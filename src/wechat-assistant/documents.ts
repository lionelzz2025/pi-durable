import { defineDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
export type InboxRecord = {
  key: string; payloadHash: string; payload: string; receivedAt: number;
  requestId: string; submissionId: SubmissionId | null;
  status: "received" | "submitted" | "settled" | "quarantined";
};
export const ChannelState = defineDoc<{
  schemaVersion: number; accountId: string; userId: string;
  conversationId: ConversationId | null; cursor: string; contextToken: string;
  inbox: InboxRecord[]; rejected: { reason: string; at: number }[];
}>({ kind: "wechat.channel", version: 1, scope: "session", initial: () => ({
  schemaVersion: 1, accountId: "", userId: "", conversationId: null, cursor: "", contextToken: "", inbox: [], rejected: [],
}) });
