import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WeixinMessage } from "./channel/types.ts";

export type MediaReference = { kind: "image" | "file"; name: string; mime: string; bytes: number; sha256: string; path: string };
const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
export const safeMediaName = (value: string): string => {
  const name = value.replace(/[\\/]/g, "_").replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(0, 120);
  if (!name || name === "." || name === "..") throw Error("Invalid media filename");
  return name;
};
export const decryptWechatMedia = (encrypted: Buffer, keyHex: string): Buffer => {
  if (!/^[0-9a-f]{32}$/i.test(keyHex) || encrypted.length === 0 || encrypted.length % 16 !== 0) throw Error("Invalid encrypted media");
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const pad = plain.at(-1)!;
  if (pad < 1 || pad > 16 || !plain.subarray(-pad).every((b) => b === pad)) throw Error("Invalid media padding");
  return plain.subarray(0, -pad);
};

/** Decode only protocol references. No message-provided URL is fetched here. */
export const inspectWechatMedia = (message: WeixinMessage): Array<{ kind: "image" | "file"; query: string; key: string; name: string; mime: string }> => {
  const result: Array<{ kind: "image" | "file"; query: string; key: string; name: string; mime: string }> = [];
  for (const item of message.item_list ?? []) {
    if (item.type === 2) {
      const media = item.image_item?.media;
      if (media?.encrypt_query_param && media.aes_key && media.encrypt_type === 1) {
        const key = Buffer.from(media.aes_key, "base64").toString("utf8");
        if (/^[0-9a-f]{32}$/i.test(key)) result.push({ kind: "image", query: media.encrypt_query_param, key, name: "image.jpg", mime: "image/jpeg" });
      }
    } else if (item.type === 4) {
      const media = item.file_item?.media;
      const key = media?.aes_key ? Buffer.from(media.aes_key, "base64").toString("utf8") : "";
      if (media?.encrypt_query_param && media.encrypt_type === 1 && /^[0-9a-f]{32}$/i.test(key)) {
        const raw = item.file_item?.file_name ?? "attachment.bin";
        result.push({ kind: "file", query: media.encrypt_query_param, key, name: safeMediaName(raw), mime: "application/octet-stream" });
      }
    }
  }
  return result;
};

export const verifyStoredWechatMedia = async (media: MediaReference, root: string, maxBytes: number): Promise<void> => {
  const trustedRoot = await realpath(root);
  const path = await realpath(media.path);
  if (!within(trustedRoot, path) || media.bytes <= 0 || media.bytes > maxBytes ||
    !/^[0-9a-f]{64}$/i.test(media.sha256)) throw Error("Stored media outside trusted root or invalid size");
  const info = await stat(path);
  if (!info.isFile() || info.size !== media.bytes) throw Error("Stored media size changed");
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== media.sha256) throw Error("Stored media content changed");
};

export const storeWechatMedia = async (options: { bytes: Buffer; root: string; name: string; kind: "image" | "file"; maxBytes: number }): Promise<MediaReference> => {
  if (options.bytes.length === 0 || options.bytes.length > options.maxBytes) throw Error("Media size outside configured limit");
  await mkdir(options.root, { recursive: true });
  const root = await realpath(options.root);
  const name = safeMediaName(options.name);
  const path = resolve(root, `${randomBytes(16).toString("hex")}-${name}`);
  if (!within(root, path)) throw Error("Media path escapes storage root");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(options.bytes); } finally { await file.close(); }
  const saved = await realpath(path);
  if (!within(root, saved) || (await stat(saved)).size !== options.bytes.length) throw Error("Stored media integrity check failed");
  return { kind: options.kind, name, mime: options.kind === "image" ? "image/jpeg" : "application/octet-stream", bytes: options.bytes.length,
    sha256: createHash("sha256").update(options.bytes).digest("hex"), path: saved };
};
