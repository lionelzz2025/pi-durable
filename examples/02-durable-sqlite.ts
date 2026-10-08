// -----------------------------------------------------------------------------
// 02 — Persist and resume with SQLite
//
// Build one conversation, then have a *later Harness lifetime* replay it and
// continue it. Nothing of phase 1 is kept in memory: the transcript lives in a
// SQLite file.
//
// History replay comes for free — the generation task for the follow-up reads
// the whole transcript (both earlier turns) from storage.
//
// Run:  npm run durable      (or: node examples/02-durable-sqlite.ts)
// -----------------------------------------------------------------------------

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	createRegistry,
	type Harness,
	Harness as HarnessCtor,
	type Conversation,
	type TypedEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const databasePath = join(here, "..", "data", "conversation.sqlite");
await mkdir(dirname(databasePath), { recursive: true });

const answerText = (entry: TypedEntry<never> | undefined): string => {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return "(no text)";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

// Open a fresh Harness over the same database file. `models` and `registry` are
// process concerns; storage is the durable part.
const openHarness = async (): Promise<{ faux: ReturnType<typeof fauxProvider>; harness: Harness }> => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const harness = await HarnessCtor.open(
		await openNodeSqliteStorage(databasePath),
		{ models, registry: createRegistry() },
		context,
	);
	return { faux, harness };
};

// Ask one question and return the model's answer text. The built-in generation
// task writes both `pi.user` and `pi.assistant`; we only read the answer back.
const ask = async (root: Conversation, question: string): Promise<string> => {
	const settled = await (await root.submit({ type: "input", content: question }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") return `(unanswered: ${settled.status})`;
	return answerText(await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context));
};

// --- Phase 1: create the conversation, ask one question ----------------------
const MODEL = { provider: "faux", modelId: "faux-1" } as const;
{
	const { faux, harness } = await openHarness();
	faux.setResponses([fauxAssistantMessage([fauxText("My name is Pi.")])]);

	const root = await harness.root(context, { agent: { model: MODEL } });
	console.log("[phase 1] answer:", await ask(root, "What is your name?"));

	await harness.close(context);
	console.log("[phase 1] closed. Transcript on disk:", databasePath);
}

// --- Phase 2: brand new Harness, same file, same conversation ----------------
{
	const { faux, harness } = await openHarness();
	// The model quotes a fact from the transcript, which only exists on disk.
	faux.setResponses([fauxAssistantMessage([fauxText("You told me your name was Pi.")])]);

	const root = await harness.root(context); // the SAME conversation as phase 1
	console.log("[phase 2] found prior transcript:", (await root.entries({}, 10, undefined, context)).items.map((e) => e.kind).join(", "));
	console.log("[phase 2] answer:", await ask(root, "Do you remember what you told me?"));

	await harness.close(context);
}
