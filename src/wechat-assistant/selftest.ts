import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PROJECT_ROOT, DEFAULT_LIMITS, type WechatConfig } from "./config.ts";
import { runAssistantDaemon } from "./assistant-daemon.ts";
import { WechatApi } from "./channel/api.ts";
import { WechatCdn } from "./channel/cdn.ts";

/** An explicit isolated local smoke run. Never loads credentials, opens the
 * configured production database, connects to WeChat, or invokes a paid model. */
export const runOfflineSelftest = async (): Promise<{ database: string; sent: number }> => {
  const root = resolve(PROJECT_ROOT, "data/test-runs", `wechat-selftest-${randomUUID()}`);
  const config: WechatConfig = { schemaVersion: 1, dataDir: resolve(root, "data"), workspaceDir: resolve(root, "workspace"),
    accountId: "offline-selftest-bot", boundUserId: "offline-selftest-user", model: { provider: "faux", modelId: "faux-1" },
    shell: { enabled: false }, limits: { ...DEFAULT_LIMITS } };
  const models = createModels(); const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("offline-selftest-answer")]);
  models.setProvider(faux.provider);
  const credentials = { token: "offline-only", baseUrl: "https://ilinkai.weixin.qq.com", accountId: config.accountId, userId: config.boundUserId };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  let polled = 0, sent = 0;
  const api = new WechatApi({ transport: async () => {
    if (polled++ === 0) return Response.json({ ret: 0, get_updates_buf: "selftest-cursor", msgs: [{ message_id: "selftest-1",
      from_user_id: config.boundUserId, to_user_id: config.accountId, client_id: "", create_time_ms: 1,
      message_type: 1, message_state: 2, context_token: "selftest-context", item_list: [{ type: 1, text_item: { text: "offline question" } }] }] });
    await new Promise<void>((done) => { if (controller.signal.aborted) done(); else controller.signal.addEventListener("abort", () => done(), { once: true }); });
    throw Error("offline selftest stopped");
  } });
  try {
    await runAssistantDaemon({ config, credentials, harnessOptions: { models }, api,
      cdn: new WechatCdn(async () => { throw Error("Offline selftest must not access CDN"); }),
      sender: async (chunk) => { if (chunk.text !== "offline-selftest-answer") throw Error("Unexpected offline response"); sent++; controller.abort(); },
      signal: controller.signal, legacyStopped: true, lockRoot: resolve(root, "account-lock"), onState: () => {} });
    if (sent !== 1 || faux.state.callCount !== 1) throw Error("Offline selftest did not complete one fake request/reply");
    return { database: resolve(config.dataDir, "assistant.sqlite"), sent };
  } finally { clearTimeout(timer); controller.abort(); }
};
