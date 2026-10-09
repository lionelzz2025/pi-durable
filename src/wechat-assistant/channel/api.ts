// Protocol adapted from pi-wechat-assistant 0.3.1 (MIT, Copyright (c) 2026 sj).
// See THIRD_PARTY_NOTICES.md. No persistence, retries, or pi host dependencies.
import { randomBytes } from "node:crypto";
import type { GetUpdatesResp, GetUploadUrlReq, GetUploadUrlResp, MessageItem } from "./types.ts";

export const ILINK_ORIGIN = "https://ilinkai.weixin.qq.com";
export type Transport = (url: URL, init: RequestInit) => Promise<Response>;
export class ProtocolError extends Error {
  readonly kind: "http" | "api" | "invalid-response" | "network";
  readonly status?: number;
  readonly code?: number;
  constructor(kind: ProtocolError["kind"], status?: number, code?: number) {
    super(`WeChat protocol ${kind}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "ProtocolError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}
export const validateOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.origin !== ILINK_ORIGIN || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Unsupported WeChat API origin");
  }
  return url.origin;
};
export interface QrCodeResponse { qrcode: string; qrcode_img_content: string }
export interface QrStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string;
}
const requireText = (value: string, label: string): void => {
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`Invalid ${label}`);
};

export class WechatApi {
  private readonly origin: string;
  private readonly transport: Transport;
  private readonly uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  private readonly maxResponseBytes: number;
  constructor(options: { origin?: string; transport?: Transport; maxResponseBytes?: number } = {}) {
    this.origin = validateOrigin(options.origin ?? ILINK_ORIGIN);
    this.transport = options.transport ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) throw new Error("Invalid response limit");
  }
  private async request(path: string, body: unknown | undefined, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== undefined) {
      requireText(token, "credential");
      Object.assign(headers, { AuthorizationType: "ilink_bot_token", Authorization: `Bearer ${token}`, "X-WECHAT-UIN": this.uin });
    } else headers["iLink-App-ClientVersion"] = "1";
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    combined.throwIfAborted();
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origin), { method: body === undefined ? "GET" : "POST", headers,
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: combined });
    } catch { throw new ProtocolError("network"); }
    // An injected transport must also honor the no-redirect contract.
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new ProtocolError("http", response.status);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader) while (true) {
        combined.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.maxResponseBytes) throw new ProtocolError("invalid-response", response.status);
        chunks.push(part.value);
      }
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      throw error instanceof ProtocolError ? error : new ProtocolError("network");
    } finally { reader?.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ProtocolError("invalid-response", response.status); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProtocolError("invalid-response", response.status);
    const result = payload as Record<string, unknown>;
    const code = typeof result.errcode === "number" ? result.errcode : typeof result.ret === "number" ? result.ret : undefined;
    if (!response.ok) throw new ProtocolError("http", response.status, code);
    if ((typeof result.ret === "number" && result.ret !== 0) || (typeof result.errcode === "number" && result.errcode !== 0)) {
      throw new ProtocolError("api", response.status, code);
    }
    return result;
  }
  async getUpdates(token: string, cursor: string, signal?: AbortSignal): Promise<GetUpdatesResp> {
    const result = await this.request("/ilink/bot/getupdates", { get_updates_buf: cursor, base_info: { channel_version: "1.0.0" } }, token, 40_000, signal);
    if (!Array.isArray(result.msgs) || typeof result.get_updates_buf !== "string" || result.ret !== 0) throw new ProtocolError("invalid-response");
    return result as unknown as GetUpdatesResp; // message-level validation belongs to inbox admission
  }
  async sendMessage(token: string, userId: string, contextToken: string, clientId: string, items: MessageItem[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    for (const [value, label] of [[userId, "recipient"], [contextToken, "context token"], [clientId, "client ID"]]) requireText(value!, label!);
    if (items.length === 0) throw new Error("Empty message");
    return this.request("/ilink/bot/sendmessage", { msg: { from_user_id: "", to_user_id: userId, client_id: clientId,
      message_type: 2, message_state: 2, context_token: contextToken, item_list: items }, base_info: { channel_version: "1.0.0" } }, token, 15_000, signal);
  }
  async getUploadUrl(token: string, params: Omit<GetUploadUrlReq, "base_info" | "no_need_thumb">, signal?: AbortSignal): Promise<GetUploadUrlResp> {
    requireText(params.filekey, "file key"); requireText(params.to_user_id, "recipient");
    if (![1, 3].includes(params.media_type) || !Number.isSafeInteger(params.rawsize) || params.rawsize <= 0 ||
      !Number.isSafeInteger(params.filesize) || params.filesize <= 0 || params.rawsize > 20971520 || params.filesize > 20971536 ||
      !/^[a-f0-9]{32}$/i.test(params.rawfilemd5) || !/^[a-f0-9]{32}$/i.test(params.aeskey)) throw new Error("Invalid media upload metadata");
    const result = await this.request("/ilink/bot/getuploadurl", { ...params, no_need_thumb: true,
      base_info: { channel_version: "1.0.0" } }, token, 20_000, signal);
    if (typeof result.upload_param !== "string" || !result.upload_param) throw new ProtocolError("invalid-response");
    // Never trust upload_full_url from the server; CDN transport uses fixed origin.
    return { ret: 0, upload_param: result.upload_param };
  }
  async fetchQrCode(signal?: AbortSignal): Promise<QrCodeResponse> {
    const result = await this.request("/ilink/bot/get_bot_qrcode?bot_type=3", undefined, undefined, 15_000, signal);
    if (typeof result.qrcode !== "string" || !result.qrcode || typeof result.qrcode_img_content !== "string") throw new ProtocolError("invalid-response");
    return result as unknown as QrCodeResponse;
  }
  async getQrCodeStatus(qrcode: string, signal?: AbortSignal): Promise<QrStatusResponse> {
    requireText(qrcode, "QR code");
    const result = await this.request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, undefined, undefined, 40_000, signal);
    if (!["wait", "scaned", "confirmed", "expired", "scaned_but_redirect"].includes(String(result.status))) throw new ProtocolError("invalid-response");
    return result as unknown as QrStatusResponse;
  }
}
export const isSessionExpired = (error: unknown): boolean => error instanceof ProtocolError && error.code === -14;
