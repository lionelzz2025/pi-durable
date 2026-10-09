import type { Credentials, GetUpdatesResp } from "./channel/types.ts";
import { validateCredentials } from "./channel/identity.ts";
import { acquireAccountLock } from "./channel/account-lock.ts";
import { pollWechat } from "./channel/poll-loop.ts";
import { WechatApi } from "./channel/api.ts";

/** Lifecycle with injected durable admission. No default in-memory/discarding sink. */
export const runWechatChannel = async (options: {
  credentials: Credentials;
  expectedAccountId: string;
  expectedUserId: string;
  legacyStopped: boolean;
  signal: AbortSignal;
  api: WechatApi;
  cursor: () => Promise<string>;
  admit: (batch: GetUpdatesResp) => Promise<void>;
  onState: (state: "polling" | "backoff" | "expired" | "stopped") => void;
  lockRoot?: string;
  closeRuntime: () => Promise<void>;
}): Promise<void> => {
  let release: (() => Promise<void>) | undefined;
  try {
    const credentials = validateCredentials(options.credentials);
    if (!options.legacyStopped) throw new Error("Legacy plugin shutdown must be explicitly confirmed");
    if (credentials.accountId !== options.expectedAccountId || credentials.userId !== options.expectedUserId) {
      throw new Error("Channel credentials do not match configured identity");
    }
    options.signal.throwIfAborted();
    release = await acquireAccountLock(credentials.accountId, options.lockRoot);
    await pollWechat({ ...options, credentials });
  } finally {
    // Drain/close the runtime before relinquishing account ownership, even when
    // admission failed. Runtime close failures must not strand the account lock.
    try { await options.closeRuntime(); }
    finally { await release?.(); }
  }
};
