// -----------------------------------------------------------------------------
// Assistant HTTP service: loopback-only, bearer-authenticated, no CORS.
//
// The listener is deliberately thin. It validates transport concerns (auth, method,
// content type, body size, origin), delegates to the todo service, and maps errors to
// `{error:{code,message}}`. It never returns a path, a token or a stack trace.
// -----------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AssistantError, createTodoService, type TodoServiceOptions } from "./store.ts";
import type { AssistantStore } from "./storage.ts";

/** Request bodies above this are rejected with 413 before being buffered. */
export const ASSISTANT_MAX_BODY_BYTES = 16 * 1024;

/** Hard cap on graceful shutdown before the remaining sockets are dropped. */
const SHUTDOWN_GRACE_MS = 5_000;

export type AssistantServerState = "ready" | "closing";

export type AssistantServerOptions = {
	/** The exclusive store handle. The server owns closing it. */
	readonly store: AssistantStore;
	readonly token: string;
	/** `0` asks the OS for a free port. */
	readonly port: number;
	readonly host?: string;
	readonly version?: string;
	/** Injected into the todo service; used by tests for deterministic ids and clocks. */
	readonly service?: TodoServiceOptions;
	/**
	 * Where an unexpected internal failure is described. The client only ever sees
	 * `internal_error`, so this is the only place the detail survives; the default writes
	 * it to our own stderr. The token is never passed here.
	 */
	readonly log?: (message: string, detail?: unknown) => void;
};

export type AssistantServer = {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	readonly state: () => AssistantServerState;
	/** Requests currently being handled. Drains to 0 during close. */
	readonly inFlight: () => number;
	/** Stop accepting, drain, then close the store. Idempotent. */
	readonly close: () => Promise<void>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Constant-time comparison; a length mismatch is the only fast path. */
const secretMatches = (candidate: string, expected: string): boolean => {
	const left = Buffer.from(candidate, "utf8");
	const right = Buffer.from(expected, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
};

const bearerToken = (header: string | undefined): string | undefined => {
	if (header === undefined) return undefined;
	const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
	return match?.[1];
};

/** Read a bounded body. Drains the remainder so the client still gets a response. */
const readBody = (request: IncomingMessage, maxBytes: number): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		request.on("data", (chunk: Buffer) => {
			if (settled) return;
			total += chunk.length;
			if (total > maxBytes) {
				settled = true;
				reject(new AssistantError("payload_too_large", 413, `request body must be at most ${maxBytes} bytes`));
				request.resume();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks));
		});
		request.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});

export const startAssistantServer = async (options: AssistantServerOptions): Promise<AssistantServer> => {
	const host = options.host ?? "127.0.0.1";
	const version = options.version ?? "0.1.0";
	const service = createTodoService(options.store, options.service);
	const log = options.log ?? ((message: string, detail?: unknown): void => console.error(message, detail));

	let state: AssistantServerState = "ready";
	let inFlight = 0;

	const sendJson = (
		response: ServerResponse,
		status: number,
		payload: unknown,
		headers: Readonly<Record<string, string>> = {},
	): void => {
		const body = JSON.stringify(payload);
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(body),
			"cache-control": "no-store",
			connection: "close",
			"x-content-type-options": "nosniff",
			...headers,
		});
		response.end(body);
	};

	const sendError = (response: ServerResponse, error: AssistantError): void => {
		const headers: Record<string, string> = error.code === "unauthorized" ? { "www-authenticate": "Bearer" } : {};
		sendJson(response, error.httpStatus, { error: { code: error.code, message: error.message } }, headers);
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		try {
			if (state === "closing") {
				throw new AssistantError("service_unavailable", 503, "the assistant service is shutting down");
			}

			// A browser always sends Origin on a cross-origin request. We serve no HTML and
			// need no CORS, so any Origin means the caller is not the pi bridge.
			if (request.headers.origin !== undefined) {
				throw new AssistantError("cross_origin_forbidden", 403, "cross-origin requests are not allowed");
			}

			const presented = bearerToken(request.headers.authorization);
			if (presented === undefined || !secretMatches(presented, options.token)) {
				throw new AssistantError("unauthorized", 401, "a valid bearer token is required");
			}

			const url = new URL(request.url ?? "/", `http://${host}`);
			const segments = url.pathname.split("/").filter((part) => part.length > 0);
			const method = request.method ?? "GET";

			if (segments.length === 1 && segments[0] === "health") {
				if (method !== "GET") throw new AssistantError("method_not_allowed", 405, `${method} is not allowed here`);
				sendJson(response, 200, { status: "ready", version });
				return;
			}

			if (segments.length === 2 && segments[0] === "v1" && segments[1] === "todos") {
				if (method === "POST") {
					const body = await readJsonObject(request);
					const todo = await service.createTodo({ operationId: body.operationId, title: body.title });
					sendJson(response, 200, { todo });
					return;
				}
				if (method === "GET") {
					const result = await service.listTodos({
						status: url.searchParams.get("status") ?? undefined,
						limit: url.searchParams.get("limit") ?? undefined,
						cursor: url.searchParams.get("cursor") ?? undefined,
					});
					sendJson(response, 200, { items: result.items, nextCursor: result.nextCursor });
					return;
				}
				throw new AssistantError("method_not_allowed", 405, `${method} is not allowed here`);
			}

			if (segments.length === 3 && segments[0] === "v1" && segments[1] === "todos") {
				if (method !== "GET") throw new AssistantError("method_not_allowed", 405, `${method} is not allowed here`);
				sendJson(response, 200, { todo: await service.getTodo(segments[2]) });
				return;
			}

			if (segments.length === 4 && segments[0] === "v1" && segments[1] === "todos" && segments[3] === "complete") {
				if (method !== "POST") throw new AssistantError("method_not_allowed", 405, `${method} is not allowed here`);
				const body = await readJsonObject(request);
				const todo = await service.completeTodo({ id: segments[2], operationId: body.operationId });
				sendJson(response, 200, { todo });
				return;
			}

			throw AssistantError.notFound("no such route");
		} catch (error) {
			if (error instanceof AssistantError) {
				sendError(response, error);
				return;
			}
			// Never leak internals to the client; keep the detail on our own stderr.
			log("[assistant] unhandled request error:", error);
			sendError(response, new AssistantError("internal_error", 500, "internal error"));
		}
	};

	const readJsonObject = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
		const contentType = request.headers["content-type"];
		if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
			throw new AssistantError("unsupported_media_type", 415, "content-type must be application/json");
		}
		const raw = await readBody(request, ASSISTANT_MAX_BODY_BYTES);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			throw AssistantError.invalid("request body must be valid JSON");
		}
		if (!isPlainObject(parsed)) throw AssistantError.invalid("request body must be a JSON object");
		return parsed;
	};

	const server: Server = createServer((request, response) => {
		inFlight += 1;
		void handle(request, response).finally(() => {
			inFlight -= 1;
		});
	});
	server.on("clientError", (_error, socket) => {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("assistant server did not bind to a TCP port");
	}
	const port = address.port;

	let closePromise: Promise<void> | undefined;
	const close = async (): Promise<void> => {
		if (closePromise !== undefined) return await closePromise;
		closePromise = (async () => {
			state = "closing";
			const drained = new Promise<void>((resolve) => server.close(() => resolve()));
			// Close keep-alive sockets that are between requests, so the drain cannot hang
			// on a browser or a fetch pool holding an idle connection.
			server.closeIdleConnections();
			const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
			grace.unref?.();
			try {
				await drained;
				// Belt and braces: handlers settle before their socket closes, but never assume it.
				while (inFlight > 0) await new Promise((resolve) => setImmediate(resolve));
			} finally {
				clearTimeout(grace);
			}
			await options.store.close();
		})();
		return await closePromise;
	};

	return {
		host,
		port,
		url: `http://${host}:${port}`,
		state: () => state,
		inFlight: () => inFlight,
		close,
	};
};
