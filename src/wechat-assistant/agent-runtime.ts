import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, HarnessOptions, ModelRef } from "@earendil-works/pi-durable";
import { requireAssistantCapabilities } from "./capabilities.ts";
import { ensureBoundConversation, submitReceivedInbox } from "./conversations.ts";
import { openWechatHarness } from "./runtime.ts";
import { reconcileInbox } from "./settlement.ts";
import { enqueueAnswers, recoverOutbox } from "./outbox.ts";
import { ChannelState } from "./documents.ts";

/** No polling before required capabilities have been checked. Provider selection
 * is supplied by the host; this entry never falls back to a global pi instance. */
export const openAssistantRuntime = async (databasePath: string, options: HarnessOptions, binding: {
  accountId: string; userId: string; model: ModelRef;
}): Promise<Harness> => {
  requireAssistantCapabilities(options.registry);
  if (!options.models.getModel(binding.model.provider, binding.model.modelId)) throw Error("Configured assistant model unavailable");
  const harness = await openWechatHarness(databasePath, options);
  try {
    const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    if (state && state.schemaVersion !== 1) throw Error("Unsupported channel schema");
    const conversation = await ensureBoundConversation(harness, binding);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    if (!agent.model || !options.models.getModel(agent.model.provider, agent.model.modelId)) throw Error("Persisted assistant model unavailable");
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const registry = options.registry.snapshot();
    for (const task of inspection.tasks) {
      if (!registry.task(task.record.kind)) throw Error("Persisted task definition unavailable");
    }
    await reconcileInbox(harness);
    // A crash may have left a send in flight (unknown) or an answer without an
    // outbox record; recover before admitting new work, then enqueue any answers.
    await recoverOutbox(harness);
    await enqueueAnswers(harness, { recipient: binding.userId });
    await submitReceivedInbox(harness);
    harness.resume();
    return harness;
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
};
