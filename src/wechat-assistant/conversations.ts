import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";
import { executeControl, parseControl } from "./controls.ts";
import { Outbox, OUTBOX_LIMITS, splitMessage } from "./outbox.ts";
import { inspectWechatMedia, verifyStoredWechatMedia } from "./media.ts";
import { downloadAndStoreWechatMedia } from "./tools/media.ts";
import type { WechatCdn } from "./channel/cdn.ts";

type InboundMedia = { root: string; maxBytes: number; cdn: WechatCdn; signal: AbortSignal };

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
export const submitReceivedInbox = async (harness: Harness, mediaOptions?: InboundMedia): Promise<void> => {
  const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
  if (!state?.conversationId) throw Error("Inbox has no bound conversation");
  for (const record of state.inbox) {
    if (record.status !== "received") continue;
    // Freeze the destination before submit. A mapping change must not redirect
    // a retry's conversation-scoped request ID into a second conversation.
    const conversationId = await harness.commit(async (tx) => {
      const current = await tx.doc(ChannelState);
      const target = current.inbox.find((item) => item.key === record.key);
      if (!target || target.payloadHash !== record.payloadHash) throw Error("Inbox association changed");
      const id = target.conversationId ?? current.conversationId;
      if (id === null) throw Error("Inbox has no bound conversation");
      target.conversationId = id;
      return id;
    }, BACKGROUND_CONTEXT);
    const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw Error("Bound conversation missing");
    const payload = JSON.parse(record.payload) as { items: import("./channel/types.ts").MessageItem[] };
    const rawMessage = { item_list: payload.items } as import("./channel/types.ts").WeixinMessage;
    const inspectedMedia = inspectWechatMedia(rawMessage);
    let storedMedia = record.media;
    if (inspectedMedia.length && !mediaOptions) {
      throw Error("Inbound media transport unavailable; leaving inbox received for recovery");
    }
    if (mediaOptions) {
      if (storedMedia.length > inspectedMedia.length) throw Error("Inbox media association exceeds references");
      for (let index = 0; index < inspectedMedia.length; index++) {
        const existing = storedMedia[index];
        if (existing) {
          if (existing.kind !== inspectedMedia[index]!.kind || existing.name !== inspectedMedia[index]!.name) {
            throw Error("Inbox media association changed");
          }
          await verifyStoredWechatMedia(existing, mediaOptions.root, mediaOptions.maxBytes);
          continue;
        }
        // Persist each attachment before downloading the next. A failure on the
        // second attachment can resume from the first verified association.
        const declaredFile = payload.items.filter((item) => item.type === 2 || item.type === 4)
          .filter((item) => inspectWechatMedia({ ...rawMessage, item_list: [item] }).length > 0)[index];
        const downloaded = await downloadAndStoreWechatMedia({ ...inspectedMedia[index]!, ...mediaOptions,
          expectedBytes: declaredFile?.type === 4 ? Number(declaredFile.file_item?.len) : undefined });
        storedMedia = await harness.commit(async (tx) => {
          const target = (await tx.doc(ChannelState)).inbox.find((item) => item.key === record.key);
          if (!target || target.payloadHash !== record.payloadHash || target.status !== "received" || target.media.length !== index) {
            throw Error("Inbox media association changed");
          }
          target.media.push(downloaded);
          return target.media.map((item) => ({ kind: item.kind, name: item.name, mime: item.mime, bytes: item.bytes, sha256: item.sha256, path: item.path }));
        }, BACKGROUND_CONTEXT);
      }
    }
    let mediaIndex = 0;
    const text = payload.items.map((item) => {
      const value = item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : undefined;
      if (typeof value === "string" && (item.type !== 3 || value.trim())) return value;
      if (item.type === 2 || item.type === 4) {
        // Validate the current item, not the first reference of the same kind:
        // a malformed earlier attachment must not consume a later one's path.
        const media = inspectWechatMedia({ ...rawMessage, item_list: [item] })[0];
        if (!media) return `[${item.type === 2 ? "图片" : "文件"}暂不支持：媒体协议能力或密钥无效]`;
        const stored = storedMedia[mediaIndex++];
        return stored ? `[${stored.kind === "image" ? "图片" : "文件"}附件：${stored.name}；本地路径：${stored.path}；SHA-256：${stored.sha256}]` : `[${media.kind === "image" ? "图片" : "文件"}暂不支持：当前运行时未配置媒体下载器]`;
      }
      if (item.type === 5) return "[暂不支持视频]";
      if (item.type === 3) return "[语音无可用转写文本]";
      return "[不支持的消息类型]";
    }).join("\n");
    const unsupported = payload.items.flatMap((item) => {
      if (item.type === 5) return ["视频"];
      if (item.type === 3 && !item.voice_item?.text?.trim()) return ["无转写的语音"];
      if ((item.type === 2 || item.type === 4) && !inspectWechatMedia({ ...rawMessage, item_list: [item] }).length) {
        return [item.type === 2 ? "图片" : "文件"];
      }
      return [];
    });
    if (unsupported.length) {
      // The notification is an outbox record, not a model instruction. Replaying
      // the same inbox key after a crash cannot create a second notification.
      await harness.commit(async (tx) => {
        const channel = await tx.doc(ChannelState);
        const target = channel.inbox.find((item) => item.key === record.key);
        if (!target || target.payloadHash !== record.payloadHash) throw Error("Inbox notice association changed");
        const outbox = await tx.doc(Outbox);
        const key = `unsupported:${record.key}`;
        if (outbox.records.some((item) => item.key === key)) return;
        if (outbox.records.length >= OUTBOX_LIMITS.maxRecords) throw Error("Outbox capacity reached");
        const notice = `暂不支持处理此消息中的${[...new Set(unsupported)].join("、")}；请发送可用的文字或文件。`;
        const chunks = splitMessage(notice, OUTBOX_LIMITS.chunkBytes);
        const now = Date.now();
        outbox.records.push({ key, conversationId: conversationId as number, answerEntryId: 0,
          recipient: channel.userId, payloadHash: createHash("sha256").update(notice).digest("hex"), chunks,
          clientIds: chunks.map((_, index) => createHash("sha256").update(`${key}:${index}`).digest("hex").slice(0, 32)),
          chunkIndex: 0, attempts: 0, nextAttemptAt: 0, lastError: "", status: "pending", createdAt: now, updatedAt: now });
      }, BACKGROUND_CONTEXT);
    }
    const command = payload.items.length === 1 && payload.items[0]?.type === 1 ? parseControl(text) : undefined;
    if (command) {
      await executeControl(harness, record.key, command, conversationId);
      await harness.commit(async (tx) => {
        const target = (await tx.doc(ChannelState)).inbox.find((item) => item.key === record.key);
        if (!target) throw Error("Control inbox disappeared");
        target.status = "settled";
      }, BACKGROUND_CONTEXT);
      continue;
    }
    const submission = await conversation.submit({ type: "input", requestId: record.requestId, content: text, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const current = await tx.doc(ChannelState);
      const target = current.inbox.find((item) => item.key === record.key);
      if (!target || target.payloadHash !== record.payloadHash) throw Error("Inbox association changed");
      target.submissionId = submission.id; target.status = "submitted";
    }, BACKGROUND_CONTEXT);
  }
};
