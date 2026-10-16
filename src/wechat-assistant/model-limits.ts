import type { Models } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { maximumRequestCost, reserveNonGenerationCost, settleNonGenerationCost } from "./run-admission.ts";
import { RequestMarkerGate } from "./request-gate.ts";
import type { WechatLimits } from "./config.ts";

/** The Harness only sees this bounded model catalog. Clamping at the model
 * boundary also applies to generation retries and compaction calls. With a
 * request gate the model cannot be reached after an admission hook failure. */
export const boundedModels = (models: Models, limits: Pick<WechatLimits, "modelOutputTokens" | "runTimeoutMs" | "modelRetries" | "dailyCostUsd">,
  gate?: RequestMarkerGate, owner?: () => Harness): Models =>
  new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple" || property === "stream") {
        return (model: Parameters<Models["streamSimple"]>[0], context: Parameters<Models["streamSimple"]>[1],
          options?: Parameters<Models["streamSimple"]>[2]) => {
          const bounded = { ...options,
            maxTokens: Math.min(options?.maxTokens ?? limits.modelOutputTokens, limits.modelOutputTokens),
            timeoutMs: Math.min(options?.timeoutMs ?? limits.runTimeoutMs, limits.runTimeoutMs),
            maxRetries: Math.min(options?.maxRetries ?? limits.modelRetries, limits.modelRetries),
          };
          const admitted = gate ? gate.claim(context, model) : context;
          return property === "streamSimple"
            ? target.streamSimple(model, admitted, bounded)
            : target.stream(model, admitted, bounded);
        };
      }
      if (property === "completeSimple" && owner) {
        return async (model: Parameters<Models["completeSimple"]>[0], context: Parameters<Models["completeSimple"]>[1],
          options?: Parameters<Models["completeSimple"]>[2]) => {
          const quote = maximumRequestCost(model, limits.modelOutputTokens) * (limits.modelRetries + 1);
          const day = await reserveNonGenerationCost(owner(), limits, quote, BACKGROUND_CONTEXT);
          const bounded = { ...options,
            maxTokens: Math.min(options?.maxTokens ?? limits.modelOutputTokens, limits.modelOutputTokens),
            timeoutMs: Math.min(options?.timeoutMs ?? limits.runTimeoutMs, limits.runTimeoutMs),
            maxRetries: Math.min(options?.maxRetries ?? limits.modelRetries, limits.modelRetries) };
          const message = await target.completeSimple(model, context, bounded);
          await settleNonGenerationCost(owner(), day, quote, message, BACKGROUND_CONTEXT);
          return message;
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
