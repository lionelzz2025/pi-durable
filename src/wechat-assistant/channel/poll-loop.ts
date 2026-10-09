import { setTimeout as delay } from "node:timers/promises";
import { WechatApi, ProtocolError, isSessionExpired } from "./api.ts";
import type { Credentials, GetUpdatesResp } from "./types.ts";

/** Adapter only: admission owns cursor persistence and identity checks.
 * Admission failures must not be confused with retryable network failures.
 */
export const pollWechat = async (options: {
  api: WechatApi;
  credentials: Credentials;
  signal: AbortSignal;
  cursor: () => Promise<string>;
  admit: (batch: GetUpdatesResp) => Promise<void>;
  onState: (state: "polling" | "backoff" | "expired" | "stopped") => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}): Promise<void> => {
  const base = options.retryBaseMs ?? 1_000;
  const max = options.retryMaxMs ?? 30_000;
  if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(max) || max < base) throw new Error("Invalid poll retry limits");
  let failures = 0;
  try {
    while (!options.signal.aborted) {
      const cursor = await options.cursor();
      let batch: GetUpdatesResp;
      try {
        options.onState("polling");
        batch = await options.api.getUpdates(options.credentials.token, cursor, options.signal);
      } catch (error) {
        if (options.signal.aborted) break;
        if (isSessionExpired(error)) { options.onState("expired"); throw error; }
        const retryable = error instanceof ProtocolError &&
          (error.kind === "network" || error.kind === "http" && (error.status === 429 || (error.status ?? 0) >= 500));
        if (!retryable) throw error;
        failures = Math.min(failures + 1, 16);
        options.onState("backoff");
        try {
          await delay(Math.min(max, base * 2 ** (failures - 1)), undefined, { signal: options.signal });
        } catch (error) {
          if (options.signal.aborted) break;
          throw error;
        }
        continue;
      }
      // No catch/retry here: admission/storage/schema failure stops the loop.
      await options.admit(batch);
      failures = 0;
    }
  } finally { options.onState("stopped"); }
};
