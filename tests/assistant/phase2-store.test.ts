// -----------------------------------------------------------------------------
// Phase 2 verification, store and service layer: V01, V02, V04, V05, V06.
//
// These tests drive `createTodoService` directly (no HTTP) so a failure points at
// the persistence logic rather than the transport. V03, V07, V08 and V09 (which
// need separate processes) live in phase2-process.test.ts; the HTTP contract
// (V10-V13) lives in phase2-http.test.ts.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantError, type Todo } from "../../src/assistant/store.ts";
import { createRunDir, databasePathIn, startTestService, type TestService } from "./helpers.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Assert a call fails with the given `AssistantError` code. */
const expectAssistantError = async (promise: Promise<unknown>, code: string): Promise<AssistantError> => {
	let captured: unknown;
	await assert.rejects(promise, (error: unknown) => {
		captured = error;
		return error instanceof AssistantError;
	});
	assert.ok(captured instanceof AssistantError, "expected an AssistantError");
	assert.equal(captured.code, code);
	return captured;
};

/** Run `startTestService` and always close it, even when an assertion throws. */
const withService = async (
	label: string,
	body: (service: TestService, databasePath: string) => Promise<void>,
): Promise<void> => {
	const runDir = await createRunDir(label);
	const databasePath = databasePathIn(runDir);
	const service = await startTestService(databasePath);
	try {
		await body(service, databasePath);
	} finally {
		await service.close();
	}
};

// --- V01: cold start and data model ------------------------------------------

test("V01 an empty store lists nothing, and a created todo has the documented shape", async () => {
	await withService("phase2-v01", async (service) => {
		const empty = await service.service.listTodos({});
		assert.deepEqual(empty.items, []);
		assert.equal(empty.nextCursor, null);

		const created = await service.service.createTodo({ operationId: "v01-create-1", title: "  buy milk  " });

		assert.match(created.id, UUID_PATTERN, "id must be a UUID");
		assert.equal(created.title, "buy milk", "title must be trimmed");
		assert.equal(created.status, "open");
		assert.equal(created.completedAt, null);
		assert.match(created.createdAt, UTC_ISO_PATTERN, "createdAt must be a UTC ISO-8601 timestamp");

		const fetched = await service.service.getTodo(created.id);
		assert.deepEqual(fetched, created, "get must return the same record that create returned");

		const listed = await service.service.listTodos({});
		assert.deepEqual(listed.items, [created], "the created todo must be listable");
	});
});

// --- V02: completion semantics -----------------------------------------------

test("V02 completing is idempotent, unknown ids are 404, and no ghost record appears", async () => {
	await withService("phase2-v02", async (service) => {
		const created = await service.service.createTodo({ operationId: "v02-create-1", title: "water plants" });

		const completed = await service.service.completeTodo({ id: created.id, operationId: "v02-complete-1" });
		assert.equal(completed.status, "done");
		assert.match(completed.completedAt ?? "", UTC_ISO_PATTERN);
		assert.equal(completed.createdAt, created.createdAt);

		// A second completion with a *different* operation is a no-op on the fields that
		// describe when the work finished.
		const again = await service.service.completeTodo({ id: created.id, operationId: "v02-complete-2" });
		assert.equal(again.status, "done");
		assert.equal(again.completedAt, completed.completedAt, "completing twice must not move completedAt");

		// A well-formed id that was never created is a not-found, not a creation.
		const missing = "3f1c8a9e-2b4d-4f6a-9c1e-5d7b0a2e4f68";
		assert.match(missing, UUID_PATTERN);
		await expectAssistantError(service.service.completeTodo({ id: missing, operationId: "v02-complete-3" }), "not_found");

		const listed = await service.service.listTodos({ status: "all", limit: 100 });
		assert.equal(listed.items.length, 1, "the failed completion must not have created a ghost record");
		assert.equal((await service.service.getTodo(created.id)).status, "done");
	});
});

// --- V04: idempotency receipts ------------------------------------------------

test("V04 one operationId replays its result, conflicts on a different request, and survives a restart", async () => {
	const runDir = await createRunDir("phase2-v04");
	const databasePath = databasePathIn(runDir);
	const service = await startTestService(databasePath);
	let first: Todo;
	try {
		first = await service.service.createTodo({ operationId: "v04-op-1", title: "call the dentist" });

		// Same operationId, same request (including whitespace that normalizes away).
		const replay = await service.service.createTodo({ operationId: "v04-op-1", title: "  call the dentist " });
		assert.deepEqual(replay, first, "a replayed request must return the original result");

		const listed = await service.service.listTodos({ status: "all", limit: 100 });
		assert.equal(listed.items.length, 1, "a replay must not create a second todo");

		// Same operationId, different request.
		await expectAssistantError(service.service.createTodo({ operationId: "v04-op-1", title: "buy milk" }), "operation_conflict");

		// Same operationId, different kind of request.
		await expectAssistantError(service.service.completeTodo({ id: first.id, operationId: "v04-op-1" }), "operation_conflict");

		// The conflicting attempts must not have written anything.
		assert.equal((await service.service.getTodo(first.id)).status, "open");
	} finally {
		await service.close();
	}

	// The receipt lives in the same durable store as the todo, so a fresh process must
	// still know that the operation already happened.
	const reopened = await startTestService(databasePath);
	try {
		const replay = await reopened.service.createTodo({ operationId: "v04-op-1", title: "call the dentist" });
		assert.deepEqual(replay, first, "the receipt must survive a restart");
		await expectAssistantError(reopened.service.createTodo({ operationId: "v04-op-1", title: "something else" }), "operation_conflict");
		const listed = await reopened.service.listTodos({ status: "all", limit: 100 });
		assert.equal(listed.items.length, 1);
	} finally {
		await reopened.close();
	}
});

// --- V05: concurrency ---------------------------------------------------------

test("V05 concurrent identical operations collapse to one, and concurrent distinct ones are not lost", async () => {
	await withService("phase2-v05", async (service) => {
		// 20 racing retries of the same logical operation.
		const sameOperation = await Promise.all(
			Array.from({ length: 20 }, () => service.service.createTodo({ operationId: "v05-same", title: "one and only" })),
		);
		const ids = new Set(sameOperation.map((todo) => todo.id));
		assert.equal(ids.size, 1, "all 20 racing retries must observe the same todo");
		assert.equal((await service.service.listTodos({ status: "all", limit: 100 })).items.length, 1);

		// 20 concurrent distinct operations.
		const distinct = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				service.service.createTodo({ operationId: `v05-distinct-${index}`, title: `task ${index}` }),
			),
		);
		assert.equal(new Set(distinct.map((todo) => todo.id)).size, 20);
		const afterDistinct = await service.service.listTodos({ status: "all", limit: 100 });
		assert.equal(afterDistinct.items.length, 21, "no concurrent create may be lost");

		// Concurrent completions of the same todo must agree on one completion time.
		const target = distinct[0];
		const completions = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				service.service.completeTodo({ id: target.id, operationId: `v05-complete-${index}` }),
			),
		);
		for (const todo of completions) assert.equal(todo.status, "done");
		const completionTimes = new Set(completions.map((todo) => todo.completedAt));
		assert.equal(completionTimes.size, 1, `concurrent completions disagreed on completedAt: ${[...completionTimes].join(", ")}`);
		assert.equal((await service.service.getTodo(target.id)).completedAt, completions[0].completedAt);

		assert.equal(service.service.pendingMutations(), 0, "no mutation may still be queued when the calls have settled");
	});
});

// --- V06: transaction atomicity ----------------------------------------------

test("V06 an exception inside the commit rolls back the todo change and the receipt together", async () => {
	const runDir = await createRunDir("phase2-v06");
	const databasePath = databasePathIn(runDir);

	// The only production-reachable failure point inside a commit callback is `now()` in
	// `completeTodo`, which is called *after* the status mutation has been staged. That
	// makes it a real mid-commit abort, not a synthetic one: no fault-injection switch is
	// needed, and none is exposed over HTTP (the server constructs the service without
	// options).
	const injected = new Error("injected failure inside the commit callback");
	let calls = 0;
	let failOnCall = -1;
	const service = await startTestService(databasePath, {
		now: () => {
			calls += 1;
			if (calls === failOnCall) throw injected;
			return new Date().toISOString();
		},
	});
	try {
		const alpha = await service.service.createTodo({ operationId: "v06-create-alpha", title: "alpha" });
		const beta = await service.service.createTodo({ operationId: "v06-create-beta", title: "beta" });

		calls = 0;
		failOnCall = 1; // the next `now()` call is the one inside the completion's commit
		await assert.rejects(
			service.service.completeTodo({ id: alpha.id, operationId: "v06-complete-alpha" }),
			(error: unknown) => error === injected,
		);
		failOnCall = -1;

		const afterAbort = await service.service.getTodo(alpha.id);
		assert.equal(afterAbort.status, "open", "the staged status change must have been rolled back");
		assert.equal(afterAbort.completedAt, null, "the staged completion time must have been rolled back");

		// Had the aborted commit left a receipt behind, this retry would replay it (or
		// report a conflict). It must instead do the work.
		const completed = await service.service.completeTodo({ id: alpha.id, operationId: "v06-complete-alpha" });
		assert.equal(completed.status, "done");
		assert.match(completed.completedAt ?? "", UTC_ISO_PATTERN);

		// Now that the retry succeeded, the receipt exists and belongs to alpha: reusing
		// the same operationId for beta is a conflict, and beta is untouched.
		await expectAssistantError(service.service.completeTodo({ id: beta.id, operationId: "v06-complete-alpha" }), "operation_conflict");
		assert.equal((await service.service.getTodo(beta.id)).status, "open");

		assert.equal(service.service.pendingMutations(), 0);
	} finally {
		await service.close();
	}

	// Nothing about the aborted commit may be visible to a new process reading the file.
	const reopened = await startTestService(databasePath);
	try {
		const listed = await reopened.service.listTodos({ status: "all", limit: 100 });
		assert.equal(listed.items.length, 2, "only the two successful creations may exist");
		const alpha = listed.items.find((todo) => todo.title === "alpha");
		const beta = listed.items.find((todo) => todo.title === "beta");
		assert.equal(alpha?.status, "done");
		assert.equal(beta?.status, "open");
	} finally {
		await reopened.close();
	}
});
