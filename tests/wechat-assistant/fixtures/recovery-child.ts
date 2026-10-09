import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openWechatHarness } from "../../../src/wechat-assistant/runtime.ts";

const [databasePath, mode, marker] = process.argv.slice(2);
if (!databasePath || !mode || !marker) throw new Error("missing fixture arguments");
const context = BACKGROUND_CONTEXT;
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const registry = createRegistry();
const Effects = defineDoc<{ ids: string[] }>({
  kind: "test.wechat-effects", version: 1, scope: "session", initial: () => ({ ids: [] }),
});
const waitForever = (): Promise<never> => new Promise(() => { setInterval(() => {}, 1_000); });
const emit = (value: unknown): void => { console.log(JSON.stringify(value)); };
const tool = defineTool({
  name: "effect", description: "Test crash recovery", parameters: Type.Object({}),
  replay: mode.includes("unsafe") ? "unsafe" : "safe",
  execute: async (_args, api) => {
    if (mode.includes("unsafe")) {
      await appendFile(marker, "external-effect\n");
    } else {
      await api.commit(async (tx) => {
        const doc = await tx.doc(Effects);
        if (!doc.ids.includes(String(api.taskId))) doc.ids.push(String(api.taskId));
      }, context);
    }
    if (mode.startsWith("crash")) {
      emit({ event: "effect-committed" });
      await waitForever();
    }
    return { content: [{ type: "text", text: "effect complete" }] };
  },
});
registry.install(defineExtension({ name: "test-effects", tools: [tool] }));
if (mode === "crash-model") {
  faux.setResponses([async () => {
    emit({ event: "model-started" });
    return await waitForever();
  }]);
} else if (mode.startsWith("crash")) {
  faux.setResponses([fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" })]);
} else {
  faux.setResponses([fauxAssistantMessage("recovered answer")]);
}
await mkdir(dirname(databasePath), { recursive: true });
const harness = await openWechatHarness(databasePath, { models, registry });
try {
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  if (mode === "hold") {
    emit({ event: "holding", conversationId: root.id });
    await waitForever();
  } else {
    const submission = await root.submit({ type: "input", content: "recover me", requestId: "stable-request" }, context);
    emit({ event: "admitted", conversationId: root.id, submissionId: submission.id });
    if (mode === "recover") harness.resume();
    const result = await submission.wait(context);
    const entries = await root.entries({ order: "ascending" }, 100, undefined, context);
    const effects = await harness.snapshot(Effects, context);
    const view = await root.viewState(context);
    emit({ event: "settled", conversationId: root.id, submissionId: submission.id,
      result, entries: entries.items, effects: effects?.ids ?? [], provider: view.value.docs["pi.provider"] });
    view.dispose();
  }
} finally {
  await harness.close(context);
}
