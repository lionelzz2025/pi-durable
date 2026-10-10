import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { WechatApi, ProtocolError } from "./channel/api.ts";
import { WechatCdn } from "./channel/cdn.ts";
import { ChannelState } from "./documents.ts";
import { rejectSensitivePath, type WorkspacePolicy } from "./workspace.ts";

export type MediaOutbound = {
  key: string; source: string; name: string; kind: "image" | "file"; bytes: number; sha256: string;
  recipient: string; clientId: string; status: "pending" | "sending" | "sent" | "blocked" | "outcome_unknown";
  attempts: number; nextAttemptAt: number; lastError: string;
};
export const MediaOutbox = defineDoc<{ records: MediaOutbound[] }>({ kind: "wechat.media-outbox", version: 1,
  scope: "session", initial: () => ({ records: [] }) });
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const boundedSource = async (policy: WorkspacePolicy, relative: string): Promise<{ source: string; bytes: Buffer; sha256: string }> => {
  if (!relative || isAbsolute(relative) || relative.includes("\0") || relative.split(/[\\/]/).includes("..")) throw Error("Attachment path must be workspace-relative");
  rejectSensitivePath(relative);
  const root = await realpath(policy.root); const source = await realpath(resolve(root, relative));
  if (!within(root, source) || !(await stat(source)).isFile()) throw Error("Attachment outside workspace");
  const size = (await stat(source)).size;
  if (size <= 0 || size > Math.min(policy.maxBytes, 20 * 1024 * 1024)) throw Error("Attachment size outside protocol limit");
  const bytes = await readFile(source);
  if (bytes.length !== size) throw Error("Attachment changed during read");
  return { source, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};

/** Idempotency key is the durable tool call ID, not model-supplied text. */
export const enqueueMedia = async (harness: Harness, input: { key: string; relative: string; kind: "image" | "file"; policy: WorkspacePolicy; recipient: string }): Promise<string> => {
  const { source, bytes, sha256 } = await boundedSource(input.policy, input.relative);
  if (!input.key || !input.recipient) throw Error("Invalid media binding");
  const name = basename(source);
  const clientId = createHash("sha256").update(`media:${input.key}`).digest("hex").slice(0, 32);
  await harness.commit(async (tx) => {
    const outbox = await tx.doc(MediaOutbox);
    const existing = outbox.records.find((item) => item.key === input.key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.source !== source || existing.recipient !== input.recipient || existing.kind !== input.kind) throw Error("Media operation key conflict");
      return;
    }
    if (outbox.records.length >= 1000) throw Error("Media outbox capacity reached");
    outbox.records.push({ key: input.key, source, name, kind: input.kind, bytes: bytes.length, sha256,
      recipient: input.recipient, clientId, status: "pending", attempts: 0, nextAttemptAt: 0, lastError: "" });
  }, BACKGROUND_CONTEXT);
  return input.key;
};

export const mediaDeliveryStatus = async (harness: Harness, key: string): Promise<MediaOutbound | undefined> =>
  (await harness.snapshot(MediaOutbox, BACKGROUND_CONTEXT))?.records.find((item) => item.key === key);

export const recoverMediaOutbox = async (harness: Harness): Promise<void> => {
  await harness.commit(async (tx) => {
    for (const item of (await tx.doc(MediaOutbox)).records) if (item.status === "sending") {
      item.status = "outcome_unknown"; item.lastError = "process stopped during media send; delivery unknown";
    }
  }, BACKGROUND_CONTEXT);
};

/** Upload is intentionally after the sending commit; any crash/timeout there is
 * unknown, rather than automatic re-upload/re-send. No remote dedup promise. */
export const drainMediaOutbox = async (harness: Harness, services: { policy: WorkspacePolicy; api: WechatApi; cdn: WechatCdn; token: string; signal: AbortSignal }): Promise<void> => {
  const state = await harness.snapshot(MediaOutbox, BACKGROUND_CONTEXT);
  for (const candidate of state?.records ?? []) {
    if (services.signal.aborted) break;
    if (candidate.status !== "pending" || candidate.nextAttemptAt > Date.now()) continue;
    const channel = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    if (!channel?.contextToken || channel.userId !== candidate.recipient) {
      await harness.commit(async (tx) => { const item = (await tx.doc(MediaOutbox)).records.find((r) => r.key === candidate.key);
        if (item?.status === "pending") { item.status = "blocked"; item.lastError = "bound context unavailable"; } }, BACKGROUND_CONTEXT);
      continue;
    }
    let contents: Buffer;
    try {
      const found = await boundedSource(services.policy, relative(await realpath(services.policy.root), candidate.source));
      if (found.source !== candidate.source || found.sha256 !== candidate.sha256 || found.bytes.length !== candidate.bytes) throw Error("Frozen attachment changed");
      contents = found.bytes;
    } catch {
      await harness.commit(async (tx) => { const item = (await tx.doc(MediaOutbox)).records.find((r) => r.key === candidate.key);
        if (item?.status === "pending") { item.status = "blocked"; item.lastError = "frozen attachment unavailable or changed"; } }, BACKGROUND_CONTEXT);
      continue;
    }
    const claimed = await harness.commit(async (tx) => { const item = (await tx.doc(MediaOutbox)).records.find((r) => r.key === candidate.key);
      const current = await tx.doc(ChannelState);
      if (!item || item.status !== "pending") return null;
      if (!current.contextToken || current.userId !== item.recipient) {
        item.status = "blocked"; item.lastError = "bound context unavailable"; return null;
      }
      item.status = "sending"; item.attempts++; return current.contextToken; }, BACKGROUND_CONTEXT);
    if (!claimed) continue;
    try {
      const key = randomBytes(16).toString("hex");
      const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
      const encrypted = Buffer.concat([cipher.update(contents), cipher.final()]);
      const md5 = createHash("md5").update(contents).digest("hex");
      const filekey = createHash("md5").update(candidate.key).digest("hex");
      const url = await services.api.getUploadUrl(services.token, { filekey, media_type: candidate.kind === "image" ? 1 : 3,
        to_user_id: candidate.recipient, rawsize: contents.length, rawfilemd5: md5, filesize: encrypted.length, aeskey: key }, services.signal);
      if (!url.upload_param) throw Error("Protocol did not provide media upload capability");
      const upload = await services.cdn.transfer({ query: url.upload_param, signal: services.signal, maxBytes: 20971536,
        timeoutMs: 30_000, upload: { filekey, encrypted } });
      if (!upload.downloadParam) throw Error("Media upload returned no parameter");
      const media = { encrypt_query_param: upload.downloadParam, aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const };
      const item = candidate.kind === "image"
        ? { type: 2, image_item: { media, mid_size: encrypted.length } }
        : { type: 4, file_item: { media, file_name: candidate.name, len: String(contents.length) } };
      await services.api.sendMessage(services.token, candidate.recipient, claimed, candidate.clientId, [item], services.signal);
      await harness.commit(async (tx) => { const record = (await tx.doc(MediaOutbox)).records.find((r) => r.key === candidate.key);
        if (record?.status === "sending") { record.status = "sent"; record.lastError = ""; } }, BACKGROUND_CONTEXT);
    } catch (error) {
      // After a network boundary even an apparent HTTP failure may have hidden
      // upload/send side effects; only an explicit human decision can retry.
      await harness.commit(async (tx) => { const record = (await tx.doc(MediaOutbox)).records.find((r) => r.key === candidate.key);
        if (record?.status === "sending") { record.status = "outcome_unknown";
          record.lastError = error instanceof ProtocolError ? `protocol ${error.kind}` : "media send outcome unknown"; } }, BACKGROUND_CONTEXT);
    }
  }
};
