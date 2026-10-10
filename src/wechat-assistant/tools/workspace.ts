import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { workspaceRead, workspaceWrite, type WorkspacePolicy } from "../workspace.ts";
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
export const workspaceTools = (policy: WorkspacePolicy) => [
  defineTool({ name: "workspace_read", description: "Read a UTF-8 file inside the configured workspace.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }), replay: "safe", execute: async (raw) => text(await workspaceRead(policy, (raw as { path: string }).path)) }),
  defineTool({ name: "workspace_write", description: "Create or replace a UTF-8 file in the configured workspace.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), content: Type.String({ maxLength: policy.maxBytes }) }), replay: "unsafe", execute: async (raw) => { const args = raw as { path: string; content: string }; return text(JSON.stringify({ sha256: await workspaceWrite(policy, args.path, args.content) })); } }),
  defineTool({ name: "workspace_edit", description: "Replace exact text in a workspace file; requires its current SHA-256 to avoid lost updates.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), oldText: Type.String({ minLength: 1 }), newText: Type.String(), expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }), replay: "unsafe", execute: async (raw) => {
    const args = raw as { path: string; oldText: string; newText: string; expectedSha256: string };
    const current = await workspaceRead(policy, args.path);
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(current).digest("hex") !== args.expectedSha256) throw Error("Workspace edit conflict");
    if (current.indexOf(args.oldText) < 0 || current.indexOf(args.oldText) !== current.lastIndexOf(args.oldText)) throw Error("Edit target must match exactly once");
    const updated = current.replace(args.oldText, args.newText);
    return text(JSON.stringify({ sha256: await workspaceWrite(policy, args.path, updated, args.expectedSha256) }));
  } }),
];
