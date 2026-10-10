import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspacePolicy = { root: string; maxBytes: number };
const within = (root: string, target: string) => target === root || target.startsWith(root + sep);
/** Deny common credential locations even when an operator points the workspace
 * at a project root. This is not a content classifier or OS sandbox. */
export const rejectSensitivePath = (input: string): void => {
  const parts = input.split(/[\\/]/).map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws" || part === ".gnupg" ||
    part === ".pi" || part === "credentials.json" || part === "credentials.sqlite" ||
    part === ".env" || part.startsWith(".env.") || /\.(?:pem|p12|pfx|key)$/i.test(part))) {
    throw Error("Sensitive workspace path is not available");
  }
};
export const resolveWorkspacePath = async (policy: WorkspacePolicy, input: string, mustExist = false): Promise<string> => {
  if (!input || input.includes("\0") || isAbsolute(input)) throw Error("Workspace path must be relative");
  rejectSensitivePath(input);
  const root = await realpath(policy.root);
  const candidate = resolve(root, input);
  if (!within(root, candidate)) throw Error("Workspace path escapes configured root");
  const rel = relative(root, candidate);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw Error("Workspace symlinks are not allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || mustExist) throw error;
      break;
    }
  }
  if (mustExist) {
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw Error("Workspace path escapes configured root");
    return actual;
  }
  return candidate;
};
export const workspaceRead = async (policy: WorkspacePolicy, path: string): Promise<string> => {
  const target = await resolveWorkspacePath(policy, path, true);
  const info = await lstat(target);
  if (!info.isFile() || info.size > policy.maxBytes) throw Error("Workspace file is not a regular file or exceeds limit");
  return readFile(target, "utf8");
};
export const workspaceWrite = async (policy: WorkspacePolicy, path: string, content: string, expectedHash?: string): Promise<string> => {
  if (Buffer.byteLength(content) > policy.maxBytes) throw Error("Workspace content exceeds limit");
  await mkdir(policy.root, { recursive: true });
  const target = await resolveWorkspacePath(policy, path);
  try {
    const current = await readFile(target);
    if (expectedHash && createHash("sha256").update(current).digest("hex") !== expectedHash) throw Error("Workspace edit conflict");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || expectedHash) throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, "w", 0o600);
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
  const actual = await resolveWorkspacePath(policy, path, true);
  if (actual !== target) throw Error("Workspace path changed during write");
  return createHash("sha256").update(content).digest("hex");
};
