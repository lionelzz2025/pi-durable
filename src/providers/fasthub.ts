// -----------------------------------------------------------------------------
// FastHub (novosns) — a custom OpenAI-compatible endpoint.
//
// pi-durable talks to models only through a `Models` collection, and `Models`
// only knows the providers you hand it. pi/pi-ai ship a catalog of built-in
// providers; to reach your own gateway you build a `Provider` with
// `createProvider()` and `setProvider()` it.
//
// This module mirrors the `fasthub-novosns` entry from pi's own
// `~/.pi/agent/models.json`, so one endpoint and one credential drive both pi
// and this project. Keep the two in sync when the endpoint changes.
// -----------------------------------------------------------------------------

import {
	createProvider,
	envApiKeyAuth,
	openAICompletionsApi,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai/compat";

/** Provider id. Must match what the agent's `model.provider` refers to. */
export const FASTHUB_PROVIDER_ID = "fasthub-novosns";
export const FASTHUB_BASE_URL = "https://fasthub.novosns.com/v1";
/** Env var the gateway's key is read from (same var pi uses). */
export const FASTHUB_API_KEY_ENV = "FH_NOVOSNS_API_KEY";
export const FASTHUB_FLASH_MODEL_ID = "deepseek/deepseek-v4.1-flash";

/**
 * DeepSeek V4.1 Flash behind the FastHub gateway.
 *
 * `compat` is the load-bearing part. It records **verified** differences between
 * this endpoint and the OpenAI Chat Completions spec; pi-ai auto-detects compat
 * from the base URL, and an unknown URL (like this one) falls back to
 * conservative defaults — hence the explicit flags.
 */
export const fasthubFlash: Model<"openai-completions"> = {
	id: FASTHUB_FLASH_MODEL_ID,
	name: "DeepSeek V4.1 Flash (FastHub)",
	api: "openai-completions",
	provider: FASTHUB_PROVIDER_ID,
	baseUrl: FASTHUB_BASE_URL,
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 64_000,
	// FastHub bills nothing for this model. Real per-token prices would go here
	// and would show up in `harness.usage()` / assistant-entry `usage.cost`.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: {
		// The gateway rejects the `developer` role; system instructions are sent
		// as `system` instead.
		supportsDeveloperRole: false,
		// There is no `reasoning_effort` knob to turn. Reasoning still happens
		// server-side and arrives as `reasoning_content`: measured 47 reasoning
		// tokens on an arithmetic prompt with this flag left false.
		supportsReasoningEffort: false,
		// `max_completion_tokens` is not accepted; `max_tokens` is.
		maxTokensField: "max_tokens",
		// Do NOT add `thinkingFormat: "deepseek"` here, tempting as it looks.
		// Measured against this gateway it drops reasoning tokens to 0 and leaks
		// the thinking text into the visible answer, because the endpoint already
		// emits `reasoning_content` on its own.
	},
};

/**
 * Build the FastHub provider. Auth resolves `FH_NOVOSNS_API_KEY` through the
 * ambient environment (a stored credential would win over the env var).
 */
export function fasthubProvider(): Provider<"openai-completions"> {
	// The api type argument is explicit on purpose: `openAICompletionsApi()` returns
	// the whole `ProviderStreams` map, so it infers `TApi = Api` and `setProvider`
	// then rejects the result.
	return createProvider<"openai-completions">({
		id: FASTHUB_PROVIDER_ID,
		name: "FastHub (novosns)",
		baseUrl: FASTHUB_BASE_URL,
		auth: { apiKey: envApiKeyAuth("FastHub novosns API key", [FASTHUB_API_KEY_ENV]) },
		models: [fasthubFlash],
		api: openAICompletionsApi(),
	});
}
