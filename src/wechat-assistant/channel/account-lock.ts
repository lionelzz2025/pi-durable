import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openExclusiveAssistantStorage } from "../../assistant/storage.ts";

// Deliberately independent of the assistant's dataDir. All new instances on this
// OS user must use this canonical location. The legacy plugin does not obey it.
export const ACCOUNT_LOCK_ROOT = join(homedir(), ".pi-durable", "wechat-account-locks");
export const acquireAccountLock = async (accountId: string, lockRoot = ACCOUNT_LOCK_ROOT): Promise<() => Promise<void>> => {
  if (!accountId.trim()) throw new Error("Invalid account ID");
  await mkdir(lockRoot, { recursive: true });
  const key = createHash("sha256").update(accountId).digest("hex");
  const storage = await openExclusiveAssistantStorage(join(lockRoot, `${key}.sqlite`));
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await storage.close(BACKGROUND_CONTEXT);
  };
};
