// -----------------------------------------------------------------------------
// 01 — Hello, Harness
//
// The smallest possible pi-durable program: one question, one answer, no
// persistence. Uses the scripted `faux` provider so it runs without any API key.
//
// Run:  npm run hello      (or: node examples/01-hello.ts)
// -----------------------------------------------------------------------------

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, type TypedEntry } from "@earendil-works/pi-durable";

// Pull the assistant text out of a committed `pi.assistant` entry. The built-in
// generation task already wrote the entry; `tx.entry()` reads it back.
const answerText = (entry: TypedEntry<never> | undefined): string => {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return "(no text)";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

// Every async call takes a Chord `Context`, which carries cancellation.
// BACKGROUND_CONTEXT never cancels.
const context = BACKGROUND_CONTEXT;

// 1. Models — the Harness talks to providers only through this collection.
//    Swap `fauxProvider()` for `openaiProvider()` / `anthropicProvider()` etc.
//    in a real app.
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
// Script the model's replies. Each entry answers one model request.
faux.setResponses([fauxAssistantMessage([fauxText("The capital of France is Paris.")])]);

// 2. Registry — the extensions (tools, prompt sections, hooks, tasks) this
//    process offers. Empty here; the Harness still has its built-ins.
const registry = createRegistry();

// 3. Harness — one open storage plus the machinery that runs agents on it.
//    MemoryStorage keeps everything in RAM and forgets it on exit.
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

// 4. Root conversation — created on first use. With durable storage, calling
//    this again after a restart returns the *same* conversation.
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});

// 5. Submit an input. This durably admits the input and returns a Submission;
//    a built-in generation task calls the model and appends the answer.
const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);

if (settled.status === "done" && settled.type === "input") {
	// `settled.answer` is the EntryId of the `pi.assistant` entry that the
	// generation task committed. Read it back through a commit transaction.
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log("answer:", answerText(entry));
} else {
	console.error("unanswered:", settled);
	process.exitCode = 1;
}

// 7. Inspect the committed transcript. `viewState()` is a read-only live view
//    of the conversation's active entries and built-in documents.
const view = await root.viewState(context);
console.log("transcript entries:", view.value.entries.map((entry) => entry.kind).join(", "));
view.dispose();

// Always close the Harness. Close is graceful: unfinished work stays pending in
// durable storage for the next open (see 04 / 05).
await harness.close(context);
