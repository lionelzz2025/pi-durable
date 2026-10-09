// -----------------------------------------------------------------------------
// Phase 2 verification, the graceful half of V13: the drain, the signal wiring and
// the release of the exclusive lock.
//
// Why this is in-process. On Windows Node cannot deliver SIGTERM or SIGINT to
// another process: `child.kill("SIGTERM")` terminates the target outright and no
// handler runs. `phase2-process.test.ts` therefore only claims that a hard exit
// loses nothing. Here the signal source is a real `EventEmitter` handed to
// `installShutdownHandlers`, so the exact wiring `main.ts` installs is exercised,
// and the drain runs against a real listener and a real SQLite store.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import { createShutdownController, installShutdownHandlers } from "../../src/assistant/lifecycle.ts";
import { AssistantError, createTodoService } from "../../src/assistant/store.ts";
import { startAssistantServer } from "../../src/assistant/server.ts";
import { openAssistantStore } from "../../src/assistant/storage.ts";
import { callApi, createRunDir, databasePathIn, newToken, sleep, startTestService } from "./helpers.ts";

/** Read a socket to end. Every response carries `connection: close`, so this ends. */
const collect = async (socket: NodeJS.ReadableStream): Promise<string> => {
	let text = "";
	for await (const chunk of socket) text += String(chunk);
	return text;
};

// --- the controller ----------------------------------------------------------

test("V13 the shutdown controller closes exactly once, however many times it is asked", async () => {
	let closeCalls = 0;
	let release: () => void = () => undefined;
	const controller = createShutdownController({
		close: () => {
			closeCalls += 1;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});

	assert.equal(controller.state(), "running");
	assert.equal(controller.draining(), false);

	const first = controller.shutdown("SIGINT");
	assert.equal(controller.state(), "draining");
	assert.equal(controller.draining(), true);
	const second = controller.shutdown("SIGTERM");

	assert.equal(closeCalls, 1, "two requests must not close the listener and the store twice");
	assert.equal(first, second, "both callers must observe the same drain");
	assert.equal(controller.shutdown("again"), first);

	release();
	await first;
	assert.equal(controller.state(), "stopped");
	assert.equal(controller.draining(), false);
	await controller.shutdown("SIGINT");
	assert.equal(closeCalls, 1, "a settled controller must not close again");
});

// --- the wiring --------------------------------------------------------------

test("V13 a first signal drains rather than exits, and a second signal is the escape hatch", async () => {
	const source = new EventEmitter();
	const exits: number[] = [];
	let closeCalls = 0;
	let release: () => void = () => undefined;
	const controller = createShutdownController({
		close: () => {
			closeCalls += 1;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	installShutdownHandlers({ controller, source, exit: (code) => exits.push(code) });

	source.emit("SIGINT");
	assert.equal(closeCalls, 1, "SIGINT must start the drain");
	assert.deepEqual(exits, [], "one signal must not force an exit: closing the listener empties the event loop");

	// A drain that hangs must not trap the operator.
	source.emit("SIGTERM");
	assert.deepEqual(exits, [1], "a second signal must exit immediately");

	release();
	await controller.shutdown("test");
	assert.equal(controller.state(), "stopped");
});

test("V13 a fatal process error drains and then exits 1, and a failed drain exits 1", async () => {
	// Fatal error: the listener must not be left half-open.
	const source = new EventEmitter();
	const exits: number[] = [];
	const failures: string[] = [];
	const controller = createShutdownController({ close: async () => undefined });
	installShutdownHandlers({
		controller,
		source,
		exit: (code) => exits.push(code),
		failure: (message) => failures.push(message),
	});

	source.emit("uncaughtException", new Error("boom"));
	await controller.shutdown("test");
	await sleep(10);
	assert.equal(controller.state(), "stopped");
	assert.deepEqual(exits, [1], "a fatal error must end the process, not leave it running");
	assert.deepEqual(failures, ["uncaughtException"]);
	assert.ok(!failures.some((message) => message.includes("boom")), "the failure writer gets the error separately");

	// A drain that fails must still end the process, with a non-zero code.
	const failingSource = new EventEmitter();
	const failingExits: number[] = [];
	const failing = createShutdownController({
		close: async () => {
			throw new Error("the store refused to close");
		},
	});
	installShutdownHandlers({
		controller: failing,
		source: failingSource,
		exit: (code) => failingExits.push(code),
	});
	failingSource.emit("SIGTERM");
	await failing.shutdown("test").catch(() => undefined);
	await sleep(10);
	assert.deepEqual(failingExits, [1], "a failed drain must not exit 0");
});

// --- the drain against a real listener and a real store ----------------------

test("V13 close waits for a request it accepted, answers it, and only then releases the lock", async () => {
	const runDir = await createRunDir("phase2-drain");
	const databasePath = databasePathIn(runDir);
	const service = await startTestService(databasePath);

	// A request whose headers have arrived is dispatched immediately, but the handler is
	// still waiting for the body. That makes "accepted work still in flight" observable
	// without a slow endpoint or a test-only hook.
	const payload = JSON.stringify({ operationId: "drain-held-open", title: "held open" });
	const socket = connect(service.server.port, "127.0.0.1");
	await once(socket, "connect");
	socket.write(
		"POST /v1/todos HTTP/1.1\r\n" +
			`Host: 127.0.0.1:${service.server.port}\r\n` +
			`Authorization: Bearer ${service.token}\r\n` +
			"Content-Type: application/json\r\n" +
			`Content-Length: ${Buffer.byteLength(payload)}\r\n` +
			"Connection: close\r\n\r\n" +
			payload.slice(0, 5),
	);
	await sleep(60);
	assert.equal(service.server.inFlight(), 1, "the handler should be waiting for the body");

	let settled = false;
	const closing = service.server.close();
	void closing.then(() => {
		settled = true;
	});
	await sleep(60);
	assert.equal(service.server.state(), "closing");
	assert.equal(settled, false, "close must drain an accepted request, not abort it");

	socket.write(payload.slice(5));
	const raw = await collect(socket);
	assert.match(raw, /^HTTP\/1\.1 200 /, `the drained request must be answered:\n${raw}`);
	assert.match(raw, /"title":"held open"/);

	await closing;
	assert.equal(settled, true);
	assert.equal(service.server.inFlight(), 0, "no handler may outlive the drain");
	assert.equal(service.server.state(), "closing");

	// The write landed, the replay is stable, and the exclusive lock is gone: a fresh
	// handle on the same file opens without waiting or clearing anything by hand.
	const store = await openAssistantStore(databasePath);
	try {
		const todos = createTodoService(store);
		const replayed = await todos.createTodo({ operationId: "drain-held-open", title: "held open" });
		assert.equal(replayed.title, "held open", "the replay must return the original record");
		// The receipt is a fingerprint, not just an id: the same operationId with different
		// content is a bug in the caller, and must not silently overwrite the first write.
		await assert.rejects(
			() => todos.createTodo({ operationId: "drain-held-open", title: "something else" }),
			(error: unknown) => error instanceof AssistantError && error.code === "operation_conflict",
		);
		const listed = await todos.listTodos({ status: "all", limit: 10 });
		assert.equal(listed.items.length, 1, "the drained request must have committed exactly once");
	} finally {
		await store.close();
	}
});

test("V13 a closed listener refuses new work, and the store it locked reopens at once", async () => {
	const runDir = await createRunDir("phase2-closed");
	const databasePath = databasePathIn(runDir);
	const token = newToken();
	const store = await openAssistantStore(databasePath);
	const server = await startAssistantServer({ store, token, port: 0, host: "127.0.0.1", version: "test" });
	const api = { url: `http://127.0.0.1:${server.port}`, token };

	const created = await callApi(api, "POST", "/v1/todos", { body: { operationId: "closed-1", title: "before" } });
	assert.equal(created.status, 200, created.text);

	await server.close();
	assert.equal(server.state(), "closing");

	const refused = await callApi(api, "GET", "/health").then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.ok(refused instanceof Error, "a closed listener must refuse connections instead of hanging");

	const reopened = await openAssistantStore(databasePath);
	try {
		const todos = createTodoService(reopened);
		const listed = await todos.listTodos({ status: "all", limit: 10 });
		assert.equal(listed.items.length, 1, "the record written before the close must be intact");
	} finally {
		await reopened.close();
	}
});
