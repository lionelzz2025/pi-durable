// -----------------------------------------------------------------------------
// 03 — Kill mid-run, then resume
//
// The headline durability feature. Phase 1 admits an input and then closes the
// Harness *without waiting*, i.e. the process "dies" mid-run. Phase 2 is a fresh
// Harness over the same file: it finds the unfinished run and finishes it.
//
// A real crash is no different from the explicit close below — durable storage
// only ever loses the last uncommitted instant.
//
// Run:  npm run crash      (or: node examples/03-crash-resume.ts)
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
	type SubmissionId,
	type TypedEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const databasePath = join(here, "..", "data", "crash.sqlite");
await mkdir(dirname(databasePath), { recursive: true });

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

const answerText = (entry: TypedEntry<never> | undefined): string => {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return "(no text)";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

const MODEL = { provider: "faux", modelId: "faux-1" } as const;
const REQUEST_ID = "q-2+2"; // idempotency key for this question

// --- Phase 1: admit the input, then die before it is answered -----------------
let submissionId: SubmissionId;
{
	const { harness } = await openHarness();
	const root = await harness.root(context, { agent: { model: MODEL } });

	// `requestId` makes admission idempotent: re-submitting the same ID after a
	// restart returns this same submission instead of asking twice.
	const submission = await root.submit({ type: "input", content: "What is 2+2?", requestId: REQUEST_ID }, context);
	submissionId = submission.id;
	console.log("[phase 1] admitted submission:", submission.id);

	// Close without waiting. A crash leaves the same state: the input is
	// committed, the answer is not.
	await harness.close(context);
	console.log("[phase 1] closed mid-run — the input is committed, the answer is not");
}

// --- Phase 2: new Harness, same file, finish the interrupted run -------------
{
	const { faux, harness } = await openHarness();
	faux.setResponses([fauxAssistantMessage([fauxText("4")])]);

	const root = await harness.root(context);

	// The same request ID finds the *existing* submission, not a new one.
	const same = await root.submit({ type: "input", content: "What is 2+2?", requestId: REQUEST_ID }, context);
	console.log("[phase 2] requestId is idempotent:", same.id === submissionId);

	// resume() starts the task scheduler; unfinished work runs again.
	harness.resume();
	const inspection = await harness.inspect(context);
	console.log("[phase 2] scheduler:", inspection.scheduling, "| live submissions:", inspection.submissions.length);

	// Reacquire the submission by ID and wait for the recovered answer.
	const submission = await harness.submission(submissionId, context);
	if (submission === undefined) throw new Error("submission lost after reopen");
	const settled = await submission.wait(context);

	if (settled.status === "done" && settled.type === "input") {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		console.log("[phase 2] recovered answer:", answerText(entry));
	} else {
		console.error("[phase 2] not done:", settled);
		process.exitCode = 1;
	}
	await harness.close(context);
}
