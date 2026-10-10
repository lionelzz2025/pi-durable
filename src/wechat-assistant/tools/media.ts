import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { WechatCdn } from "../channel/cdn.ts";
import { decryptWechatMedia, inspectWechatMedia, storeWechatMedia, type MediaReference } from "../media.ts";
import type { WeixinMessage } from "../channel/types.ts";
import type { WorkspacePolicy } from "../workspace.ts";
import type { Harness } from "@earendil-works/pi-durable";
import { enqueueMedia, mediaDeliveryStatus } from "../media-outbox.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
export const downloadAndStoreWechatMedia = async (options: {
  query: string; key: string; name: string; kind: "image" | "file"; maxBytes: number;
  expectedBytes?: number; root: string; cdn: WechatCdn; signal: AbortSignal;
}): Promise<MediaReference> => {
  if (!/^[A-Za-z0-9_=-]{8,4096}$/.test(options.query)) throw Error("Invalid encrypted media reference");
  // PKCS#7 adds one full block when plaintext is already block-aligned.
  // Bound ciphertext separately; the decrypted size is checked by storage.
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > 20 * 1024 * 1024) throw Error("Invalid media size limit");
  const encryptedLimit = Math.ceil((options.maxBytes + 1) / 16) * 16;
  const result = await options.cdn.transfer({ query: options.query, signal: options.signal, maxBytes: encryptedLimit, timeoutMs: 30_000 });
  if (!result.bytes) throw Error("Media download returned no bytes");
  const bytes = decryptWechatMedia(result.bytes, options.key);
  if (options.expectedBytes !== undefined && bytes.length !== options.expectedBytes) throw Error("Downloaded file size differs from declared size");
  return storeWechatMedia({ bytes, root: options.root, name: options.name, kind: options.kind, maxBytes: options.maxBytes });
};

export const materializeInboundMedia = async (message: WeixinMessage, options: { root: string; maxBytes: number; cdn: WechatCdn; signal: AbortSignal }): Promise<MediaReference[]> => {
  const references: MediaReference[] = [];
  for (const media of inspectWechatMedia(message)) references.push(await downloadAndStoreWechatMedia({ ...media, root: options.root, maxBytes: options.maxBytes, cdn: options.cdn, signal: options.signal }));
  return references;
};

export const mediaTools = (mediaRoot: string, services?: { harness: Harness; recipient: string; workspace: WorkspacePolicy }) => [
  defineTool({ name: "media_send_file", description: "Queue a workspace file or image to the bound user. Queued does not mean delivered; inspect delivery status.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), kind: Type.Union([Type.Literal("image"), Type.Literal("file")]) }), replay: "unsafe", execute: async (raw, api) => {
    if (!services) return text("File sending is unavailable: durable media outbox is not configured.");
    const args = raw as { path: string; kind: "image" | "file" };
    const key = await enqueueMedia(services.harness, { key: String(api.callId), relative: args.path, kind: args.kind,
      policy: services.workspace, recipient: services.recipient });
    return text(JSON.stringify({ key, status: "queued", delivered: false }));
  } }),
  defineTool({ name: "media_delivery_status", description: "Inspect persisted media delivery status. Queued or protocol-accepted is not recipient delivery.", parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 256 }) }), replay: "safe", execute: async (raw) => {
    if (!services) return text("Media outbox is not configured.");
    const record = await mediaDeliveryStatus(services.harness, (raw as { key: string }).key);
    if (!record || record.recipient !== services.recipient) return text("Media operation not found");
    return text(JSON.stringify({ key: record.key, status: record.status, attempts: record.attempts, reason: record.lastError || undefined }));
  } }),
];
