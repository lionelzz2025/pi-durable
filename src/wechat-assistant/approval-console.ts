import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { Approvals, decideShellApproval } from "./approvals.ts";

/** Same-process terminal approval. Never opens a second owner or accepts a model
 * tool's answer as human confirmation. Only active on a local TTY. */
export const runApprovalConsole = async (harness: Harness, signal: AbortSignal, terminal: {
  input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean;
} = { input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY) }): Promise<void> => {
  if (!terminal.isTTY || signal.aborted) return;
  const ui = createInterface({ input: terminal.input, output: terminal.output, terminal: true });
  const stop = () => ui.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      let line: string;
      try { line = (await ui.question("approval (list|approve ID|reject ID): ", { signal })).trim(); }
      catch { break; }
      if (line === "list") {
        const records = (await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records ?? [];
        terminal.output.write(JSON.stringify(records.filter((record) => record.state === "pending")) + "\n");
        continue;
      }
      const match = /^(approve|reject) ([A-Za-z0-9_-]{32})$/.exec(line);
      if (!match) { terminal.output.write("Unknown approval command\n"); continue; }
      const [, action, id] = match;
      const records = (await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records ?? [];
      const record = records.find((item) => item.id === id && item.state === "pending" && item.expiresAt > Date.now());
      if (!record) { terminal.output.write("Approval is not pending\n"); continue; }
      terminal.output.write(JSON.stringify({ id: record.id, command: record.command, args: record.args,
        workspace: record.workspace, expiresAt: record.expiresAt }) + "\n");
      let confirmation: string;
      try { confirmation = await ui.question(`Type ${action} ${id} to confirm: `, { signal }); }
      catch { break; }
      if (confirmation !== `${action} ${id}`) { terminal.output.write("Approval not confirmed\n"); continue; }
      await decideShellApproval(harness, id!, action === "approve");
      terminal.output.write("Decision recorded\n");
    }
  } finally { signal.removeEventListener("abort", stop); ui.close(); }
};
