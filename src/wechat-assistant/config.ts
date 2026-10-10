import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_CONFIG = resolve(PROJECT_ROOT, "data/wechat-assistant/config.json");
export const DEFAULT_LIMITS = Object.freeze({
  messageBytes: 32768, attachmentBytes: 20971520, downloadTimeoutMs: 60000,
  inboxPending: 100, outboxPending: 1000, concurrentConversations: 1,
  runTimeoutMs: 600000, modelRetries: 2, modelOutputTokens: 4096,
  runModelRequests: 20, dailyCostUsd: 5, memoryPromptBytes: 8192, sendAttempts: 5,
});
export type WechatLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };
export interface WechatConfig {
  schemaVersion: 1;
  dataDir: string;
  workspaceDir: string;
  accountId: string;
  boundUserId: string;
  model: { provider: string; modelId: string };
  shell: { enabled: boolean };
  limits: WechatLimits;
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\r\n\0]/.test(value);
export const loadWechatConfig = async (path = DEFAULT_CONFIG): Promise<WechatConfig> => {
  if (!isAbsolute(path)) throw new Error("Config path must be absolute");
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read valid WeChat config JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WeChat config");
  const c = value as Record<string, unknown>;
  const model = c.model as Record<string, unknown> | undefined;
  const shell = c.shell as Record<string, unknown> | undefined;
  const allowed = ["schemaVersion", "dataDir", "workspaceDir", "accountId", "boundUserId", "model", "shell", "limits"];
  if (Object.keys(c).some((key) => !allowed.includes(key)) || c.schemaVersion !== 1 ||
    !text(c.dataDir) || !text(c.workspaceDir) || !text(c.accountId) || !text(c.boundUserId) ||
    !model || !text(model.provider) || !text(model.modelId) ||
    (shell !== undefined && (!shell || typeof shell.enabled !== "boolean"))) throw new Error("Invalid WeChat config fields");
  const limits: WechatLimits = { ...DEFAULT_LIMITS };
  if (c.limits !== undefined) {
    if (!c.limits || typeof c.limits !== "object" || Array.isArray(c.limits)) throw new Error("Invalid limits");
    for (const [key, limit] of Object.entries(c.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key) || typeof limit !== "number" || !Number.isFinite(limit) ||
        (key === "modelRetries" ? limit < 0 : limit <= 0) ||
        (key !== "dailyCostUsd" && !Number.isSafeInteger(limit))) throw new Error("Invalid limits");
      limits[key as keyof WechatLimits] = limit;
    }
  }
  if (limits.concurrentConversations !== 1) throw new Error("Only one concurrent conversation is supported");
  const workspaceDir = resolve(dirname(path), c.workspaceDir);
  return { schemaVersion: 1, dataDir: resolve(dirname(path), c.dataDir), workspaceDir,
    accountId: c.accountId, boundUserId: c.boundUserId, model: { provider: model.provider, modelId: model.modelId }, shell: { enabled: shell?.enabled === true }, limits };
};
