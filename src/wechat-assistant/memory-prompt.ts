import { section } from "@earendil-works/pi-durable";
import { MemoryStore, renderMemoryPrompt } from "./memory.ts";

/** Injects active memories under a byte budget. Reading is a committed snapshot, so
 * the block reflects exactly the state at request preparation and never a partial
 * write. Returns `undefined` (no section) when nothing is stored. */
export const memorySection = (budgetBytes: number) =>
  section("wechat_memory", async (input, context) => {
    const store = await input.read.snapshot(MemoryStore, context);
    return renderMemoryPrompt(store?.entries ?? [], budgetBytes);
  });
