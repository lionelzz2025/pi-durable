import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Harness } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { consumeShellApproval, requestShellApproval } from "../approvals.ts";
import type { WorkspacePolicy } from "../workspace.ts";
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const parseArgs = (value: string): string[] => {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw Error("Arguments must be a JSON array of strings"); }
  if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some((item) => typeof item !== "string" || item.length > 4096 || item.includes("\0"))) throw Error("Invalid shell arguments");
  return parsed;
};
const argsSchema = { argsJson: Type.String({ maxLength: 16384, description: "JSON array of argument strings" }) };
export const shellTools = (harness: Harness, policy: WorkspacePolicy, enabled: boolean) => [
  defineTool({ name: "shell_request_approval", description: "Request persistent one-time approval for an exact command and argument list.", parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 256 }), ...argsSchema, ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })) }), replay: "unsafe", execute: async (raw) => {
    if (!enabled) return text("Shell execution is disabled by local configuration.");
    const a = raw as { command: string; argsJson: string; ttlMs?: number };
    return text(JSON.stringify({ approvalId: await requestShellApproval(harness, a.command, parseArgs(a.argsJson), policy.root, a.ttlMs) }));
  } }),
  defineTool({ name: "shell_execute_approved", description: "Execute a previously approved exact command once inside the configured working directory. This is not a sandbox.", parameters: Type.Object({ approvalId: Type.String(), command: Type.String(), ...argsSchema }), replay: "unsafe", execute: async (raw) => {
    if (!enabled) return text("Shell execution is disabled by local configuration.");
    const a = raw as { approvalId: string; command: string; argsJson: string };
    const args = parseArgs(a.argsJson);
    if (/[\\/]/.test(a.command) || a.command === "." || a.command === "..") throw Error("Shell command must be a PATH-resolved executable name");
    const cwd = resolve(policy.root);
    await consumeShellApproval(harness, a.approvalId, a.command, args, cwd);
    return await new Promise<ReturnType<typeof text>>((resolvePromise) => {
      const child = spawn(a.command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; let size = 0;
      const collect = (target: "out" | "err", chunk: Buffer) => { size += chunk.length; if (size <= 64 * 1024) target === "out" ? out += chunk.toString("utf8") : err += chunk.toString("utf8"); else child.kill(); };
      child.stdout.on("data", (chunk: Buffer) => collect("out", chunk)); child.stderr.on("data", (chunk: Buffer) => collect("err", chunk));
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on("error", (error) => { clearTimeout(timer); resolvePromise(text(`Execution failed after approval consumed: ${error.message}`)); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolvePromise(text(JSON.stringify({ code, signal, stdout: out, stderr: err, note: "Local approval is not a sandbox; external side effects may be unknown." }))); });
    });
  } }),
];
