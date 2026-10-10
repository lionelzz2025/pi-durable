import { createHash, randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";

export type ApprovalRecord = { id: string; command: string; args: string[]; commandHash: string; workspace: string; expiresAt: number; state: "pending" | "approved" | "consumed" | "expired" | "rejected" };
export const Approvals = defineDoc<{ records: ApprovalRecord[] }>({ kind: "wechat.approvals", version: 1, scope: "session", initial: () => ({ records: [] }) });
const hashCommand = (command: string, args: readonly string[], workspace: string) => createHash("sha256").update(JSON.stringify([command, args, workspace])).digest("hex");
export const requestShellApproval = async (harness: Harness, command: string, args: readonly string[], workspace: string, ttlMs = 60_000): Promise<string> => {
  if (!command || args.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw Error("Invalid shell approval request");
  const id = randomBytes(24).toString("base64url");
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Approvals);
    if (doc.records.length >= 1000) throw Error("Approval capacity reached");
    doc.records.push({ id, command, args: [...args], commandHash: hashCommand(command, args, workspace), workspace, expiresAt: Date.now() + ttlMs, state: "pending" });
  }, BACKGROUND_CONTEXT);
  return id;
};
export const decideShellApproval = async (harness: Harness, id: string, approve: boolean): Promise<void> => {
  await harness.commit(async (tx) => {
    const item = (await tx.doc(Approvals)).records.find((record) => record.id === id);
    if (!item || item.state !== "pending") throw Error("Approval is not pending");
    if (item.expiresAt <= Date.now()) { item.state = "expired"; return; }
    item.state = approve ? "approved" : "rejected";
  }, BACKGROUND_CONTEXT);
};
export const consumeShellApproval = async (harness: Harness, id: string, command: string, args: readonly string[], workspace: string): Promise<void> => {
  await harness.commit(async (tx) => {
    const item = (await tx.doc(Approvals)).records.find((record) => record.id === id);
    if (!item || item.state !== "approved" || item.expiresAt <= Date.now() || item.workspace !== workspace || item.commandHash !== hashCommand(command, args, workspace)) throw Error("Shell approval missing, expired, or mismatched");
    item.state = "consumed";
  }, BACKGROUND_CONTEXT);
};
