// -----------------------------------------------------------------------------
// Phase 3 verification, pi bridge: V14 (protocol) and V15 (failure modes).
//
// The tools are driven through a *captured* host: a real `registerTool` call is
// intercepted so the tests can execute the exact function object pi would execute, with
// the real params/signal signatures. Every success path then talks to a real listener on
// a real loopback port over real HTTP, so nothing here can pass because of a mock.
//
// Failure paths use real sockets too: a reserved-but-unbound port for "nothing is
// listening", a raw TCP server that hangs for the timeout, and one that resets the
// connection for "the outcome is unknown". A stub is never used as a stand-in for the
// service's *success* behaviour — only to inject a transport-level fault the real
// service cannot be asked to produce.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionToolDefinition, ExtensionToolResult } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import {
	ASSISTANT_BRIDGE_DEFAULT_PORT,
	ASSISTANT_BRIDGE_MAX_PAGE_SIZE,
	ASSISTANT_BRIDGE_OPERATION_ID_PATTERN,
	ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS,
	ASSISTANT_BRIDGE_TITLE_MAX_CHARS,
	deriveOperationId,
	registerDurableAssistantTools,
} from "../../extensions/durable-assistant/index.ts";
import {
	ASSISTANT_CLIENT_DEFAULT_LIMIT,
	ASSISTANT_CLIENT_DEFAULT_TIMEOUT_MS,
	ASSISTANT_CLIENT_MAX_LIMIT,
	ASSISTANT_SERVICE_ERROR_CODES,
} from "../../extensions/durable-assistant/client.ts";
import { ASSISTANT_DEFAULT_PORT } from "../../src/assistant/config.ts";
import { ASSISTANT_LIMITS, normalizeOperationId, type Todo } from "../../src/assistant/store.ts";
import {
	callApi,
	createRunDir,
	databasePathIn,
	reserveFreePort,
	startTestService,
	type TestService,
} from "./helpers.ts";

const TOOL_CREATE = "assistant_todo_create";
const TOOL_LIST = "assistant_todo_list";
const TOOL_GET = "assistant_todo_get";
const TOOL_COMPLETE = "assistant_todo_complete";
const ALL_TOOLS = [TOOL_CREATE, TOOL_LIST, TOOL_GET, TOOL_COMPLETE] as const;

// --- host capture -------------------------------------------------------------

type TestHost = {
	readonly api: ExtensionAPI;
	readonly tools: Map<string, ExtensionToolDefinition>;
};

/** A minimal stand-in for pi that records what the extension registers. */
const createTestHost = (): TestHost => {
	const tools = new Map<string, ExtensionToolDefinition>();
	const api: ExtensionAPI = {
		registerTool<TParams extends TSchema>(tool: ExtensionToolDefinition<TParams>): void {
			tools.set(tool.name, tool);
		},
	};
	return { api, tools };
};

/** The `details` the bridge attaches to a result. */
type Envelope = {
	readonly ok: boolean;
	readonly tool: string;
	readonly code?: string;
	readonly definitelyNotApplied?: boolean;
	readonly operationId?: string;
	readonly httpStatus?: number;
	readonly todo?: Todo;
	readonly items?: readonly Todo[];
	readonly nextCursor?: string | null;
};

const envelopeOf = (result: ExtensionToolResult<unknown>): Envelope => result.details as Envelope;

const textOf = (result: ExtensionToolResult<unknown>): string =>
	result.content
		.map((part) => part.text)
		.join("\n");

/**
 * Execute a registered tool exactly as pi would. `onUpdate`/`ctx` are `undefined`
 * because the bridge declares it does not use them; a tool that started reading them
 * would fail loudly here rather than silently at runtime.
 */
const runTool = async (
	host: TestHost,
	name: string,
	params: Record<string, unknown>,
	options: { readonly toolCallId?: string; readonly signal?: AbortSignal } = {},
): Promise<ExtensionToolResult<unknown>> => {
	const tool = host.tools.get(name);
	assert.ok(tool !== undefined, `${name} was not registered`);
	return await tool.execute(options.toolCallId ?? "call-1", params, options.signal, undefined, undefined);
};

/** Assert a result is a *reported* failure, and return its envelope for detail checks. */
const failureOf = (result: ExtensionToolResult<unknown>): Envelope => {
	assert.equal(result.isError, true, `expected an error result, got: ${textOf(result)}`);
	const envelope = envelopeOf(result);
	assert.equal(envelope.ok, false);
	return envelope;
};

const successOf = (result: ExtensionToolResult<unknown>): Envelope => {
	assert.notEqual(result.isError, true, `expected success, got: ${textOf(result)}`);
	const envelope = envelopeOf(result);
	assert.equal(envelope.ok, true);
	// `details` and `structuredContent` are two views of the same fact; a divergence
	// means a UI and the model would disagree about what happened.
	assert.deepEqual(result.structuredContent, result.details);
	return envelope;
};

/** Environment for a bridge pointed at a running test service. */
const envFor = (service: TestService): Record<string, string> => ({
	ASSISTANT_PORT: String(service.server.port),
	ASSISTANT_TOKEN: service.token,
});

const hostFor = (env: Record<string, string | undefined>): TestHost => {
	const host = createTestHost();
	registerDurableAssistantTools(host.api, env);
	return host;
};

const withService = async (label: string, body: (service: TestService) => Promise<void>): Promise<void> => {
	const runDir = await createRunDir(label);
	const service = await startTestService(databasePathIn(runDir));
	try {
		await body(service);
	} finally {
		await service.close();
	}
};

/** Every todo the service holds, read with the service's own API rather than through the bridge. */
const allTodos = async (service: TestService): Promise<Todo[]> => {
	const response = await callApi(service, "GET", "/v1/todos?status=all&limit=100");
	assert.equal(response.status, 200);
	return (response.json?.items ?? []) as unknown as Todo[];
};

const newUuid = (): string => crypto.randomUUID();

// --- raw transport stubs ------------------------------------------------------

type StubServer = {
	readonly port: number;
	readonly requestCount: () => number;
	readonly close: () => Promise<void>;
};

/**
 * A listener that answers with a fixed raw payload. Used only to produce responses the
 * real service would never send (a non-JSON body, an unreadable error, a 500).
 */
const startHttpStub = async (
	handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<StubServer & { readonly requests: () => Array<{ method: string; path: string; body: string; authorization: string | undefined }> }> => {
	const requests: Array<{ method: string; path: string; body: string; authorization: string | undefined }> = [];
	const server = createHttpServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({
				method: request.method ?? "",
				path: request.url ?? "",
				body,
				authorization: request.headers.authorization,
			});
			handler(request, body, response);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("stub server has no port");
	return {
		port: address.port,
		requests: () => requests,
		requestCount: () => requests.length,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
};

/** A raw TCP listener that accepts a connection and then resets it without answering. */
const startResettingServer = async (): Promise<StubServer> => {
	const sockets: Socket[] = [];
	const server = createNetServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		socket.on("data", () => socket.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("resetting server has no port");
	return {
		port: address.port,
		requestCount: () => sockets.length,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
};

/** A raw TCP listener that reads the request and never answers, so the client times out. */
const startHangingServer = async (): Promise<StubServer> => {
	const sockets: Socket[] = [];
	const server = createNetServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		// Read and discard: the request is fully received, so this is a real timeout,
		// not a connection-level failure.
		socket.on("data", () => undefined);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("hanging server has no port");
	return {
		port: address.port,
		requestCount: () => sockets.length,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
};

// =============================================================================
// V14 — bridge protocol
// =============================================================================

test("V14: registration captures four tools without touching the environment", () => {
	// An empty environment on purpose: config must be resolved when a tool runs, not
	// when the extension loads. A throw here would make pi refuse to start at all.
	const host = hostFor({});
	assert.deepEqual([...host.tools.keys()].sort(), [...ALL_TOOLS].sort());
	for (const name of ALL_TOOLS) {
		const tool = host.tools.get(name);
		assert.ok(tool !== undefined);
		assert.ok(tool.description.length > 0, `${name} has no description`);
		assert.ok(tool.label.length > 0, `${name} has no label`);
		assert.equal(typeof tool.parameters, "object");
	}
});

test("V14: create, list, get and complete round-trip over real HTTP", async () => {
	await withService("v14-roundtrip", async (service) => {
		const host = hostFor(envFor(service));

		const created = successOf(await runTool(host, TOOL_CREATE, { title: "  buy milk  " }, { toolCallId: "call-a" }));
		const todo = created.todo;
		assert.ok(todo !== undefined);
		// The service trims, and the bridge reports what the service stored.
		assert.equal(todo.title, "buy milk");
		assert.equal(todo.status, "open");
		assert.equal(todo.completedAt, null);
		assert.match(todo.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		// The model reads `content`; it must name the same id the details carry.
		assert.ok(textOf(await runTool(host, TOOL_GET, { id: todo.id })).includes(todo.id));

		// The record is really in the service, not just in the tool's return value.
		const fetched = await callApi(service, "GET", `/v1/todos/${todo.id}`);
		assert.equal(fetched.status, 200);
		assert.deepEqual(fetched.json?.todo, todo);

		const listed = successOf(await runTool(host, TOOL_LIST, {}));
		assert.deepEqual(listed.items, [todo]);
		assert.equal(listed.nextCursor, null);

		const completed = successOf(await runTool(host, TOOL_COMPLETE, { id: todo.id }, { toolCallId: "call-b" }));
		assert.equal(completed.todo?.status, "done");
		assert.ok(completed.todo?.completedAt !== null);

		// The filters the tool exposes really filter.
		assert.deepEqual(successOf(await runTool(host, TOOL_LIST, { status: "open" })).items, []);
		assert.equal(successOf(await runTool(host, TOOL_LIST, { status: "done" })).items?.length, 1);
		assert.equal((await allTodos(service)).length, 1);

		const after = successOf(await runTool(host, TOOL_GET, { id: todo.id }));
		assert.equal(after.todo?.status, "done");
		assert.equal(after.todo?.completedAt, completed.todo?.completedAt);
	});
});

test("V14: replaying a tool call creates exactly one todo", async () => {
	await withService("v14-replay", async (service) => {
		const host = hostFor(envFor(service));
		const params = { title: "water the plants" };

		// pi re-executing the same tool call (same toolCallId) must be idempotent: the
		// derived operationId is the same, so the service resolves it to the same todo.
		const firstResult = await runTool(host, TOOL_CREATE, params, { toolCallId: "call-1" });
		const first = successOf(firstResult);
		// Details are for the UI and deliberately carry no operationId on success — there is
		// nothing to retry. The model-visible text does carry it, because that is where the
		// recovery instructions point. Both halves of that split are pinned here.
		assert.equal(first.operationId, undefined);
		const reported = /operationId: (\S+)/.exec(textOf(firstResult))?.[1];
		assert.ok(reported !== undefined && reported.length > 0, `no operationId in the model-visible text:\n${textOf(firstResult)}`);
		// The id the model is told to keep is the one the tool actually used.
		assert.equal(reported, deriveOperationId("call-1"));

		// pi re-executing the same tool call (same toolCallId) must be idempotent: the
		// derived operationId is the same, so the service resolves it to the same todo.
		const second = successOf(await runTool(host, TOOL_CREATE, params, { toolCallId: "call-1" }));
		assert.equal(second.todo?.id, first.todo?.id);
		assert.deepEqual(second.todo, first.todo);
		assert.equal((await allTodos(service)).length, 1);

		// Retrying with the operationId the text reported — the recovery path the tool's own
		// guidelines describe — must also resolve to the same todo rather than adding one.
		const retried = successOf(
			await runTool(host, TOOL_CREATE, { title: "water the plants", operationId: reported }, { toolCallId: "call-2" }),
		);
		assert.equal(retried.todo?.id, first.todo?.id);
		assert.equal((await allTodos(service)).length, 1);

		// Reusing an operationId for a *different* intention is a conflict, not a silent
		// no-op: the model must not believe a second todo was created.
		const conflict = failureOf(
			await runTool(host, TOOL_CREATE, { title: "walk the dog", operationId: reported }, { toolCallId: "call-3" }),
		);
		assert.equal(conflict.code, "operation_conflict");
		assert.equal(conflict.httpStatus, 409);
		assert.equal(conflict.definitelyNotApplied, true);
		assert.equal((await allTodos(service)).length, 1);
	});
});

test("V14: an unknown todo and a bad token are explicit failures", async () => {
	await withService("v14-notfound", async (service) => {
		const host = hostFor(envFor(service));

		const missing = failureOf(await runTool(host, TOOL_GET, { id: newUuid() }));
		assert.equal(missing.code, "not_found");
		assert.equal(missing.httpStatus, 404);
		assert.equal(missing.definitelyNotApplied, true);
		assert.ok(textOf(await runTool(host, TOOL_GET, { id: newUuid() })).length > 0);

		// Completing something that does not exist must not create a ghost record.
		const ghost = failureOf(await runTool(host, TOOL_COMPLETE, { id: newUuid() }, { toolCallId: "call-x" }));
		assert.equal(ghost.code, "not_found");
		assert.equal((await allTodos(service)).length, 0);

		const unauthorized = hostFor({ ASSISTANT_PORT: String(service.server.port), ASSISTANT_TOKEN: "wrong-token" });
		const denied = failureOf(await runTool(unauthorized, TOOL_CREATE, { title: "should not exist" }, { toolCallId: "call-y" }));
		assert.equal(denied.code, "unauthorized");
		assert.equal(denied.httpStatus, 401);
		assert.equal(denied.definitelyNotApplied, true);
		// The service really rejected it: the correct token still sees an empty store.
		assert.equal((await allTodos(service)).length, 0);
	});
});

test("V14: input is validated before any request is sent", async () => {
	// Nothing is listening on this port, so a validation failure must be reported as
	// `invalid_input` — the only way to distinguish "rejected locally" from "the service
	// was never reached" without observing the network.
	const deadPort = await reserveFreePort();
	const host = hostFor({ ASSISTANT_PORT: String(deadPort), ASSISTANT_TOKEN: "irrelevant-but-present" });

	const cases: Array<{ readonly name: string; readonly params: Record<string, unknown> }> = [
		{ name: TOOL_CREATE, params: { title: "   " } },
		{ name: TOOL_CREATE, params: { title: "x".repeat(ASSISTANT_BRIDGE_TITLE_MAX_CHARS + 1) } },
		{ name: TOOL_CREATE, params: { title: "ok", operationId: "has spaces" } },
		{ name: TOOL_CREATE, params: { title: "ok", operationId: "x".repeat(ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS + 1) } },
		{ name: TOOL_CREATE, params: { title: 42 } },
		{ name: TOOL_LIST, params: { status: "pending" } },
		{ name: TOOL_LIST, params: { limit: 0 } },
		{ name: TOOL_LIST, params: { limit: ASSISTANT_BRIDGE_MAX_PAGE_SIZE + 1 } },
		{ name: TOOL_LIST, params: { limit: "twenty" } },
		{ name: TOOL_GET, params: { id: "" } },
		{ name: TOOL_COMPLETE, params: { id: "   " } },
	];

	for (const testCase of cases) {
		const result = await runTool(host, testCase.name, testCase.params);
		const envelope = failureOf(result);
		assert.equal(envelope.code, "invalid_input", `${testCase.name} ${JSON.stringify(testCase.params)}`);
		assert.equal(envelope.definitelyNotApplied, true);
		assert.match(textOf(result), /Nothing was sent to the assistant service\./);
	}
});

test("V14: a missing token is a tool failure, not a load failure", async () => {
	const host = hostFor({});
	const result = await runTool(host, TOOL_LIST, {});
	const envelope = failureOf(result);
	assert.equal(envelope.definitelyNotApplied, true);
	assert.match(textOf(result), /ASSISTANT_TOKEN is not set/);
});

test("V14: bridge constants match the service they talk to", () => {
	assert.equal(ASSISTANT_BRIDGE_DEFAULT_PORT, ASSISTANT_DEFAULT_PORT);
	assert.equal(ASSISTANT_BRIDGE_TITLE_MAX_CHARS, ASSISTANT_LIMITS.titleMaxChars);
	assert.equal(ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS, ASSISTANT_LIMITS.operationIdMaxChars);
	assert.equal(ASSISTANT_BRIDGE_MAX_PAGE_SIZE, ASSISTANT_LIMITS.maxPageSize);
	assert.equal(ASSISTANT_CLIENT_MAX_LIMIT, ASSISTANT_LIMITS.maxPageSize);
	assert.equal(ASSISTANT_CLIENT_DEFAULT_LIMIT, ASSISTANT_LIMITS.defaultPageSize);

	// The operationId alphabet is compared by behaviour, which is what actually matters:
	// anything the bridge lets through must be accepted by the service, and anything the
	// bridge rejects must be rejected by the service. Comparing the regexes themselves
	// would pass even if one of them were used differently.
	const corpus = [
		"plain",
		"call_abc-123.4:5",
		"a".repeat(ASSISTANT_LIMITS.operationIdMaxChars),
		"with space",
		"with/slash",
		"with+plus",
		"emoji-🙂",
		"",
		"a".repeat(ASSISTANT_LIMITS.operationIdMaxChars + 1),
	];
	for (const candidate of corpus) {
		const bridgeAccepts = ASSISTANT_BRIDGE_OPERATION_ID_PATTERN.test(candidate) && candidate.length > 0 && candidate.length <= ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS;
		let serviceAccepts = true;
		try {
			normalizeOperationId(candidate);
		} catch {
			serviceAccepts = false;
		}
		assert.equal(bridgeAccepts, serviceAccepts, `operationId ${JSON.stringify(candidate)}: bridge=${bridgeAccepts} service=${serviceAccepts}`);
	}
});

test("V14: the derived operationId is usable by the service and collision-free", () => {
	// Whatever a provider puts in a toolCallId, the derived id must satisfy the
	// service's alphabet and length rules, or a retry would fail validation.
	const samples = [
		"call_abc123",
		"toolu_01ABCdef",
		"a".repeat(200),
		"has spaces and /slashes/",
		"emoji-🙂-id",
		"",
		"x".repeat(ASSISTANT_LIMITS.operationIdMaxChars),
		"x".repeat(ASSISTANT_LIMITS.operationIdMaxChars + 1),
	];
	for (const sample of samples) {
		const derived = deriveOperationId(sample);
		assert.ok(derived.length > 0 && derived.length <= ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS, `bad length for ${JSON.stringify(sample)}`);
		assert.match(derived, ASSISTANT_BRIDGE_OPERATION_ID_PATTERN);
		assert.doesNotThrow(() => normalizeOperationId(derived));
	}
	// Two different tool calls must never collapse onto one operationId: an over-long id
	// is replaced rather than truncated, because truncation would make distinct calls
	// alias onto the same todo.
	const long = (suffix: string): string => "y".repeat(ASSISTANT_LIMITS.operationIdMaxChars + 5) + suffix;
	assert.notEqual(deriveOperationId(long("one")), deriveOperationId(long("two")));
	assert.equal(deriveOperationId("stable-id"), "stable-id");
});

// =============================================================================
// V15 — bridge failure modes
// =============================================================================

test("V15: an unreachable service is reported as definitely not applied", async () => {
	const deadPort = await reserveFreePort();
	const host = hostFor({ ASSISTANT_PORT: String(deadPort), ASSISTANT_TOKEN: "irrelevant-but-present" });

	const read = await runTool(host, TOOL_LIST, {});
	const readEnvelope = failureOf(read);
	assert.equal(readEnvelope.code, "service_unreachable");
	// A refused connection proves the request was never processed, so the bridge may say
	// so plainly. Claiming "unknown" here would make the model retry needlessly.
	assert.equal(readEnvelope.definitelyNotApplied, true);
	assert.match(textOf(read), /is not reachable at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
	assert.match(textOf(read), /No todo data was changed\. Reading again is safe\./);

	const write = await runTool(host, TOOL_CREATE, { title: "never stored" }, { toolCallId: "call-dead" });
	const writeEnvelope = failureOf(write);
	assert.equal(writeEnvelope.code, "service_unreachable");
	assert.equal(writeEnvelope.definitelyNotApplied, true);
	assert.match(textOf(write), /Nothing was written/);
	assert.doesNotMatch(textOf(write), /UNKNOWN/);
});

test("V15: a dropped connection leaves the outcome unknown and hands back the operationId", async () => {
	const server = await startResettingServer();
	try {
		const host = hostFor({ ASSISTANT_PORT: String(server.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const result = await runTool(host, TOOL_CREATE, { title: "maybe stored" }, { toolCallId: "call-dropped" });
		const envelope = failureOf(result);
		assert.equal(envelope.code, "outcome_unknown");
		assert.equal(envelope.definitelyNotApplied, false);
		// The operationId is surfaced in both the details and the prose, because the only
		// safe recovery is a retry with the same id.
		assert.equal(envelope.operationId, "call-dropped");
		assert.match(textOf(result), /The outcome is UNKNOWN/);
		assert.match(textOf(result), /Retry with operationId "call-dropped"/);
		// No silent retry: one attempt, one connection.
		assert.equal(server.requestCount(), 1);
	} finally {
		await server.close();
	}
});

test("V15: a hung service times out as an unknown outcome", { timeout: 30_000 }, async () => {
	const server = await startHangingServer();
	try {
		const host = hostFor({ ASSISTANT_PORT: String(server.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const result = await runTool(host, TOOL_COMPLETE, { id: newUuid() }, { toolCallId: "call-hung" });
		const envelope = failureOf(result);
		assert.equal(envelope.code, "outcome_unknown");
		assert.equal(envelope.definitelyNotApplied, false);
		assert.match(textOf(result), new RegExp(`did not answer within ${ASSISTANT_CLIENT_DEFAULT_TIMEOUT_MS}ms`));
		assert.match(textOf(result), /Retry with operationId "call-hung"/);
		assert.equal(server.requestCount(), 1);
	} finally {
		await server.close();
	}
});

test("V15: a cancelled call is reported instead of disappearing", async () => {
	const server = await startHangingServer();
	try {
		const host = hostFor({ ASSISTANT_PORT: String(server.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const controller = new AbortController();
		controller.abort();
		const result = await runTool(host, TOOL_CREATE, { title: "cancelled" }, { toolCallId: "call-cancel", signal: controller.signal });
		const envelope = failureOf(result);
		assert.equal(envelope.code, "outcome_unknown");
		assert.equal(envelope.definitelyNotApplied, false);
		assert.match(textOf(result), /was cancelled, so the request may still be running/);
	} finally {
		await server.close();
	}
});

test("V15: an unreadable response is a controlled failure", async () => {
	// A 200 that is not JSON: the service accepted the request, so nothing may be
	// reported as "not applied".
	const notJson = await startHttpStub((_request, _body, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("this is not json");
	});
	try {
		const host = hostFor({ ASSISTANT_PORT: String(notJson.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const result = await runTool(host, TOOL_LIST, {});
		const envelope = failureOf(result);
		assert.equal(envelope.code, "malformed_response");
		assert.equal(envelope.definitelyNotApplied, false);
		assert.match(textOf(result), /empty body/);
	} finally {
		await notJson.close();
	}

	// JSON, but not the shape the contract promises.
	const wrongShape = await startHttpStub((_request, _body, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ todo: { id: 1 } }));
	});
	try {
		const host = hostFor({ ASSISTANT_PORT: String(wrongShape.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const envelope = failureOf(await runTool(host, TOOL_GET, { id: newUuid() }));
		assert.equal(envelope.code, "malformed_response");
	} finally {
		await wrongShape.close();
	}

	// An error status with an unreadable body: a 4xx cannot have written anything...
	const badRequest = await startHttpStub((_request, _body, response) => {
		response.writeHead(400, { "content-type": "text/plain" });
		response.end("nope");
	});
	try {
		const host = hostFor({ ASSISTANT_PORT: String(badRequest.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const envelope = failureOf(await runTool(host, TOOL_CREATE, { title: "x" }, { toolCallId: "call-400" }));
		assert.equal(envelope.code, "malformed_response");
		assert.equal(envelope.httpStatus, 400);
		assert.equal(envelope.definitelyNotApplied, true);
	} finally {
		await badRequest.close();
	}

	// ...but a 5xx may have committed and then failed while answering, so it must stay
	// an unknown outcome rather than inviting a duplicate create.
	const serverError = await startHttpStub((_request, _body, response) => {
		response.writeHead(500, { "content-type": "text/html" });
		response.end("<html>boom</html>");
	});
	try {
		const host = hostFor({ ASSISTANT_PORT: String(serverError.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const envelope = failureOf(await runTool(host, TOOL_CREATE, { title: "x" }, { toolCallId: "call-500" }));
		assert.equal(envelope.code, "malformed_response");
		assert.equal(envelope.httpStatus, 500);
		assert.equal(envelope.definitelyNotApplied, false);
	} finally {
		await serverError.close();
	}
});

test("V15: a service error is surfaced once and never retried", async () => {
	const stub = await startHttpStub((_request, _body, response) => {
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { code: "internal_error", message: "the store exploded" } }));
	});
	try {
		const host = hostFor({ ASSISTANT_PORT: String(stub.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
		const result = await runTool(host, TOOL_CREATE, { title: "one attempt" }, { toolCallId: "call-500-json" });
		const envelope = failureOf(result);
		assert.equal(envelope.code, "internal_error");
		assert.equal(envelope.httpStatus, 500);
		// A readable service error means the store rolled back, so nothing was written.
		assert.equal(envelope.definitelyNotApplied, true);
		assert.match(textOf(result), /the store exploded/);
		assert.equal(stub.requestCount(), 1, "a mutation must not be retried behind the model's back");
	} finally {
		await stub.close();
	}
});

test("V15: every service error code the client can meet is recognised", async () => {
	// The client maps an unknown code to `internal_error`. That fallback exists for a
	// newer service, but it must never swallow a code the current service actually uses.
	for (const code of ASSISTANT_SERVICE_ERROR_CODES) {
		const stub = await startHttpStub((_request, _body, response) => {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { code, message: `stub ${code}` } }));
		});
		try {
			const host = hostFor({ ASSISTANT_PORT: String(stub.port), ASSISTANT_TOKEN: "irrelevant-but-present" });
			const envelope = failureOf(await runTool(host, TOOL_LIST, {}));
			assert.equal(envelope.code, code);
		} finally {
			await stub.close();
		}
	}
});

test("V15: loading the extension performs no I/O", async () => {
	// A factory that probed the service or opened a socket at load time would make pi's
	// startup depend on the assistant service being up. `fetch` is poisoned to prove it.
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (() => {
		fetchCalls += 1;
		throw new Error("the extension must not use the network while loading");
	}) as typeof globalThis.fetch;
	try {
		const host = createTestHost();
		const { default: factory } = await import("../../extensions/durable-assistant/index.ts");
		factory(host.api);
		assert.equal(fetchCalls, 0);
		assert.deepEqual([...host.tools.keys()].sort(), [...ALL_TOOLS].sort());
	} finally {
		globalThis.fetch = originalFetch;
	}
});
