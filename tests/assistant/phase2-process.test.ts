// -----------------------------------------------------------------------------
// Phase 2 verification, multi-process: V03, V07, V08, V09, and the hard-exit half
// of V13.
//
// These spawn `src/assistant/main.ts` as a real child process, because the claims
// under test are about process boundaries: durability across a restart, a response
// that never reaches the client, a SIGKILL mid-flight, and the exclusive file lock.
//
// Windows note. Node cannot deliver SIGTERM or SIGINT to another process here, so
// `child.kill("SIGTERM")` terminates the child outright: `exitCode` stays `null` and
// `signalCode` is set. Tests in this file therefore never assert an exit code for a
// signal; they assert that the process is gone and that the data is intact. The
// graceful drain and the signal wiring are verified in-process, where a signal can
// be delivered for real — see `phase2-shutdown.test.ts`.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ASSISTANT_DATABASE_FILENAME, openAssistantStore } from "../../src/assistant/storage.ts";
import {
	callApi,
	createRunDir,
	errorCodeOf,
	holdPort,
	newToken,
	sleep,
	spawnService,
	waitForTodoCount,
	type Api,
	type ApiResponse,
	type ServiceProcess,
} from "./helpers.ts";

type Harness = {
	readonly children: ServiceProcess[];
	readonly spawn: (options: Parameters<typeof spawnService>[0]) => Promise<ServiceProcess>;
};

const createHarness = (): Harness => {
	const children: ServiceProcess[] = [];
	return {
		children,
		spawn: async (options) => {
			const child = await spawnService(options);
			children.push(child);
			return child;
		},
	};
};

/** Assert every spawned service was stopped, so no child outlives its test. */
const stopAll = async (harness: Harness): Promise<void> => {
	for (const child of harness.children) {
		if (child.child.exitCode === null && child.child.signalCode === null) await child.terminate();
	}
	for (const child of harness.children) {
		assert.ok(
			child.child.exitCode !== null || child.child.signalCode !== null,
			`a service process (port ${child.port}) was left running`,
		);
	}
};

const itemsOf = (response: ApiResponse): Array<Record<string, unknown>> => {
	const items = response.json?.items;
	assert.ok(Array.isArray(items), `expected an items array, got ${response.status} ${response.text}`);
	return items as Array<Record<string, unknown>>;
};

const todoOf = (response: ApiResponse): Record<string, unknown> => {
	const todo = response.json?.todo;
	assert.ok(typeof todo === "object" && todo !== null, `expected a todo object, got ${response.status} ${response.text}`);
	return todo as Record<string, unknown>;
};

/**
 * Send a create request and walk away without reading the response: the client
 * never learns the outcome, exactly like a proxy that drops the reply.
 */
const sendAndAbandon = async (
	port: number,
	token: string,
	body: Record<string, unknown>,
	delayMs = 0,
): Promise<void> => {
	const payload = JSON.stringify(body);
	const socket = connect(port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	socket.on("error", () => undefined); // the reset that follows is expected
	socket.write(
		"POST /v1/todos HTTP/1.1\r\n" +
			`Host: 127.0.0.1:${port}\r\n` +
			`Authorization: Bearer ${token}\r\n` +
			"Content-Type: application/json\r\n" +
			`Content-Length: ${Buffer.byteLength(payload)}\r\n` +
			"Connection: close\r\n\r\n" +
			payload,
	);
	if (delayMs > 0) await sleep(delayMs);
	socket.destroy();
};

const createTodo = async (api: Api, operationId: string, title: string): Promise<Record<string, unknown>> => {
	const response = await callApi(api, "POST", "/v1/todos", { body: { operationId, title } });
	assert.equal(response.status, 200, `create ${operationId}: ${response.text}`);
	return todoOf(response);
};

/**
 * Wait for the process to be gone, whatever the reason. On Windows a signal to
 * another process is a hard kill, so there is no exit code to check; on POSIX a
 * SIGTERM would run the handlers and exit 0. Both satisfy "gone".
 */
const expectGone = async (service: ServiceProcess): Promise<void> => {
	await service.exited;
	assert.ok(
		service.child.exitCode !== null || service.signalCode() !== null,
		`the service on port ${service.port} is still running`,
	);
};

// --- V03: durability across an ordinary restart -------------------------------

test("V03 a record written by one process is read and completed by the next, unchanged by a third", async () => {
	const dataDir = await createRunDir("phase2-v03");
	const token = newToken();
	const harness = createHarness();

	const first = await harness.spawn({ dataDir, token });
	await first.listening;
	const created = await createTodo(first.api, "v03-create", "survive a restart");
	await first.terminate();
	await expectGone(first);

	const second = await harness.spawn({ dataDir, token });
	await second.listening;
	const fetched = await callApi(second.api, "GET", `/v1/todos/${created.id as string}`);
	assert.equal(fetched.status, 200, fetched.text);
	assert.deepEqual(todoOf(fetched), created, "a restart must reproduce the record exactly");

	const complete = await callApi(second.api, "POST", `/v1/todos/${created.id as string}/complete`, {
		body: { operationId: "v03-complete" },
	});
	assert.equal(complete.status, 200, complete.text);
	const completed = todoOf(complete);
	assert.equal(completed.status, "done");
	await second.terminate();

	const third = await harness.spawn({ dataDir, token });
	await third.listening;
	const reread = await callApi(third.api, "GET", `/v1/todos/${created.id as string}`);
	assert.equal(reread.status, 200, reread.text);
	assert.deepEqual(todoOf(reread), completed, "a later restart must not disturb the completion time or the id");
	await third.terminate();

	await stopAll(harness);
});

// --- V07: the response never arrives ------------------------------------------

test("V07 a commit whose response never arrives is replayed, not repeated", async () => {
	const dataDir = await createRunDir("phase2-v07");
	const token = newToken();
	const harness = createHarness();

	let service = await harness.spawn({ dataDir, token });
	await service.listening;

	const operationId = "v07-lost-response";
	const title = "lost response";

	// Attempt 1: the request is definitely processed before the client disappears.
	await sendAndAbandon(service.port, token, { operationId, title }, 150);
	// Attempt 2: the client disappears immediately, so even the server may not have
	// finished. Both attempts carry the same operationId.
	await sendAndAbandon(service.port, token, { operationId, title });

	// The commit landed: that is what makes this the dangerous case.
	await waitForTodoCount(service.api, 1, service);

	const replayed = await createTodo(service.api, operationId, title);
	await waitForTodoCount(service.api, 1, service);
	const listed = await callApi(service.api, "GET", "/v1/todos?status=all&limit=100");
	assert.equal(itemsOf(listed).length, 1, "the two attempts plus the retry must be a single todo");
	assert.equal(itemsOf(listed)[0].id, replayed.id);

	// Restarting does not change the answer: the receipt is on disk, not in memory.
	await service.terminate();
	service = await harness.spawn({ dataDir, token });
	await service.listening;
	const afterRestart = await createTodo(service.api, operationId, title);
	assert.deepEqual(afterRestart, replayed, "the replay must survive a restart");
	const listedAgain = await callApi(service.api, "GET", "/v1/todos?status=all&limit=100");
	assert.equal(itemsOf(listedAgain).length, 1, "a restart must not allow a second todo");
	await service.terminate();

	await stopAll(harness);
});

// --- V08: the process dies mid-request ---------------------------------------

test("V08 a confirmed write survives SIGKILL, and an unconfirmed one settles to exactly one record", async () => {
	const dataDir = await createRunDir("phase2-v08");
	const token = newToken();
	const harness = createHarness();

	// Part A: the client was told "created", then the process is killed outright.
	let service = await harness.spawn({ dataDir, token });
	await service.listening;
	const confirmed = await createTodo(service.api, "v08-confirmed", "confirmed before the kill");
	service.kill();
	await service.exited;

	service = await harness.spawn({ dataDir, token });
	await service.listening;
	const recovered = await callApi(service.api, "GET", `/v1/todos/${confirmed.id as string}`);
	assert.equal(recovered.status, 200, `a confirmed write must survive SIGKILL: ${recovered.text}`);
	assert.deepEqual(todoOf(recovered), confirmed);

	// Part B: the outcome was never delivered, then the process is killed. The plan does
	// not promise to hit the exact SQLite commit instruction, so the only claim under
	// test is that a replay settles to exactly one complete record.
	const unconfirmed = ["v08-unconfirmed-1", "v08-unconfirmed-2", "v08-unconfirmed-3"];
	for (const operationId of unconfirmed) {
		const title = `unconfirmed ${operationId}`;
		await sendAndAbandon(service.port, token, { operationId, title });
		service.kill();
		await service.exited;

		service = await harness.spawn({ dataDir, token });
		await service.listening;
		const replayed = await createTodo(service.api, operationId, title);
		const again = await createTodo(service.api, operationId, title);
		assert.deepEqual(again, replayed, "the replay must be stable across repeated calls");
	}

	const listed = await callApi(service.api, "GET", "/v1/todos?status=all&limit=100");
	const items = itemsOf(listed);
	assert.equal(items.length, 1 + unconfirmed.length, `each operation must settle to one record, saw ${JSON.stringify(items)}`);
	assert.equal(new Set(items.map((todo) => todo.id)).size, items.length, "no two operations may share an id");
	await service.terminate();

	await stopAll(harness);
});

// --- V09: the exclusive file lock ---------------------------------------------

test("V09 a second process cannot open the same database, the first stays usable, and a crash releases it", async () => {
	const dataDir = await createRunDir("phase2-v09");
	const token = newToken();
	const harness = createHarness();

	const owner = await harness.spawn({ dataDir, token });
	await owner.listening;
	await createTodo(owner.api, "v09-owner", "owned by the first process");

	// A second process on a *different port* but the same file must fail before writing,
	// so port occupancy alone is not what protects the store.
	const intruder = await harness.spawn({ dataDir, token: newToken() });
	assert.notEqual(intruder.port, owner.port, "the second process must use a different port");
	const intruderCode = await Promise.race([intruder.exited, sleep(20_000).then(() => "timeout" as const)]);
	assert.notEqual(intruderCode, "timeout", `the second process must exit rather than hang\n${intruder.stderr()}`);
	assert.notEqual(intruderCode, 0, "the second process must not start successfully");
	assert.match(intruder.stderr(), /already in use/, `expected a busy diagnostic, got:\n${intruder.stderr()}`);

	// The owner is unaffected and still writable.
	const ownerView = await callApi(owner.api, "GET", "/v1/todos?status=all&limit=100");
	assert.equal(ownerView.status, 200);
	assert.equal(itemsOf(ownerView).length, 1, "the refused process must not have written");
	await createTodo(owner.api, "v09-owner-2", "still writable after the refusal");

	// A hard exit of the owner releases the file. Recovery must not depend on a lock
	// file's age or on clearing anything by hand.
	owner.kill();
	await owner.exited;
	const successor = await harness.spawn({ dataDir, token });
	await successor.listening;
	const afterCrash = await callApi(successor.api, "GET", "/v1/todos?status=all&limit=100");
	assert.equal(itemsOf(afterCrash).length, 2, "both writes must survive the crash");
	await successor.terminate();

	await stopAll(harness);
});

// --- V13: configuration, listen failure and shutdown --------------------------

test("V13 invalid configuration fails fast, a listen failure releases the store, and an interrupted burst settles cleanly", async () => {
	const dataDir = await createRunDir("phase2-v13");
	const harness = createHarness();

	// A short token is refused before anything is opened.
	const shortToken = await harness.spawn({ dataDir, token: "too-short" });
	assert.equal(await shortToken.exited, 1, `a short token must exit 1\n${shortToken.stderr()}`);
	assert.match(shortToken.stderr(), /token/i);

	// A port outside the valid range is refused.
	const badPort = await harness.spawn({ dataDir, token: newToken(), env: { ASSISTANT_PORT: "70000" } });
	assert.equal(await badPort.exited, 1, `an invalid port must exit 1\n${badPort.stderr()}`);
	assert.match(badPort.stderr(), /port/i);

	// Failing to listen must release the store that was already opened and locked. The
	// port is held open by this test, so the failure is deterministic.
	const held = await holdPort();
	try {
		const blocked = await harness.spawn({ dataDir, token: newToken(), port: held.port });
		const blockedCode = await Promise.race([blocked.exited, sleep(20_000).then(() => "timeout" as const)]);
		assert.notEqual(blockedCode, "timeout", `a listen failure must exit, not hang\n${blocked.stderr()}`);
		assert.equal(blockedCode, 1, blocked.stderr());
		assert.match(blocked.stderr(), /listener/i);
	} finally {
		await held.release();
	}
	// Proof that the lock was released: this process can take it right now.
	const store = await openAssistantStore(join(dataDir, ASSISTANT_DATABASE_FILENAME));
	await store.close();

	// Stopping the service mid-burst. On Windows this is a hard kill, so the claim is not
	// that the drain ran; it is that whatever the outcome was, every operation settles to
	// exactly one record afterwards. The drain itself is verified in
	// `phase2-shutdown.test.ts`.
	const token = newToken();
	const service = await harness.spawn({ dataDir, token });
	await service.listening;

	const operations = 12;
	const inFlight = Array.from({ length: operations }, (_unused, index) =>
		callApi(service.api, "POST", "/v1/todos", { body: { operationId: `v13-drain-${index}`, title: `drain ${index}` } })
			.then((response) => ({ kind: "response" as const, response }))
			.catch((error: unknown) => ({ kind: "error" as const, error })),
	);
	await sleep(15); // let the requests reach the listener
	const terminating = service.terminate();
	const settled = await Promise.all(inFlight);
	await terminating;
	await expectGone(service);

	for (const outcome of settled) {
		if (outcome.kind === "error") continue; // the socket was cut, so the outcome is unknown
		assert.ok(
			outcome.response.status === 200 || outcome.response.status === 503,
			`a drained request must succeed or report unavailability, got ${outcome.response.status}: ${outcome.response.text}`,
		);
		if (outcome.response.status === 503) assert.equal(errorCodeOf(outcome.response), "service_unavailable");
	}

	// A normal run never prints the secret and never prints a stack frame.
	assert.ok(!service.logs().includes(token), "the token must never be logged");
	assert.ok(!/^\s+at\s/m.test(service.logs()), `a normal run must not log a stack trace:\n${service.logs()}`);

	// Restart and replay each operation exactly once: this is where a request that was
	// cut off unknown either reuses its receipt or finally lands.
	const restarted = await harness.spawn({ dataDir, token });
	await restarted.listening;
	for (let index = 0; index < operations; index += 1) {
		await createTodo(restarted.api, `v13-drain-${index}`, `drain ${index}`);
	}
	const listed = await callApi(restarted.api, "GET", "/v1/todos?status=all&limit=100");
	const items = itemsOf(listed);
	assert.equal(items.length, operations, `each operation must settle to exactly one record, saw ${items.length}`);
	assert.equal(new Set(items.map((todo) => todo.id)).size, operations);
	await restarted.terminate();

	await stopAll(harness);
});
