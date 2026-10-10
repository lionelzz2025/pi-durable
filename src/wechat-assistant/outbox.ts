// Durable outbox: turns committed assistant answers into WeChat sends with a
// crash-safe, at-most-once-on-unknown-state policy.
//
// Invariants:
//  * A record is keyed by `${conversationId}:${answerEntryId}`, so rescanning
//    after a crash never creates a second copy of the same answer (N11).
//  * The status is committed as `sending` BEFORE the network call. A process
//    killed during that call leaves `sending`, which startup converts to
//    `outcome_unknown` — never silently resent (N12).
//  * Only a definite failure (a classified protocol/HTTP error) consumes an
//    attempt and is retried with capped backoff; ambiguous network outcomes are
//    never auto-retried. Manual retry is the only path out of `outcome_unknown`.
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";

export type OutboxStatus = "pending" | "sending" | "sent" | "blocked" | "outcome_unknown";

export type OutboxRecord = {
  key: string;
  conversationId: number;
  answerEntryId: number;
  recipient: string;
  payloadHash: string;
  chunks: string[];
  clientIds: string[];
  chunkIndex: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
};

export const Outbox = defineDoc<{ records: OutboxRecord[] }>({
  kind: "wechat.outbox",
  version: 1,
  scope: "session",
  initial: () => ({ records: [] }),
});

export const OUTBOX_LIMITS = {
  chunkBytes: 2048,
  maxRecords: 1000,
  sendAttempts: 5,
  maxBackoffMs: 30_000,
} as const;

/** Thrown by a sender when the request may or may not have reached WeChat. */
export class SendOutcomeUnknown extends Error {
  constructor(message = "send outcome unknown") {
    super(message);
    this.name = "SendOutcomeUnknown";
  }
}

export type OutboundChunk = { userId: string; contextToken: string; clientId: string; text: string };
export type OutboxSender = (chunk: OutboundChunk) => Promise<void>;

export type OutboxOptions = {
  readonly recipient: string;
  readonly context?: Context;
  readonly now?: () => number;
  readonly sendAttempts?: number;
  readonly maxRecords?: number;
  readonly chunkBytes?: number;
};

/**
 * Split text into chunks that each fit `maxBytes` UTF-8 bytes. Iterating by code
 * point keeps surrogate pairs intact; no chunk ever ends mid-character.
 */
export const splitMessage = (text: string, maxBytes: number): string[] => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid chunk byte budget");
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length > 0 && Buffer.byteLength(current + character, "utf8") > maxBytes) {
      chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const backoffMs = (attempts: number, maxBackoffMs = OUTBOX_LIMITS.maxBackoffMs): number =>
  Math.min(maxBackoffMs, 500 * 2 ** Math.max(0, attempts - 1));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Extract assistant output text from a `pi.assistant` entry. */
export const extractAssistantText = (entry: EntryRecord | undefined): string | undefined => {
  const content = entry?.model?.[0]?.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
  return text.trim() || undefined;
};

const findAnswerEntry = async (harness: Harness, conversationId: number, answerEntryId: number, context: Context): Promise<EntryRecord | undefined> => {
  const conversation = await harness.conversation(conversationId as never, context);
  if (!conversation) return undefined;
  const view = await conversation.context(context);
  return view.entries.find((entry) => entry.id === answerEntryId);
};

/**
 * Scan settled submissions and create one outbox record per committed answer.
 * Idempotent: the `key` dedupe check runs inside the commit, so repeated scans
 * and concurrent recovery create nothing twice.
 */
export const enqueueAnswers = async (harness: Harness, options: OutboxOptions): Promise<number> => {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const now = options.now ?? Date.now;
  const chunkBytes = options.chunkBytes ?? OUTBOX_LIMITS.chunkBytes;
  const maxRecords = options.maxRecords ?? OUTBOX_LIMITS.maxRecords;
  const state = await harness.snapshot(ChannelState, context);
  if (!state) return 0;
  let created = 0;
  for (const record of state.inbox) {
    if (record.status !== "settled" || record.submissionId === null) continue;
    const submission = await harness.submission(record.submissionId, context);
    if (!submission) continue;
    const receipt = await submission.status(context);
    if (receipt.status !== "done") continue;
    const conversationId = (record.conversationId ?? state.conversationId) as number | null;
    if (conversationId === null) continue;
    const key = `${conversationId}:${receipt.answer}`;
    const existing = await harness.snapshot(Outbox, context);
    if (existing?.records.some((candidate) => candidate.key === key)) continue;
    const text = extractAssistantText(await findAnswerEntry(harness, conversationId, receipt.answer as unknown as number, context));
    if (text === undefined) continue;
    const chunks = splitMessage(text, chunkBytes);
    if (chunks.length === 0) continue;
    const clientIds = chunks.map((_chunk, index) => createHash("sha256").update(`${key}:${index}`).digest("hex").slice(0, 32));
    const payloadHash = createHash("sha256").update(text).digest("hex");
    const created_ = await harness.commit(async (tx) => {
      const outbox = await tx.doc(Outbox);
      if (outbox.records.some((candidate) => candidate.key === key)) return false;
      if (outbox.records.length >= maxRecords) throw new Error("Outbox capacity reached");
      outbox.records.push({
        key, conversationId, answerEntryId: receipt.answer as unknown as number, recipient: options.recipient,
        payloadHash, chunks, clientIds, chunkIndex: 0, attempts: 0, nextAttemptAt: 0, lastError: "",
        status: "pending", createdAt: now(), updatedAt: now(),
      });
      return true;
    }, context);
    if (created_) created += 1;
  }
  return created;
};

/** A record left `sending` by a crash has an unknowable outcome: never auto-resend. */
export const recoverOutbox = async (harness: Harness, context: Context = BACKGROUND_CONTEXT): Promise<number> => {
  const state = await harness.snapshot(Outbox, context);
  const stuck = (state?.records ?? []).filter((record) => record.status === "sending");
  if (stuck.length === 0) return 0;
  await harness.commit(async (tx) => {
    const outbox = await tx.doc(Outbox);
    for (const record of outbox.records) {
      if (record.status === "sending") {
        record.status = "outcome_unknown";
        record.lastError = "process stopped during send; delivery unknown";
        record.updatedAt = Date.now();
      }
    }
  }, context);
  return stuck.length;
};

export type DrainResult = { sent: number; retried: number; blocked: number; unknown: number };

/**
 * Send due pending records. `contextToken` is read fresh from ChannelState on each
 * pass so a refreshed token is used; a missing token is a definite failure that
 * backs off (and eventually blocks) rather than a silent send.
 */
export const drainOutbox = async (harness: Harness, sender: OutboxSender, options: OutboxOptions): Promise<DrainResult> => {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const now = options.now ?? Date.now;
  const sendAttempts = options.sendAttempts ?? OUTBOX_LIMITS.sendAttempts;
  const result: DrainResult = { sent: 0, retried: 0, blocked: 0, unknown: 0 };
  const snapshot = await harness.snapshot(Outbox, context);
  for (const candidate of snapshot?.records ?? []) {
    if (candidate.status !== "pending") continue;
    // Send every chunk of one message in this pass so a drain() completes a
    // message; re-claim each chunk because the previous commit replaced the draft.
    for (;;) {
      const claimed = await harness.commit(async (tx) => {
        const target = (await tx.doc(Outbox)).records.find((record) => record.key === candidate.key);
        if (!target || target.status !== "pending" || target.nextAttemptAt > now()) return undefined;
        const channel = await tx.doc(ChannelState);
        if (!channel.contextToken || channel.userId !== target.recipient) {
          target.status = "blocked";
          target.lastError = "bound context unavailable; wait for a new message";
          target.updatedAt = now();
          return { blocked: true as const };
        }
        target.status = "sending";
        target.updatedAt = now();
        // Deep-copy the mutable arrays: the draft overlay is unusable once settled.
        return { blocked: false as const, contextToken: channel.contextToken,
          record: { ...target, chunks: [...target.chunks], clientIds: [...target.clientIds] } };
      }, context);
      if (!claimed) break;
      if (claimed.blocked) { result.blocked += 1; break; }
      const { record: item, contextToken } = claimed;
      const text = item.chunks[item.chunkIndex];
      const clientId = item.clientIds[item.chunkIndex];
      if (text === undefined || clientId === undefined) {
        await harness.commit(async (tx) => {
          const target = (await tx.doc(Outbox)).records.find((record) => record.key === item.key);
          if (target) { target.status = "sent"; target.updatedAt = now(); }
        }, context);
        result.sent += 1;
        break;
      }
      try {
        await sender({ userId: item.recipient, contextToken, clientId, text });
        const last = await harness.commit(async (tx) => {
          const target = (await tx.doc(Outbox)).records.find((record) => record.key === item.key);
          if (!target) return true;
          target.chunkIndex += 1;
          target.attempts = 0;
          target.lastError = "";
          target.nextAttemptAt = 0;
          const done = target.chunkIndex >= target.chunks.length;
          target.status = done ? "sent" : "pending";
          target.updatedAt = now();
          return done;
        }, context);
        if (last) { result.sent += 1; break; }
      } catch (error) {
        if (error instanceof SendOutcomeUnknown) {
          await harness.commit(async (tx) => {
            const target = (await tx.doc(Outbox)).records.find((record) => record.key === item.key);
            if (target) { target.status = "outcome_unknown"; target.lastError = messageOf(error); target.updatedAt = now(); }
          }, context);
          result.unknown += 1;
          break;
        }
        const attempts = item.attempts + 1;
        const blocked = attempts >= sendAttempts;
        await harness.commit(async (tx) => {
          const target = (await tx.doc(Outbox)).records.find((record) => record.key === item.key);
          if (!target) return;
          target.attempts = attempts;
          target.lastError = messageOf(error);
          target.status = blocked ? "blocked" : "pending";
          target.nextAttemptAt = blocked ? 0 : now() + backoffMs(attempts);
          target.updatedAt = now();
        }, context);
        if (blocked) result.blocked += 1;
        else result.retried += 1;
        break;
      }
    }
  }
  return result;
};

/**
 * Manual retry: the explicit, human-authorized path out of `outcome_unknown`/`blocked`.
 * Resumes at the failed chunk with its original client id; this may duplicate a
 * message if the unknown send actually landed, which is why it is never automatic.
 */
export const retryOutbox = async (harness: Harness, keys?: readonly string[], context: Context = BACKGROUND_CONTEXT): Promise<number> => {
  let retried = 0;
  await harness.commit(async (tx) => {
    const outbox = await tx.doc(Outbox);
    for (const record of outbox.records) {
      if (record.status !== "outcome_unknown" && record.status !== "blocked") continue;
      if (keys && !keys.includes(record.key)) continue;
      record.status = "pending";
      record.attempts = 0;
      record.nextAttemptAt = 0;
      record.updatedAt = Date.now();
      retried += 1;
    }
  }, context);
  return retried;
};
