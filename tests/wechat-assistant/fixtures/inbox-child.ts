import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { openWechatHarness } from "../../../src/wechat-assistant/runtime.ts";
import { admitWechatBatch } from "../../../src/wechat-assistant/inbox.ts";
import { ChannelState } from "../../../src/wechat-assistant/documents.ts";
import { ensureBoundConversation, submitReceivedInbox } from "../../../src/wechat-assistant/conversations.ts";
import { reconcileInbox } from "../../../src/wechat-assistant/settlement.ts";

const [db, mode] = process.argv.slice(2);
if (!db || !mode) throw Error("Missing arguments");
const models = createModels(); const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("answer")]); models.setProvider(faux.provider);
const harness = await openWechatHarness(db, { models, registry: createRegistry() });
const emit = (data: unknown) => console.log(JSON.stringify(data));
try {
  const root = await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
  if (mode !== "recover") {
    await admitWechatBatch(harness, { credentials: { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" },
      messageBytes: 32768, pendingLimit: 10, receiptLimit: 100,
      batch: { ret: 0, get_updates_buf: "committed-cursor", msgs: [{ message_id: "stable-msg", client_id: "", from_user_id: "user", to_user_id: "bot",
        create_time_ms: 1, message_type: 1, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text: "persisted input" } }] }] } });
    if (mode === "after-submit") {
      const record = (await harness.snapshot(ChannelState, context))!.inbox[0]!;
      await harness.commit(async (tx) => { (await tx.doc(ChannelState)).inbox[0]!.conversationId = root.id; }, context);
      await root.submit({ type: "input", requestId: record.requestId, content: "persisted input", whenBusy: "followUp" }, context);
    }
    emit({ event: "kill-window", conversationId: root.id });
    await new Promise(() => { setInterval(() => {}, 1000); });
  } else {
    await submitReceivedInbox(harness); harness.resume();
    await harness.waitForIdle(context); await reconcileInbox(harness);
    const state = (await harness.snapshot(ChannelState, context))!;
    const entries = await root.entries({ order: "ascending" }, 100, undefined, context);
    emit({ event: "recovered", conversationId: root.id, state, users: entries.items.filter((entry) => entry.kind === "pi.user").length });
  }
} finally { await harness.close(context); }
