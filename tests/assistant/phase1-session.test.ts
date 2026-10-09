// -----------------------------------------------------------------------------
// Phase 1 verification — Session kernel + Documents, without a Harness.
//
// Purpose: prove that pi-durable's Session kernel (createSession + defineDoc +
// commit/snapshot) can back a durable business store with no Harness, no model
// provider and no API key. This is the load-bearing assumption of route B.
//
// Run:  npm test   (node --test "tests/**/*.test.ts")
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	defineDoc,
	defineDocFamily,
	type Cursor,
	type DocumentRecord,
	type JsonObject,
	type Session,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const runDir = join(here, "..", "..", "data", "test-runs", `phase1-${process.pid}-${Date.now()}`);

// --- documents under test ----------------------------------------------------

type Counters = {
	attempts: number;
};

/** Session-scoped singleton: proves write -> close -> reopen persistence. */
const CounterDoc = defineDoc<Counters>({
	kind: "phase1.counter",
	version: 1,
	scope: "session",
	initial: () => ({ attempts: 0 }),
});

type StoredTodo = {
	id: string;
	title: string;
	status: "open" | "done";
	completedAt: string | null;
};

/** Session-scoped family: proves per-record storage plus enumeration/pagination. */
const TodoDoc = defineDocFamily<StoredTodo, { readonly id: string; readonly title: string }>({
	kind: "phase1.todo",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({
		id: seed.id,
		title: seed.title,
		status: "open",
		completedAt: null,
	}),
});

// --- store handle ------------------------------------------------------------

/**
 * The store owns BOTH handles on purpose.
 *
 * Writes must go through `session.commit` (only committed state is observable).
 * Enumeration must go through `storage.scanDocuments`, because in
 * @earendil-works/pi-durable@1.1.0 the `Session` *type* declares
 * `scanDocuments` / `findDocument` / `document` / `task` / `scanTasks`, but the
 * runtime `SessionImpl` implements none of them. Calling `session.scanDocuments`
 * type-checks and then throws `TypeError: session.scanDocuments is not a function`.
 * See the "upstream scan gap" test below, which pins that behaviour.
 */
type Store = {
	readonly session: Session;
	readonly storage: Storage;
	readonly close: () => Promise<void>;
};

const openStore = async (databasePath: string): Promise<Store> => {
	await mkdir(dirname(databasePath), { recursive: true });
	const storage = await openNodeSqliteStorage(databasePath);
	const session = createSession(storage);
	return { session, storage, close: () => session.close(context) };
};

const dbPath = (name: string): string => join(runDir, name);

/** Enumerate every live family member of one kind, following cursors to the end. */
const scanTodoKeys = async (store: Store): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await store.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: "phase1.todo" },
			20,
			cursor,
			context,
		);
		for (const record of page.items) {
			assert.ok(record.key !== undefined, "family records must carry a key");
			keys.push(record.key);
		}
		if (page.next === undefined) return keys;
		cursor = page.next;
	}
};

// --- V: persistence across close/reopen --------------------------------------

test("session doc survives close and reopen on the same file", async () => {
	const path = dbPath("persist.sqlite");

	const first = await openStore(path);
	const before = await first.session.snapshot(CounterDoc, context);
	assert.equal(before, undefined, "absent doc must read as undefined, not throw");

	const written = await first.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts += 1;
		return counter.attempts;
	}, context);
	assert.equal(written, 1);

	const readBack = await first.session.snapshot(CounterDoc, context);
	assert.equal(readBack?.attempts, 1, "committed value visible in the same session");
	await first.close();

	const second = await openStore(path);
	const reopened = await second.session.snapshot(CounterDoc, context);
	assert.equal(reopened?.attempts, 1, "value survives session close and reopen");

	const bumped = await second.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts += 1;
		return counter.attempts;
	}, context);
	assert.equal(bumped, 2, "doc resumes from persisted state, not from initial()");
	await second.close();

	const third = await openStore(path);
	assert.equal((await third.session.snapshot(CounterDoc, context))?.attempts, 2);
	await third.close();
});

// --- V: atomicity ------------------------------------------------------------

test("a throwing commit persists nothing", async () => {
	const path = dbPath("atomicity.sqlite");
	const store = await openStore(path);

	await assert.rejects(
		store.session.commit(async (tx) => {
			const counter = await tx.doc(CounterDoc);
			counter.attempts = 99;
			throw new Error("phase1-injected-failure");
		}, context),
		/phase1-injected-failure/,
	);

	assert.equal(
		await store.session.snapshot(CounterDoc, context),
		undefined,
		"failed commit must not create or update the doc",
	);

	// The session stays usable after a rejected commit.
	const after = await store.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts += 1;
		return counter.attempts;
	}, context);
	assert.equal(after, 1);
	await store.close();

	const reopened = await openStore(path);
	assert.equal((await reopened.session.snapshot(CounterDoc, context))?.attempts, 1);
	await reopened.close();
});

// --- V: family storage, enumeration and pagination ---------------------------

test("doc family members are enumerable and paginate stably", async () => {
	const path = dbPath("family.sqlite");
	const store = await openStore(path);

	const TOTAL = 45;
	await store.session.commit(async (tx) => {
		for (let index = 0; index < TOTAL; index += 1) {
			const id = `todo-${String(index).padStart(3, "0")}`;
			await tx.doc(TodoDoc, id, { id, title: `Task ${index}` });
		}
	}, context);

	// 45 docs must land in one commit; if this fails, the store needs batching.
	const seen = await scanTodoKeys(store);
	assert.equal(seen.length, TOTAL, "every family member is enumerated exactly once");
	assert.equal(new Set(seen).size, TOTAL, "pagination returns no duplicates");

	const one = await store.session.snapshot(TodoDoc, "todo-007", context);
	assert.equal(one?.title, "Task 7");
	assert.equal(one?.status, "open");

	// Mutating one family member must not disturb its siblings.
	await store.session.commit(async (tx) => {
		const todo = await tx.doc(TodoDoc, "todo-007", { id: "todo-007", title: "Task 7" });
		todo.status = "done";
		todo.completedAt = "2026-01-01T00:00:00.000Z";
	}, context);

	assert.equal((await store.session.snapshot(TodoDoc, "todo-007", context))?.status, "done");
	assert.equal((await store.session.snapshot(TodoDoc, "todo-008", context))?.status, "open");

	await store.close();

	const reopened = await openStore(path);
	assert.equal(
		(await reopened.session.snapshot(TodoDoc, "todo-007", context))?.completedAt,
		"2026-01-01T00:00:00.000Z",
	);
	assert.equal((await reopened.session.snapshot(TodoDoc, "todo-044", context))?.title, "Task 44");
	assert.equal((await scanTodoKeys(reopened)).length, TOTAL);
	await reopened.close();
});

// --- V: concurrent commits on one session ------------------------------------

test("concurrent commits on one session do not lose updates", async () => {
	const path = dbPath("concurrent.sqlite");
	const store = await openStore(path);

	await Promise.all(
		Array.from({ length: 20 }, (_unused, index) =>
			store.session.commit(async (tx) => {
				const counter = await tx.doc(CounterDoc);
				counter.attempts += 1;
				return index;
			}, context),
		),
	);

	assert.equal(
		(await store.session.snapshot(CounterDoc, context))?.attempts,
		20,
		"every concurrent commit must be applied",
	);
	await store.close();
});

// --- V: empty store ----------------------------------------------------------

test("a never-written doc reads as undefined rather than throwing", async () => {
	const path = dbPath("absent.sqlite");
	const store = await openStore(path);

	assert.equal(await store.session.snapshot(CounterDoc, context), undefined);
	assert.equal(await store.session.snapshot(TodoDoc, "nope", context), undefined);

	const records: readonly DocumentRecord[] = (
		await store.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current" },
			10,
			undefined,
			context,
		)
	).items;
	assert.equal(records.length, 0, "an empty store scans empty");

	await store.close();
});

// --- upstream gap: pin the Session/Storage scan mismatch ---------------------

test("Session types declare scan/find methods that SessionImpl lacks at runtime", async () => {
	const path = dbPath("gap.sqlite");
	const store = await openStore(path);

	const runtime = store.session as unknown as Record<string, unknown>;
	for (const name of ["scanDocuments", "findDocument", "document", "task", "scanTasks", "submission"]) {
		assert.equal(
			typeof runtime[name],
			"undefined",
			`Session.${name} is declared in types.d.ts but missing on SessionImpl@1.1.0`,
		);
	}

	// The same capability IS present on Storage, which is why the store keeps that handle.
	for (const name of ["scanDocuments", "scanTasks", "scanConversations"]) {
		assert.equal(
			typeof (store.storage as unknown as Record<string, unknown>)[name],
			"function",
			`Storage.${name} must be callable`,
		);
	}

	await store.close();
});

// Keep TypeScript honest about the public types we depend on.
const _typecheck: JsonObject = { attempts: 0 };
void _typecheck;
