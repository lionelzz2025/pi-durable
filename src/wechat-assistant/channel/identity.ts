import type { Credentials, WeixinMessage } from "./types.ts";
import { validateOrigin } from "./api.ts";

export const validateCredentials = (value: unknown): Credentials => {
  if (!value || typeof value !== "object") throw new Error("Invalid WeChat credentials");
  const record = value as Record<string, unknown>;
  for (const field of ["token", "baseUrl", "accountId", "userId"]) {
    if (typeof record[field] !== "string" || !record[field].trim() || /[\r\n]/.test(record[field])) throw new Error("Invalid WeChat credentials");
  }
  const baseUrl = validateOrigin(record.baseUrl as string);
  return { token: record.token as string, baseUrl, accountId: record.accountId as string, userId: record.userId as string };
};

/** Must run before downloads, durable admission, or any model call. */
export const isBoundSender = (message: WeixinMessage, credentials: Credentials): boolean =>
  typeof message.from_user_id === "string" && message.from_user_id.length > 0 &&
  message.from_user_id === credentials.userId && message.to_user_id === credentials.accountId &&
  message.message_type === 1;
