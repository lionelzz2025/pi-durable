import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import type { WechatConfig } from "./config.ts";
import type { Credentials } from "./channel/types.ts";
import { WechatApi } from "./channel/api.ts";
import { openWechatHarness } from "./runtime.ts";
import { ChannelState } from "./documents.ts";
import { admitWechatBatch } from "./inbox.ts";
import { runWechatChannel } from "./lifecycle.ts";

/** Explicit receive-only milestone. No provider is registered or invoked. */
export const runPersistentReceiver = async (options: {
  config: WechatConfig; credentials: Credentials; signal: AbortSignal;
  legacyStopped: boolean; api?: WechatApi; lockRoot?: string;
  onState: (state: "polling" | "backoff" | "expired" | "stopped") => void;
}): Promise<void> => {
  await mkdir(options.config.dataDir, { recursive: true });
  const harness = await openWechatHarness(resolve(options.config.dataDir, "assistant.sqlite"), {
    models: createModels(), registry: createRegistry(),
  });
  try {
    const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    if (state && (state.schemaVersion !== 1 || state.accountId !== options.config.accountId || state.userId !== options.config.boundUserId)) throw Error("Receiver binding mismatch");
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    if (inspection.tasks.length || inspection.submissions.length) throw Error("Receive-only mode refuses existing unfinished agent work");
    await runWechatChannel({ ...options, api: options.api ?? new WechatApi(),
      expectedAccountId: options.config.accountId, expectedUserId: options.config.boundUserId,
      cursor: async () => (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))?.cursor ?? "",
      admit: (batch) => admitWechatBatch(harness, { credentials: options.credentials, batch,
        messageBytes: options.config.limits.messageBytes, pendingLimit: options.config.limits.inboxPending, receiptLimit: 10000 }),
      closeRuntime: () => harness.close(BACKGROUND_CONTEXT),
    });
  } finally { await harness.close(BACKGROUND_CONTEXT); }
};
