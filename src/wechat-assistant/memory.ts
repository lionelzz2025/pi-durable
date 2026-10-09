// Independent long-term memory. Stored as one bounded session document so every
// read (the prompt section's `snapshot`) and write (a tool commit) sees a single
// atomic value. Forgotten entries stay with `active: false` for audit; they are
// never injected and never returned by search.
import { defineDoc } from "@earendil-works/pi-durable";

export type MemoryRecord = {
  id: string;
  content: string;
  source: string;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

export const MemoryStore = defineDoc<{ entries: MemoryRecord[] }>({
  kind: "wechat.memory",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
});

export const MEMORY_LIMITS = {
  maxEntries: 500,
  maxContentChars: 2000,
  maxSourceChars: 64,
  searchLimit: 20,
  searchQueryMaxChars: 200,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normalizeMemoryId = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) throw new Error("memory id must be a UUID");
  return raw.toLowerCase();
};

export const normalizeMemoryContent = (raw: unknown): string => {
  if (typeof raw !== "string") throw new Error("content must be a string");
  const value = raw.trim();
  if (value.length === 0) throw new Error("content must not be empty");
  if (value.length > MEMORY_LIMITS.maxContentChars) {
    throw new Error(`content must be at most ${MEMORY_LIMITS.maxContentChars} characters`);
  }
  if (value.includes("\0")) throw new Error("content must not contain NUL");
  return value;
};

export const normalizeMemorySource = (raw: unknown): string => {
  if (raw === undefined || raw === null || raw === "") return "user";
  if (typeof raw !== "string") throw new Error("source must be a string");
  const value = raw.trim();
  if (value.length === 0 || value.length > MEMORY_LIMITS.maxSourceChars || /[\r\n\0]/.test(value)) {
    throw new Error("source is invalid");
  }
  return value;
};

export const normalizeSearchLimit = (raw: unknown, fallback = MEMORY_LIMITS.searchLimit): number => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MEMORY_LIMITS.maxEntries) {
    throw new Error(`limit must be an integer between 1 and ${MEMORY_LIMITS.maxEntries}`);
  }
  return value;
};

export const normalizeSearchQuery = (raw: unknown): string => {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new Error("query must be a string");
  const value = raw.trim();
  if (value.length > MEMORY_LIMITS.searchQueryMaxChars) {
    throw new Error(`query must be at most ${MEMORY_LIMITS.searchQueryMaxChars} characters`);
  }
  return value;
};

/** Active entries, newest edit first. The one ordering both search and injection use. */
export const activeMemories = (entries: readonly MemoryRecord[]): MemoryRecord[] =>
  entries.filter((entry) => entry.active).slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const searchMemories = (entries: readonly MemoryRecord[], query: string, limit: number): MemoryRecord[] => {
  const needle = query.toLowerCase();
  return activeMemories(entries)
    .filter((entry) => needle === "" || entry.content.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((entry) => ({ ...entry }));
};

/** Byte budget reserved for the "more omitted" footer so a rendered block never exceeds its budget. */
const FOOTER_RESERVE = 96;
const HEADER = "长期记忆（可能不完整，可用 memory_search 检索）：\n";

/**
 * Render active memories into a bounded prompt block. Returns `undefined` when
 * there is nothing to inject or the budget is too small for even one line; it
 * degrades by omission, never by truncating mid-entry, so injected content is
 * always a complete stored fact.
 */
export const renderMemoryPrompt = (entries: readonly MemoryRecord[], budgetBytes: number): string | undefined => {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return undefined;
  const active = activeMemories(entries).filter((entry) => entry.content.length > 0);
  if (active.length === 0) return undefined;
  const lines: string[] = [];
  let used = Buffer.byteLength(HEADER, "utf8");
  for (const entry of active) {
    const line = `- [${entry.source}] ${entry.content}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (used + size + FOOTER_RESERVE > budgetBytes) break;
    lines.push(line);
    used += size;
  }
  if (lines.length === 0) return undefined;
  const omitted = active.length - lines.length;
  const footer = omitted > 0 ? `……另有 ${omitted} 条未显示，请用 memory_search 检索\n` : "";
  return HEADER + lines.join("") + footer;
};
