// -----------------------------------------------------------------------------
// 04 — Coding tools (read / write / edit / bash)
//
// How to give an agent real file and shell access:
//   * `CodingTools` is an extension bundling `read`, `write`, `edit`, `bash`.
//   * Tools touch the world only through the call's `ExecutionEnv`, which
//     `HarnessOptions.env` builds per call via `NodeExecutionEnv`.
//   * Each tool call runs as its own durable task, owned by the generation task.
//
// The scripted model calls `read` on package.json, then answers from the result.
//
// Run:  npm run tools      (or: node examples/04-coding-tools.ts)
// -----------------------------------------------------------------------------

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	createRegistry,
	Harness,
	MemoryStorage,
	type TypedEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const context = BACKGROUND_CONTEXT;
const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const answerText = (entry: TypedEntry<never> | undefined): string => {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return "(no text)";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

// 1. Registry with the coding tools installed. By default every conversation
//    selects every installed extension, so this is the only wiring needed.
const registry = createRegistry();
registry.install(CodingTools);

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 2. The model's script for this run. `stopReason: "toolUse"` tells the
//    generation task there are tool calls to run before asking the model again.
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("package.json declares @earendil-works/pi-durable as its runtime dependency.")]),
]);

// 3. `env` builds the filesystem/shell environment for each call. Swap
//    `NodeExecutionEnv` for a container-backed env to sandbox the agent.
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, env: () => new NodeExecutionEnv({ cwd: projectDir }) },
	context,
);

const root = await harness.root(context, {
	agent: {
		model: { provider: "faux", modelId: "faux-1" },
		instructions: "You are a concise coding assistant. Use tools to answer.",
	},
});

// Show what the resolved agent offers: tools, extensions, prompt sections.
const agent = await root.agent(context);
console.log("offered tools:", agent.tools.map((tool) => tool.name).join(", "));
console.log("prompt sections:", agent.sections.map((section) => section.key).join(", "));

const settled = await (
	await root.submit({ type: "input", content: "What dependency does this project declare?" }, context)
).wait(context);

if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log("answer:", answerText(entry));
} else {
	console.error("unanswered:", settled);
	process.exitCode = 1;
}

// The tool call and its result are durable transcript entries too:
// pi.user -> pi.assistant (tool call) -> pi.tool-result -> pi.assistant (answer)
const view = await root.context(context);
console.log("transcript:", view.entries.map((entry) => entry.kind).join(" -> "));
console.log("model messages:", view.messages.length);

await harness.close(context);
