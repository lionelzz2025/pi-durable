// -----------------------------------------------------------------------------
// Phase 2 verification, HTTP contract: V10, V11, V12.
//
// These drive a real listener on a random loopback port with `fetch`, so they cover
// the transport, the auth gate and the request parser. Lifecycle and multi-process
// behaviour (V03, V07, V08, V09, V13) live in phase2-process.test.ts.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import { ASSISTANT_LIMITS } from "../../src/assistant/store.ts";
import {
	callApi,
	createRunDir,
	databasePathIn,
	errorCodeOf,
	startTestService,
	type TestService,
} from "./helpers.ts";

const withService = async (
	label: string,
	body: (service: TestService) => Promise<void>,
): Promise<void> => {
	const runDir = await createRunDir(label);
	const service = await startTestService(databasePathIn(runDir));
	try {
		await body(service);
	} finally {
		await service.close();
	}
};

const todosIn = (json: Record<string, unknown> | undefined): Array<Record<string, unknown>> => {
	const items = json?.items;
	assert.ok(Array.isArray(items), "expected an `items` array");
	return items as Array<Record<string, unknown>>;
};

const todoIn = (json: Record<string, unknown> | undefined): Record<string, unknown> => {
	const todo = json?.todo;
	assert.ok(typeof todo === "object" && todo !== null, "expected a `todo` object");
	return todo as Record<string, unknown>;
};

// --- V10: authentication, binding and non-disclosure -------------------------

test("V10 every route requires the token, cross-origin is refused, and the listener is loopback-only", async () => {
	await withService("phase2-v10", async (service) => {
		// Anonymous requests are refused, on the health route as well.
		for (const [method, path] of [
			["GET", "/health"],
			["GET", "/v1/todos"],
			["POST", "/v1/todos"],
		] as const) {
			const anonymous = await callApi(service, method, path, { token: null, body: method === "POST" ? { operationId: "v10-anon", title: "nope" } : undefined });
			assert.equal(anonymous.status, 401, `${method} ${path} must require a token`);
			assert.equal(errorCodeOf(anonymous), "unauthorized");
			assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
		}

		// A wrong token, a truncated token, and a non-Bearer scheme are all 401.
		const wrong = await callApi(service, "GET", "/health", { token: "test-but-not-the-right-token-value-000000" });
		assert.equal(wrong.status, 401);
		const scheme = await callApi(service, "GET", "/health", { token: null, headers: { authorization: `Basic ${service.token}` } });
		assert.equal(scheme.status, 401);
		const unqualified = await callApi(service, "GET", "/health", { token: null, headers: { authorization: "Bearer" } });
		assert.equal(unqualified.status, 401);

		// A browser always sends Origin on a cross-origin request; we serve no HTML.
		const crossOrigin = await callApi(service, "POST", "/v1/todos", {
			headers: { origin: "http://evil.example" },
			body: { operationId: "v10-origin", title: "should not exist" },
		});
		assert.equal(crossOrigin.status, 403);
		assert.equal(errorCodeOf(crossOrigin), "cross_origin_forbidden");

		// No refused request may have written anything.
		const listed = await callApi(service, "GET", "/v1/todos?status=all");
		assert.equal(listed.status, 200);
		assert.deepEqual(todosIn(listed.json), [], "a refused request must not write");

		// The authenticated path works, and replies carry no sniffable content type.
		const health = await callApi(service, "GET", "/health");
		assert.equal(health.status, 200);
		assert.equal(health.headers.get("x-content-type-options"), "nosniff");
		assert.equal(health.headers.get("cache-control"), "no-store");
		assert.equal(health.json?.status, "ready");

		// Nothing in a reply may disclose the secret or a filesystem path.
		for (const response of [wrong, crossOrigin, health]) {
			assert.ok(!response.text.includes(service.token), "a reply must never echo the token");
			assert.ok(!response.text.includes("assistant.sqlite"), "a reply must never disclose the database path");
			assert.ok(!response.text.includes("\\"), "a reply must never contain a Windows path");
		}

		// The listener is bound to loopback only: a request to this machine's LAN address
		// must not reach it. The check is filtered so a machine with no such interface, or
		// a firewall that drops the packet, still passes.
		let reached: string | undefined;
		for (const address of lanAddresses()) {
			const response = await fetch(`http://${address}:${service.server.port}/health`, {
				headers: { authorization: `Bearer ${service.token}` },
				signal: AbortSignal.timeout(3000),
			}).catch(() => undefined);
			if (response?.status === 200) reached = address;
		}
		assert.equal(reached, undefined, `the service must not be reachable on ${reached}`);

		// An unexpected internal failure is reported generically: closing the store out
		// from under the listener must produce a 500 that leaks nothing. The detail is not
		// swallowed either — it lands in the service's own log.
		await service.store.close();
		const broken = await callApi(service, "GET", "/v1/todos");
		assert.equal(broken.status, 500);
		assert.equal(errorCodeOf(broken), "internal_error");
		assert.equal((broken.json?.error as Record<string, unknown> | undefined)?.message, "internal error");
		assert.ok(!broken.text.includes("assistant.sqlite") && !broken.text.includes(" at "), "a 500 must not leak a path or a stack frame");
		assert.ok(
			service.logs().some((line) => line.includes("SqliteStorage is closed")),
			`the cause must be kept server-side, saw: ${JSON.stringify(service.logs())}`,
		);
	});
});

const lanAddresses = (): string[] => {
	const addresses: string[] = [];
	for (const infos of Object.values(networkInterfaces())) {
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal) addresses.push(info.address);
		}
	}
	return addresses;
};

// --- V11: input boundaries ----------------------------------------------------

test("V11 malformed input is rejected with the documented status and writes nothing", async () => {
	await withService("phase2-v11", async (service) => {
		const reject = async (
			label: string,
			expectedStatus: number,
			expectedCode: string,
			options: Parameters<typeof callApi>[3],
		): Promise<void> => {
			const response = await callApi(service, "POST", "/v1/todos", options);
			assert.equal(response.status, expectedStatus, `${label}: expected ${expectedStatus}, got ${response.status} (${response.text})`);
			assert.equal(errorCodeOf(response), expectedCode, `${label}: wrong error code`);
		};

		// Body parsing.
		await reject("invalid JSON", 400, "invalid_request", { raw: "{not json" });
		await reject("JSON array", 400, "invalid_request", { raw: "[]" });
		await reject("JSON string", 400, "invalid_request", { raw: "\"hi\"" });
		await reject("non-JSON content type", 415, "unsupported_media_type", {
			raw: "title=x",
			contentType: "application/x-www-form-urlencoded",
		});
		await reject("missing content type", 415, "unsupported_media_type", { raw: "{}", contentType: null });
		await reject("body over 16 KiB", 413, "payload_too_large", {
			raw: JSON.stringify({ operationId: "v11-big", title: "x".repeat(20_000) }),
		});

		// operationId.
		await reject("missing operationId", 400, "invalid_request", { body: { title: "no operation id" } });
		await reject("empty operationId", 400, "invalid_request", { body: { operationId: "", title: "empty id" } });
		await reject("non-string operationId", 400, "invalid_request", { body: { operationId: 7, title: "numeric id" } });
		await reject("operationId with a space", 400, "invalid_request", { body: { operationId: "has space", title: "bad charset" } });
		await reject("operationId with a slash", 400, "invalid_request", { body: { operationId: "a/b", title: "bad charset" } });
		await reject("operationId over 128 chars", 400, "invalid_request", {
			body: { operationId: "o".repeat(ASSISTANT_LIMITS.operationIdMaxChars + 1), title: "too long" },
		});

		// title.
		await reject("missing title", 400, "invalid_request", { body: { operationId: "v11-no-title" } });
		await reject("non-string title", 400, "invalid_request", { body: { operationId: "v11-num-title", title: 5 } });
		await reject("blank title", 400, "invalid_request", { body: { operationId: "v11-blank", title: "   " } });
		await reject("title over 500 chars", 400, "invalid_request", {
			body: { operationId: "v11-long", title: "t".repeat(ASSISTANT_LIMITS.titleMaxChars + 1) },
		});

		// Routing and methods.
		for (const [method, path, status, code] of [
			["PATCH", "/v1/todos", 405, "method_not_allowed"],
			["DELETE", "/v1/todos", 405, "method_not_allowed"],
			["POST", "/v1/todos/abc", 405, "method_not_allowed"],
			["GET", "/v1/nope", 404, "not_found"],
			["GET", "/v2/todos", 404, "not_found"],
			["GET", "/", 404, "not_found"],
		] as const) {
			const response = await callApi(service, method, path);
			assert.equal(response.status, status, `${method} ${path}`);
			assert.equal(errorCodeOf(response), code, `${method} ${path}`);
		}

		// Listing parameters, on the GET surface.
		for (const [path, code] of [
			["/v1/todos?status=finished", "invalid_request"],
			["/v1/todos?limit=0", "invalid_request"],
			["/v1/todos?limit=101", "invalid_request"],
			["/v1/todos?limit=abc", "invalid_request"],
			["/v1/todos?limit=-1", "invalid_request"],
			["/v1/todos?cursor=not-a-cursor", "invalid_cursor"],
			["/v1/todos?cursor=e30", "invalid_cursor"],
		] as const) {
			const response = await callApi(service, "GET", path);
			assert.equal(response.status, 400, path);
			assert.equal(errorCodeOf(response), code, path);
		}

		// Unknown top-level fields are ignored, not rejected: the bridge may add context
		// to a call without the service having to be redeployed. Only the documented
		// fields are read, and a stray field must not change the outcome.
		const withExtra = await callApi(service, "POST", "/v1/todos", {
			body: { operationId: "v11-extra-field", title: "keeps working", note: "ignored", nested: { deep: [1, 2] } },
		});
		assert.equal(withExtra.status, 200, withExtra.text);
		assert.equal(todoIn(withExtra.json).title, "keeps working");

		// Everything that was refused must have left the store untouched.
		const listed = await callApi(service, "GET", "/v1/todos?status=all&limit=100");
		assert.equal(todosIn(listed.json).length, 1, "only the one accepted request may exist");

		// The id in the path is validated like any other input.
		for (const [path, status, code] of [
			["/v1/todos/not-a-uuid", 400, "invalid_request"],
			["/v1/todos/3f1c8a9e-2b4d-4f6a-9c1e-5d7b0a2e4f68", 404, "not_found"],
		] as const) {
			const response = await callApi(service, "GET", path);
			assert.equal(response.status, status, path);
			assert.equal(errorCodeOf(response), code, path);
		}
	});
});

// --- V12: pagination ----------------------------------------------------------

test("V12 a 45-item store pages without loss or duplication, filters correctly and bounds the page size", async () => {
	await withService("phase2-v12", async (service) => {
		const total = 45;
		const created: Array<Record<string, unknown>> = [];
		for (let index = 0; index < total; index += 1) {
			const response = await callApi(service, "POST", "/v1/todos", {
				body: { operationId: `v12-create-${index}`, title: `task ${String(index).padStart(2, "0")}` },
			});
			assert.equal(response.status, 200, response.text);
			created.push(todoIn(response.json));
		}
		const expectedIds = new Set(created.map((todo) => todo.id as string));

		// Unfiltered: every record matches, so the pages are exactly `limit` wide.
		const pages: Array<Array<Record<string, unknown>>> = [];
		let cursor: string | null = null;
		do {
			const path = `/v1/todos?status=all&limit=20${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
			const response = await callApi(service, "GET", path);
			assert.equal(response.status, 200, response.text);
			pages.push(todosIn(response.json));
			const next = response.json?.nextCursor;
			assert.ok(next === null || typeof next === "string", "nextCursor must be a string or null");
			cursor = next as string | null;
			assert.ok(pages.length <= 5, "pagination did not terminate");
		} while (cursor !== null);

		assert.deepEqual(pages.map((page) => page.length), [20, 20, 5], "an unfiltered scan must fill every page");
		const seen = pages.flat().map((todo) => todo.id as string);
		assert.equal(seen.length, total);
		assert.equal(new Set(seen).size, total, "no record may appear on two pages");
		assert.deepEqual(new Set(seen), expectedIds, "no record may be skipped");

		// Ordering is stable creation order, so a second pass must agree with the first.
		const again = await callApi(service, "GET", "/v1/todos?status=all&limit=100");
		assert.deepEqual(
			todosIn(again.json).map((todo) => todo.id),
			seen,
			"listing must be deterministic",
		);

		// A filter that matches a minority of records exercises the page-boundary rescan:
		// records 10..34 become done, so neither the first nor the last scan page fits.
		for (let index = 10; index <= 34; index += 1) {
			const response = await callApi(service, "POST", `/v1/todos/${created[index].id as string}/complete`, {
				body: { operationId: `v12-complete-${index}` },
			});
			assert.equal(response.status, 200, response.text);
		}
		const expectedDone = new Set(created.slice(10, 35).map((todo) => todo.id as string));

		const filteredIds: string[] = [];
		let filteredCursor: string | null = null;
		do {
			const path = `/v1/todos?status=done&limit=20${filteredCursor === null ? "" : `&cursor=${encodeURIComponent(filteredCursor)}`}`;
			const response = await callApi(service, "GET", path);
			assert.equal(response.status, 200, response.text);
			const page = todosIn(response.json);
			assert.ok(page.length <= 20, "a page must never exceed the requested limit");
			for (const todo of page) assert.equal(todo.status, "done", "the status filter must be exact");
			filteredIds.push(...page.map((todo) => todo.id as string));
			const next = response.json?.nextCursor;
			filteredCursor = (next ?? null) as string | null;
			assert.ok(filteredIds.length <= total + 20, "filtered pagination did not terminate");
		} while (filteredCursor !== null);

		assert.equal(filteredIds.length, 25, "the filtered scan must return every match exactly once");
		assert.equal(new Set(filteredIds).size, 25, "the filtered scan must not repeat a record");
		assert.deepEqual(new Set(filteredIds), expectedDone);

		// The other two filters agree with the same data.
		const open = await callApi(service, "GET", "/v1/todos?status=open&limit=100");
		assert.equal(todosIn(open.json).length, 20);
		const all = await callApi(service, "GET", "/v1/todos?status=all&limit=100");
		assert.equal(todosIn(all.json).length, 45);
		// The default filter is `open`.
		const defaulted = await callApi(service, "GET", "/v1/todos");
		assert.equal(todosIn(defaulted.json).length, 20);

		// The page-size bounds.
		const max = await callApi(service, "GET", `/v1/todos?status=all&limit=${ASSISTANT_LIMITS.maxPageSize}`);
		assert.equal(max.status, 200);
		assert.equal(todosIn(max.json).length, 45);

		// A cursor is only valid for the query that issued it: replaying one under a
		// different filter must be refused rather than silently mis-paged.
		const firstPage = await callApi(service, "GET", "/v1/todos?status=all&limit=20");
		const issuedCursor = firstPage.json?.nextCursor;
		assert.equal(typeof issuedCursor, "string");
		const reused = await callApi(service, "GET", `/v1/todos?status=done&limit=20&cursor=${encodeURIComponent(issuedCursor as string)}`);
		assert.equal(reused.status, 400);
		assert.equal(errorCodeOf(reused), "invalid_cursor");
		const reusedLimit = await callApi(service, "GET", `/v1/todos?status=all&limit=10&cursor=${encodeURIComponent(issuedCursor as string)}`);
		assert.equal(reusedLimit.status, 400);
		assert.equal(errorCodeOf(reusedLimit), "invalid_cursor");
	});
});
