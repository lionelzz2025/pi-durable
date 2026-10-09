import { setTimeout as delay } from "node:timers/promises";
import { WechatApi, ProtocolError } from "./api.ts";
import { validateCredentials } from "./identity.ts";
import type { Credentials } from "./types.ts";

/** Caller displays QR locally and saves credentials only after full identity validation. */
export const loginWechat = async (options: {
  api: WechatApi;
  signal: AbortSignal;
  showQr: (content: string) => void;
  expectedAccountId: string;
  expectedUserId: string;
  pollDelayMs?: number;
}): Promise<Credentials> => {
  options.signal.throwIfAborted();
  const qr = await options.api.fetchQrCode(options.signal);
  options.showQr(qr.qrcode_img_content);
  while (true) {
    options.signal.throwIfAborted();
    const status = await options.api.getQrCodeStatus(qr.qrcode, options.signal);
    if (status.status === "expired") throw new Error("WeChat QR expired; explicit login retry required");
    if (status.status === "scaned_but_redirect") throw new Error("Unsupported WeChat QR redirect");
    if (status.status === "confirmed") {
      const credentials = validateCredentials({ token: status.bot_token, baseUrl: status.baseurl,
        accountId: status.ilink_bot_id, userId: status.ilink_user_id });
      if (credentials.accountId !== options.expectedAccountId || credentials.userId !== options.expectedUserId) {
        throw new Error("WeChat QR identity does not match configured binding");
      }
      return credentials;
    }
    if (status.status !== "wait" && status.status !== "scaned") throw new ProtocolError("invalid-response");
    await delay(options.pollDelayMs ?? 1_000, undefined, { signal: options.signal });
  }
};
