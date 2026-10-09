// Harness owns the Storage and its one Session; never open a second Session.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openExclusiveAssistantStorage } from "../assistant/storage.ts";

export const openWechatHarness = async (
  databasePath: string,
  options: HarnessOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Harness> => {
  const storage = await openExclusiveAssistantStorage(databasePath, { context });
  try {
    return await Harness.open(storage, options, context);
  } catch (error) {
    await storage.close(context).catch(() => undefined);
    throw error;
  }
};
