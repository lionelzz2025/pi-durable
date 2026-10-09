// Fixed CDN origin adapted from pi-wechat-assistant 0.3.1; no arbitrary URLs.
import { ProtocolError, type Transport } from "./api.ts";
const BASE = "https://novac2c.cdn.weixin.qq.com/c2c/";
export class WechatCdn {
  private readonly transport: Transport;
  constructor(transport: Transport = fetch) { this.transport = transport; }
  async transfer(options: {
    query: string; signal: AbortSignal; maxBytes: number; timeoutMs: number;
    upload?: { filekey: string; encrypted: Uint8Array };
  }): Promise<{ bytes?: Buffer; downloadParam?: string }> {
    if (!options.query || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid CDN transfer parameters");
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    signal.throwIfAborted();
    const url = new URL(options.upload ? "upload" : "download", BASE);
    url.searchParams.set("encrypted_query_param", options.query);
    if (options.upload) {
      if (!options.upload.filekey || options.upload.encrypted.byteLength > options.maxBytes) throw new Error("Invalid CDN upload");
      url.searchParams.set("filekey", options.upload.filekey);
    }
    let response: Response;
    try {
      response = await this.transport(url, { method: options.upload ? "POST" : "GET", signal, redirect: "error",
        headers: options.upload ? { "Content-Type": "application/octet-stream" } : undefined,
        body: options.upload ? new Uint8Array(options.upload.encrypted) : undefined });
    } catch { throw new ProtocolError("network"); }
    if (response.redirected || response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProtocolError("http", response.status);
    }
    if (options.upload) {
      const param = response.headers.get("x-encrypted-param");
      await response.body?.cancel().catch(() => undefined);
      if (!param) throw new ProtocolError("invalid-response");
      return { downloadParam: param };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProtocolError("invalid-response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > options.maxBytes) throw new ProtocolError("invalid-response");
        chunks.push(part.value);
      }
      return { bytes: Buffer.concat(chunks) };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error instanceof ProtocolError ? error : new ProtocolError("network");
    } finally { reader.releaseLock(); }
  }
}
