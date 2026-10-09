// -----------------------------------------------------------------------------
// Assistant todo service: durable, idempotent mutations over the Session kernel.
//
// Contract fixed by .planning/2026-10-08-personal-assistant-memory-v0-1/task_plan.md.
//
// Design notes, each backed by an experiment recorded in findings.md:
//
//  * Todos and idempotency receipts are two document families, so each record is
//    loaded and written independently and listing never loads the whole store.
//  * `DocumentQuery` (pi-durable 1.1.0) has no `order` field, so a document scan
//    has exactly one order. Measured: `scanDocuments` returns records in creation
//    order, *not* key order. List order is therefore creation order, oldest first.
//  * `tx.doc(family, key, seed)` returns the *persisted* value when the member
//    exists and only uses `seed` to create it. So every write inside a commit
//    passes an already-complete seed: there is no "create empty then fill in" step
//    that a reader (or a rollback) could observe half-done.
//  * A commit that throws persists nothing (verified), so a failed operation can
//    never occupy an operationId.
//  * The value handed back by `tx.doc` must be copied inside the commit: after the
//    commit settles the overlay is closed and touching that object throws
//    `TypeError: Cannot use a settled overlay`.
//
// Why a mutex: every mutation has to read before it writes (does this operationId
// already have a receipt? does this todo exist?). Reads and writes cannot share one
// `commit`, so the sequence is serialized in-process. That is sound here because
// the service is the single writer, enforced across processes by the SQLite
// exclusive lock in storage.ts. Reads are not serialized: they are point-in-time
// and hold no cross-step invariant.
// -----------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type Cursor } from "@earendil-works/pi-durable";
import type { AssistantStore } from "./storage.ts";

/** Document kinds. Changing one of these strings changes the on-disk identity. */
export const ASSISTANT_TODO_KIND = "assistant.todo";
export const ASSISTANT_RECEIPT_KIND = "assistant.receipt";

/** Input bounds. Mirrored by the HTTP layer; kept here so both share one source. */
export const ASSISTANT_LIMITS = {
	titleMinChars: 1,
	titleMaxChars: 500,
	operationIdMaxChars: 128,
	defaultPageSize: 20,
	maxPageSize: 100,
} as const;

export type TodoStatus = "open" | "done";
/** The list filter. `all` is a filter value only; it is never stored. */
export type TodoFilter = TodoStatus | "all";

/** The public shape of a todo. */
export type Todo = {
	readonly id: string;
	readonly title: string;
	readonly status: TodoStatus;
	readonly createdAt: string;
	readonly completedAt: string | null;
};

/** The mutable value stored in the document; the tracker mutates this inside a commit. */
export type TodoRecord = {
	id: string;
	title: string;
	status: TodoStatus;
	createdAt: string;
	completedAt: string | null;
};

export type TodoSeed = {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
};

/**
 * One completed mutation, keyed by `operationId`.
 *
 * The seed is the complete final record, so the document is never observed in a
 * partially written state.
 */
export type ReceiptRecord = {
	operationId: string;
	fingerprint: string;
	requestKind: string;
	todo: TodoRecord;
};

/** Exported so the durable Harness tools reuse the same on-disk todo/receipt identity. */
export const TodoDoc = defineDocFamily<TodoRecord, TodoSeed>({
	kind: ASSISTANT_TODO_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({
		id: seed.id,
		title: seed.title,
		status: "open",
		createdAt: seed.createdAt,
		completedAt: null,
	}),
});

export const ReceiptDoc = defineDocFamily<ReceiptRecord, ReceiptRecord>({
	kind: ASSISTANT_RECEIPT_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({
		operationId: seed.operationId,
		fingerprint: seed.fingerprint,
		requestKind: seed.requestKind,
		todo: seed.todo,
	}),
});

// --- errors ------------------------------------------------------------------

export type AssistantErrorCode =
	| "invalid_request"
	| "not_found"
	| "method_not_allowed"
	| "operation_conflict"
	| "invalid_cursor"
	| "unauthorized"
	| "cross_origin_forbidden"
	| "payload_too_large"
	| "unsupported_media_type"
	| "service_unavailable"
	| "internal_error";

/**
 * An error whose message is safe to return to a client verbatim: it never carries a
 * filesystem path, a token or a stack trace.
 */
export class AssistantError extends Error {
	readonly code: AssistantErrorCode;
	readonly httpStatus: number;

	constructor(code: AssistantErrorCode, httpStatus: number, message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = "AssistantError";
		this.code = code;
		this.httpStatus = httpStatus;
	}

	static invalid(message: string): AssistantError {
		return new AssistantError("invalid_request", 400, message);
	}

	static notFound(message: string): AssistantError {
		return new AssistantError("not_found", 404, message);
	}
}

// --- validation --------------------------------------------------------------

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate and normalize a title. Returns the trimmed form, which is also what the
 * request fingerprint uses, so `" buy milk "` and `"buy milk"` are one operation.
 */
export const normalizeTitle = (raw: unknown): string => {
	if (typeof raw !== "string") throw AssistantError.invalid("title must be a string");
	const title = raw.trim();
	const length = title.length; // UTF-16 code units, not grapheme clusters.
	if (length < ASSISTANT_LIMITS.titleMinChars) throw AssistantError.invalid("title must not be empty");
	if (length > ASSISTANT_LIMITS.titleMaxChars) {
		throw AssistantError.invalid(`title must be at most ${ASSISTANT_LIMITS.titleMaxChars} characters`);
	}
	return title;
};

/**
 * Validate an operationId. The accepted alphabet is deliberately narrow so the id can
 * be embedded in a URL, a JSON body and a document key without escaping, and so a
 * pi `toolCallId` (or any retry handle a caller derives) is usable unchanged.
 */
export const normalizeOperationId = (raw: unknown): string => {
	if (typeof raw !== "string") throw AssistantError.invalid("operationId must be a string");
	if (raw.length === 0) throw AssistantError.invalid("operationId must not be empty");
	if (raw.length > ASSISTANT_LIMITS.operationIdMaxChars) {
		throw AssistantError.invalid(`operationId must be at most ${ASSISTANT_LIMITS.operationIdMaxChars} characters`);
	}
	if (!OPERATION_ID_PATTERN.test(raw)) {
		throw AssistantError.invalid("operationId may only contain A-Z a-z 0-9 . _ : -");
	}
	return raw;
};

export const normalizeTodoId = (raw: unknown): string => {
	if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
		throw AssistantError.invalid("id must be a UUID");
	}
	return raw.toLowerCase();
};

export const normalizeStatusFilter = (raw: unknown): TodoFilter => {
	if (raw === undefined || raw === null || raw === "") return "open";
	if (raw === "open" || raw === "done" || raw === "all") return raw;
	throw AssistantError.invalid("status must be one of open, done, all");
};

export const normalizePageSize = (raw: unknown, fallback = ASSISTANT_LIMITS.defaultPageSize): number => {
	if (raw === undefined || raw === null || raw === "") return fallback;
	const text = typeof raw === "number" ? String(raw) : raw;
	if (typeof text !== "string" || !/^[0-9]{1,3}$/.test(text)) {
		throw AssistantError.invalid("limit must be an integer between 1 and 100");
	}
	const limit = Number(text);
	if (limit < 1 || limit > ASSISTANT_LIMITS.maxPageSize) {
		throw AssistantError.invalid(`limit must be between 1 and ${ASSISTANT_LIMITS.maxPageSize}`);
	}
	return limit;
};

/** Normalized request fingerprint. Two requests are "the same" iff this matches. */
const fingerprintOf = (kind: "create" | "complete", subject: string): string => `${kind}\n${subject}`;

// --- pagination --------------------------------------------------------------

/**
 * The HTTP cursor wraps the storage cursor together with the query it belongs to.
 *
 * pi-durable cursors are backend-owned and must be round-tripped verbatim, and a
 * cursor "carries the scan's order" — reusing one under a different filter would
 * silently produce a wrong page. Wrapping lets us reject that with a 400 instead.
 */
type CursorEnvelope = {
	readonly v: 1;
	readonly status: TodoFilter;
	readonly limit: number;
	readonly at: Cursor;
};

const encodeCursor = (status: TodoFilter, limit: number, at: Cursor): string =>
	Buffer.from(JSON.stringify({ v: 1, status, limit, at }), "utf8").toString("base64url");

const decodeCursor = (raw: unknown, status: TodoFilter, limit: number): Cursor | undefined => {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new AssistantError("invalid_cursor", 400, "cursor must be a string");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw new AssistantError("invalid_cursor", 400, "cursor is not a valid cursor");
	}
	if (!isPlainObject(parsed) || parsed.v !== 1) {
		throw new AssistantError("invalid_cursor", 400, "cursor is not a valid cursor");
	}
	const envelope = parsed as unknown as CursorEnvelope;
	if (envelope.status !== status || envelope.limit !== limit) {
		throw new AssistantError(
			"invalid_cursor",
			400,
			"cursor was issued for a different status or limit; restart the listing without a cursor",
		);
	}
	if (!isPlainObject(envelope.at)) {
		throw new AssistantError("invalid_cursor", 400, "cursor is not a valid cursor");
	}
	// Sound: the envelope is `JSON.parse` output, which can only hold JSON values. The
	// value is opaque to us and is handed straight back to the same scan.
	return envelope.at;
};

// --- in-process mutation queue ------------------------------------------------

/**
 * Serialize async work. `tail` never rejects, so one failed operation cannot poison
 * the queue.
 */
const createQueue = (): (<T>(work: () => Promise<T>) => Promise<T>) => {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(work: () => Promise<T>): Promise<T> => {
		const result = tail.then(work, work);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
};

// --- service -----------------------------------------------------------------

/**
 * Inputs are `unknown` on purpose: every field is untrusted (an HTTP body, a pi tool
 * argument) and is validated at runtime by the `normalize*` helpers below.
 */
export type CreateTodoInput = { readonly operationId?: unknown; readonly title?: unknown };
export type CompleteTodoInput = { readonly id?: unknown; readonly operationId?: unknown };
export type ListTodosInput = { readonly status?: unknown; readonly limit?: unknown; readonly cursor?: unknown };

export type ListTodosResult = {
	readonly items: readonly Todo[];
	/** `null` when the scan is exhausted. */
	readonly nextCursor: string | null;
};

export type TodoServiceOptions = {
	readonly context?: Context;
	/** Injectable for tests. Must return a UTC ISO-8601 timestamp. */
	readonly now?: () => string;
	/** Injectable for tests. Must return a unique UUID. */
	readonly newId?: () => string;
};

export type TodoService = {
	readonly createTodo: (input: CreateTodoInput) => Promise<Todo>;
	readonly listTodos: (input: ListTodosInput) => Promise<ListTodosResult>;
	readonly getTodo: (id: unknown) => Promise<Todo>;
	readonly completeTodo: (input: CompleteTodoInput) => Promise<Todo>;
	/** Number of mutations waiting for or holding the mutation queue. Test observability. */
	readonly pendingMutations: () => number;
};

export const toTodo = (record: Readonly<TodoRecord>): Todo => ({
	id: record.id,
	title: record.title,
	status: record.status,
	createdAt: record.createdAt,
	completedAt: record.completedAt,
});

/**
 * Build the todo service over an already-opened store.
 *
 * Every mutation is one `commit` that writes the todo change and its idempotency
 * receipt together, or writes neither.
 */
export const createTodoService = (store: AssistantStore, options: TodoServiceOptions = {}): TodoService => {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const now = options.now ?? ((): string => new Date().toISOString());
	const newId = options.newId ?? ((): string => randomUUID());
	const enqueue = createQueue();
	let pending = 0;

	const enqueueMutation = <T>(work: () => Promise<T>): Promise<T> => {
		pending += 1;
		return enqueue(work).finally(() => {
			pending -= 1;
		});
	};

	/**
	 * Replay guard. Returns the recorded result when this operationId already
	 * completed with the same normalized request, and rejects when it completed a
	 * different one. Must be called inside the mutation queue.
	 */
	const readReceipt = async (
		operationId: string,
		fingerprint: string,
	): Promise<{ readonly todo: Todo } | undefined> => {
		const existing = await store.session.snapshot(ReceiptDoc, operationId, context);
		if (existing === undefined) return undefined;
		if (existing.fingerprint !== fingerprint) {
			throw new AssistantError(
				"operation_conflict",
				409,
				`operationId ${operationId} was already used for a different request (${existing.requestKind})`,
			);
		}
		return { todo: toTodo(existing.todo) };
	};

	const createTodo = (input: CreateTodoInput): Promise<Todo> =>
		enqueueMutation(async () => {
			const operationId = normalizeOperationId(input?.operationId);
			const title = normalizeTitle(input?.title);
			const fingerprint = fingerprintOf("create", title);

			const replayed = await readReceipt(operationId, fingerprint);
			if (replayed !== undefined) return replayed.todo;

			const id = newId();
			const createdAt = now();

			return await store.session.commit(async (tx) => {
				const todo = await tx.doc(TodoDoc, id, { id, title, createdAt });
				// The receipt is created already complete, in the same commit as the todo.
				const receipt: ReceiptRecord = {
					operationId,
					fingerprint,
					requestKind: "create",
					todo: { ...todo },
				};
				await tx.doc(ReceiptDoc, operationId, receipt);
				// Copy: the live tracker object is unusable once the commit settles.
				return toTodo({ ...todo });
			}, context);
		});

	const completeTodo = (input: CompleteTodoInput): Promise<Todo> =>
		enqueueMutation(async () => {
			const id = normalizeTodoId(input?.id);
			const operationId = normalizeOperationId(input?.operationId);
			const fingerprint = fingerprintOf("complete", id);

			const replayed = await readReceipt(operationId, fingerprint);
			if (replayed !== undefined) return replayed.todo;

			// Read outside the commit so a missing todo is never created by a seed.
			const existing = await store.session.snapshot(TodoDoc, id, context);
			if (existing === undefined) throw AssistantError.notFound(`no todo with id ${id}`);

			return await store.session.commit(async (tx) => {
				// The member exists, so this seed is ignored and the persisted record is returned.
				const todo = await tx.doc(TodoDoc, id, { id, title: existing.title, createdAt: existing.createdAt });
				if (todo.status !== "done") {
					todo.status = "done";
					todo.completedAt = now();
				}
				const receipt: ReceiptRecord = {
					operationId,
					fingerprint,
					requestKind: "complete",
					todo: { ...todo },
				};
				await tx.doc(ReceiptDoc, operationId, receipt);
				return toTodo({ ...todo });
			}, context);
		});

	const getTodo = async (rawId: unknown): Promise<Todo> => {
		const id = normalizeTodoId(rawId);
		const record = await store.session.snapshot(TodoDoc, id, context);
		if (record === undefined) throw AssistantError.notFound(`no todo with id ${id}`);
		return toTodo(record);
	};

	/**
	 * List one page of todos, oldest first.
	 *
	 * pi-durable's scan exposes no per-record cursor and no status filter, so the only
	 * resumption points are page boundaries. The scan page size is therefore exactly
	 * `limit`, which bounds a page's matches by `limit` — that is what makes "stop at a
	 * boundary" exact instead of lossy. A page whose matches do not fit entirely is
	 * rescanned from its own start by the next request, so no record is skipped and none
	 * is returned twice.
	 *
	 * Cost: one snapshot per scanned record. A filter that matches almost nothing scans
	 * the store a page at a time, so listing is O(store size) in the worst case. Acceptable
	 * at personal scale; revisit if the store grows past a few thousand todos.
	 */
	const listTodos = async (input: ListTodosInput): Promise<ListTodosResult> => {
		const status = normalizeStatusFilter(input?.status);
		const limit = normalizePageSize(input?.limit);
		const startCursor = decodeCursor(input?.cursor, status, limit);

		const items: Todo[] = [];
		let cursor = startCursor;
		for (;;) {
			const page = await store.storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current", kind: ASSISTANT_TODO_KIND },
				limit,
				cursor,
				context,
			);

			const matched: Todo[] = [];
			for (const record of page.items) {
				if (record.key === undefined) continue;
				const value = await store.session.snapshot(TodoDoc, record.key, context);
				if (value === undefined) continue;
				if (status !== "all" && value.status !== status) continue;
				matched.push(toTodo(value));
			}

			if (items.length + matched.length > limit) {
				// This page does not fit as a whole. Stop before it and let the next request
				// rescan it. Reaching here means at least one earlier page was consumed, so a
				// resumption cursor exists; without one the page was the first, and a first
				// page can never overflow because it is scanned with the same `limit`.
				if (cursor === undefined) {
					throw new AssistantError("internal_error", 500, "pagination bookkeeping failed");
				}
				return { items, nextCursor: encodeCursor(status, limit, cursor) };
			}

			items.push(...matched);
			if (page.next === undefined) return { items, nextCursor: null };
			cursor = page.next;
			if (items.length === limit) {
				return { items, nextCursor: encodeCursor(status, limit, cursor) };
			}
		}
	};

	return {
		createTodo,
		listTodos,
		getTodo,
		completeTodo,
		pendingMutations: () => pending,
	};
};
