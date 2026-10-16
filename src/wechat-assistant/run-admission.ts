import { AgentDoc, defineDoc, GenerationTask, hook, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { WechatLimits } from "./config.ts";
import { RequestMarkerGate } from "./request-gate.ts";

/** Task-scoped rather than conversation-scoped: tool rounds and retries share
 * one generation task ID. A crash after admission consumes one conservative
 * slot, so recovery cannot create an uncounted provider request. */
export const RunAdmission = defineDoc<{ startedAt: number; requests: number; day: string | null; reservedUsd: number }>({
  kind: "wechat.run-admission", version: 1, scope: "task", initial: () => ({ startedAt: 0, requests: 0, day: null, reservedUsd: 0 }),
});
export const DailyModelCost = defineDoc<{ days: Record<string, number> }>({
  kind: "wechat.daily-model-cost", version: 1, scope: "session", initial: () => ({ days: {} }),
});

/** Cost catalog rates are USD per million tokens. Pessimistically reserve a
 * whole context window at the largest input/cache tier plus capped output.
 * Unknown non-faux prices are not safe to interpret as free. */
export const maximumRequestCost = (model: Model<string>, outputTokens: number): number => {
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  const values = rates.flatMap((rate) => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite]);
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) throw Error("Invalid model price catalog");
  if (values.every((value) => value === 0) && model.provider !== "faux") throw Error("Model price unavailable; daily cost budget cannot be enforced");
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) throw Error("Invalid model context window");
  return (model.contextWindow * Math.max(...rates.map((rate) => Math.max(rate.input * 2, rate.cacheRead, rate.cacheWrite, rate.input)))
    + outputTokens * Math.max(...rates.map((rate) => rate.output))) / 1_000_000;
};

export const admitModelRequest = async (harness: Harness, taskId: TaskId,
  limits: Pick<WechatLimits, "runTimeoutMs" | "runModelRequests" | "dailyCostUsd" | "modelRetries">, context: Context,
  reservedUsd = 0, now = Date.now()): Promise<number> =>
  harness.commit(async (tx) => {
    const state = await tx.doc(RunAdmission, taskId);
    if (state.startedAt === 0) state.startedAt = now;
    if (now - state.startedAt >= limits.runTimeoutMs) throw Error("Run time limit reached before model request");
    const attempts = limits.modelRetries + 1;
    if (state.requests + attempts > limits.runModelRequests) throw Error("Run model request limit reached");
    const day = new Date(now).toISOString().slice(0, 10);
    const ledger = await tx.doc(DailyModelCost);
    if ((ledger.days[day] ?? 0) + reservedUsd > limits.dailyCostUsd + 1e-9) throw Error("Daily model cost budget exhausted");
    ledger.days[day] = (ledger.days[day] ?? 0) + reservedUsd;
    state.day = day; state.reservedUsd = reservedUsd;
    state.requests += attempts;
    return state.requests;
  }, context);

export const settleModelCost = async (harness: Harness, taskId: TaskId, message: AssistantMessage, context: Context): Promise<void> => {
  await harness.commit(async (tx) => {
    const state = await tx.doc(RunAdmission, taskId);
    if (state.day === null) return;
    const ledger = await tx.doc(DailyModelCost);
    const actual = message.usage.cost.total;
    // Reservations are conservative: internal provider retries may have spent
    // money even when only the final response reports usage. Never refund a
    // reservation on a successful response without per-attempt usage proof.
    const extra = Number.isFinite(actual) && actual >= 0 ? Math.max(0, actual - state.reservedUsd) : 0;
    ledger.days[state.day] = (ledger.days[state.day] ?? 0) + extra;
    state.day = null; state.reservedUsd = 0;
  }, context);
};

export const reserveNonGenerationCost = async (harness: Harness, limits: Pick<WechatLimits, "dailyCostUsd">,
  reservedUsd: number, context: Context, now = Date.now()): Promise<string> => {
  const day = new Date(now).toISOString().slice(0, 10);
  await harness.commit(async (tx) => {
    const ledger = await tx.doc(DailyModelCost);
    if ((ledger.days[day] ?? 0) + reservedUsd > limits.dailyCostUsd + 1e-9) throw Error("Daily model cost budget exhausted");
    ledger.days[day] = (ledger.days[day] ?? 0) + reservedUsd;
  }, context);
  return day;
};

export const settleNonGenerationCost = async (harness: Harness, day: string, reservedUsd: number,
  message: AssistantMessage, context: Context): Promise<void> => {
  await harness.commit(async (tx) => {
    const ledger = await tx.doc(DailyModelCost);
    const actual = message.usage.cost.total;
    ledger.days[day] = (ledger.days[day] ?? 0)
      + (Number.isFinite(actual) && actual >= 0 ? Math.max(actual, reservedUsd) - reservedUsd : 0);
  }, context);
};

export const modelAdmissionHook = (harness: Harness, limits: Pick<WechatLimits, "runTimeoutMs" | "runModelRequests" | "dailyCostUsd" | "modelOutputTokens" | "modelRetries">,
  gate?: RequestMarkerGate) =>
  hook(GenerationTask, { beforeRequest: async (request, api, context) => {
    const agent = await api.snapshot(AgentDoc, api.conversationId, context);
    const ref = agent?.model;
    const model = ref && api.models.getModel(ref.provider, ref.modelId);
    if (!model) throw Error("Configured assistant model unavailable for cost admission");
    const reserved = maximumRequestCost(model, limits.modelOutputTokens) * (limits.modelRetries + 1);
    await admitModelRequest(harness, api.taskId, limits, context, reserved);
    return gate?.mark(request.messages, model);
  }, afterResponse: async (message, api, context) => {
    await settleModelCost(harness, api.taskId, message, context);
  } });
