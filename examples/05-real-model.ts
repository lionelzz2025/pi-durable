// -----------------------------------------------------------------------------
// 05 — A real model, durably
//
// Examples 01–04 use the scripted `faux` provider so they stay deterministic and
// key-free. This one talks to a real endpoint: DeepSeek V4.1 Flash behind the
// FastHub (novosns) gateway — the same model and credential pi itself runs on.
// See ../src/providers/fasthub.ts for the provider definition.
//
// It keeps example 02's shape (ask, close, reopen, continue) on purpose: with a
// real model, "this transcript came back from disk" is a real claim rather than
// a scripted one.
//
// Needs:  FH_NOVOSNS_API_KEY in the environment.
// Run:    npm run real      (or: node examples/05-real-model.ts)
// -----------------------------------------------------------------------------

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	type Harness,
	Harness as HarnessCtor,
	type TypedEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	FASTHUB_API_KEY_ENV,
	FASTHUB_FLASH_MODEL_ID,
	FASTHUB_PROVIDER_ID,
	fasthubProvider,
} from "../src/providers/fasthub.ts";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const databasePath = join(here, "..", "data", "real-model.sqlite");
await mkdir(dirname(databasePath), { recursive: true });

if (!process.env[FASTHUB_API_KEY_ENV]) {
	console.error(`Missing ${FASTHUB_API_KEY_ENV} — this example calls a real endpoint.`);
	process.exit(1);
}

const MODEL = { provider: FASTHUB_PROVIDER_ID, modelId: FASTHUB_FLASH_MODEL_ID };

const answerText = (entry: TypedEntry<never> | undefined): string => {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return "(no text)";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

// The only difference from the faux examples: `fasthubProvider()` replaces
// `fauxProvider()`. Everything downstream of `models` is identical.
const openHarness = async (): Promise<Harness> => {
	const models = createModels();
	models.setProvider(fasthubProvider());
	return await HarnessCtor.open(
		await openNodeSqliteStorage(databasePath),
		{ models, registry: createRegistry() },
		context,
	);
};

const ask = async (root: Conversation, question: string): Promise<string> => {
	const settled = await (await root.submit({ type: "input", content: question }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") return `(unanswered: ${settled.status})`;
	return answerText(await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context));
};

// --- Phase 1: first turn against the real endpoint ---------------------------
{
	const harness = await openHarness();
	const root = await harness.root(context, {
		agent: { model: MODEL, instructions: "Answer in one short sentence." },
	});
	console.log(`[phase 1] model: ${FASTHUB_PROVIDER_ID} / ${FASTHUB_FLASH_MODEL_ID}`);
	console.log("[phase 1] answer:", await ask(root, "My name is Pi. Remember it."));

	await harness.close(context);
	console.log("[phase 1] closed. Transcript on disk:", databasePath);
}

// --- Phase 2: fresh Harness, same file, real history replay ------------------
{
	const harness = await openHarness();
	const root = await harness.root(context); // the SAME conversation as phase 1

	// These entries were never in this process's memory: they were read back from
	// SQLite, which is what the real model is now answering from.
	const history = await root.entries({}, 10, undefined, context);
	console.log("[phase 2] replayed from disk:", history.items.map((entry) => entry.kind).join(", "));
	console.log("[phase 2] answer:", await ask(root, "What name did I tell you?"));

	// Spend is tracked per conversation, keyed by `provider/modelId`, in `pi.usage`.
	const usage = await harness.usage(context);
	console.log("[phase 2] usage:", JSON.stringify(usage.models));

	await harness.close(context);
}
