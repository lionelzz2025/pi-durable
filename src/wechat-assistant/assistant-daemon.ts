import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { assistantExtension } from "./extension.ts";
import { runApprovalConsole } from "./approval-console.ts";
import type { WechatConfig } from "./config.ts";
import type { Credentials, GetUpdatesResp } from "./channel/types.ts";
import { WechatApi } from "./channel/api.ts";
import { WechatCdn } from "./channel/cdn.ts";
import { openAssistantRuntime } from "./agent-runtime.ts";
import { runAssistantPump } from "./assistant-pump.ts";
import { ChannelState } from "./documents.ts";
import { admitWechatBatch } from "./inbox.ts";
import { runWechatChannel } from "./lifecycle.ts";
import type { OutboxSender } from "./outbox.ts";

/** Offline-testable single-owner runtime; the caller supplies a fully populated
 * model/registry and sender, and must explicitly confirm the legacy owner stopped.
 * Never constructs a fallback model, pi extension, or in-memory queue. */
export const runAssistantDaemon = async (options: {
  config: WechatConfig;
  credentials: Credentials;
  harnessOptions: Omit<HarnessOptions, "registry">;
  /** Test-only registry override; production always installs the complete assistant extension. */
  registry?: HarnessOptions["registry"];
  api: WechatApi;
  cdn: WechatCdn;
  sender: OutboxSender;
  signal: AbortSignal;
  legacyStopped: boolean;
  lockRoot?: string;
  onState: (state: "polling" | "backoff" | "expired" | "stopped") => void;
  onPumpError?: (error: unknown) => void;
  approvalConsole?: (harness: Harness, signal: AbortSignal) => Promise<void>;
}): Promise<void> => {
  const { config } = options;
  if (!options.legacyStopped) throw Error("Legacy plugin shutdown must be explicitly confirmed");
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) controller.abort();
  let harness: Harness | undefined;
  let pump: Promise<void> | undefined;
  let approvals: Promise<void> | undefined;
  let pumpFailure: unknown;
  let approvalFailure: unknown;
  try {
    // Opening the runtime only performs local recovery. The pump is started by
    // cursor(), which pollWechat calls AFTER runWechatChannel acquired the lock.
    const builtRegistry = createRegistry();
    if (!options.registry) builtRegistry.install(assistantExtension({ memoryPromptBytes: config.limits.memoryPromptBytes,
      workspace: { root: config.workspaceDir, maxBytes: config.limits.attachmentBytes }, mediaRoot: resolve(config.dataDir, "media"),
      harness: () => { if (!harness) throw Error("Assistant owner not ready"); return harness; },
      boundUserId: config.boundUserId, shellEnabled: config.shell.enabled }));
    const registry = options.registry ?? builtRegistry;
    harness = await openAssistantRuntime(resolve(config.dataDir, "assistant.sqlite"), { ...options.harnessOptions, registry },
      { accountId: config.accountId, userId: config.boundUserId, model: config.model },
      { root: resolve(config.dataDir, "media"), maxBytes: config.limits.attachmentBytes, cdn: options.cdn, signal: controller.signal });
    const owner = harness;
    if (config.shell.enabled) {
      approvals = (options.approvalConsole ?? runApprovalConsole)(owner, controller.signal);
      void approvals.catch((error: unknown) => { approvalFailure = error; controller.abort(); });
    }
    await runWechatChannel({ credentials: options.credentials, expectedAccountId: config.accountId,
      expectedUserId: config.boundUserId, legacyStopped: options.legacyStopped, signal: controller.signal,
      api: options.api, lockRoot: options.lockRoot, onState: options.onState,
      cursor: async () => {
        if (!pump) {
          pump = runAssistantPump(owner, { recipient: config.boundUserId, signal: controller.signal,
            sender: options.sender, media: { root: resolve(config.dataDir, "media"), maxBytes: config.limits.attachmentBytes, cdn: options.cdn },
            mediaSender: { policy: { root: config.workspaceDir, maxBytes: config.limits.attachmentBytes }, api: options.api, cdn: options.cdn, token: options.credentials.token },
            onError: options.onPumpError, intervalMs: 1_000 });
          // Observe a failed pump immediately, including while long-poll is in flight.
          void pump.catch((error: unknown) => { pumpFailure = error; controller.abort(); });
        }
        return (await owner.snapshot(ChannelState, BACKGROUND_CONTEXT))?.cursor ?? "";
      },
      admit: async (batch: GetUpdatesResp) => admitWechatBatch(owner, { credentials: options.credentials, batch,
        messageBytes: config.limits.messageBytes, attachmentBytes: config.limits.attachmentBytes,
        pendingLimit: config.limits.inboxPending, receiptLimit: 10_000 }),
      closeRuntime: async () => {
        controller.abort();
        try { await pump; } finally { await owner.close(BACKGROUND_CONTEXT); harness = undefined; }
      },
    });
    if (pumpFailure) throw pumpFailure;
    if (approvalFailure) throw approvalFailure;
  } finally {
    controller.abort();
    options.signal.removeEventListener("abort", stop);
    try { await approvals?.catch(() => undefined); } finally { if (harness) await harness.close(BACKGROUND_CONTEXT); }
  }
};
