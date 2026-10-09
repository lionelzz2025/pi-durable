// Adapter from the outbox to the real WeChat API. The only translation with
// delivery semantics is error classification: a `network` ProtocolError means the
// request may or may not have reached WeChat, so it becomes SendOutcomeUnknown and
// the outbox will not auto-retry it. HTTP/API/invalid-response errors are definite
// failures the outbox may retry with backoff.
import { ProtocolError, type WechatApi } from "./channel/api.ts";
import { MessageItemType } from "./channel/types.ts";
import { SendOutcomeUnknown, type OutboxSender } from "./outbox.ts";

export const senderFromApi = (api: WechatApi, token: string): OutboxSender =>
  async (chunk) => {
    try {
      await api.sendMessage(token, chunk.userId, chunk.contextToken, chunk.clientId, [
        { type: MessageItemType.TEXT, text_item: { text: chunk.text } },
      ]);
    } catch (error) {
      if (error instanceof ProtocolError && error.kind === "network") {
        throw new SendOutcomeUnknown("WeChat send outcome unknown");
      }
      throw error;
    }
  };
