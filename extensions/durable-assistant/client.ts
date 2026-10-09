// -----------------------------------------------------------------------------
// HTTP client for the local assistant service.
//
// Deliberately imports nothing but `node:` builtins and global `fetch`: the extension
// package must not drag the playground's runtime dependencies into the pi host
// process. `index.ts` holds only the pi adapter, so everything that can be wrong about
// talking to the service lives here, where it is typechecked by the project tsconfig
// and exercised against a real service in tests/assistant/phase3-bridge.test.ts.
//
// Error semantics are the whole point of this file. A caller must never be able to
// tell a model "the write failed" when the truth is "we do not know". Every failure is
// therefore classified into exactly one of:
//
//   * `definitelyNotApplied` — we can prove the service never processed the request
//     (connection refused, or the service answered with an error status).
//   * unknown — the request may have been committed. The only safe advice is to retry
//     with the *same* operationId, which the service resolves idempotently.
// -----------------------------------------------------------------------------

/** Mirror of the service's `AssistantErrorCode`; a test parses the union out of
 * `src/assistant/store.ts` and fails if the two drift apart. */
export type AssistantClientCode =
	| "service_unreachable"
	| "outcome_unknown"
	| "malformed_response"
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
 * The codes the *service* can return, in the same order as its `AssistantErrorCode`
 * union so the two can be diffed by eye. Everything else in `AssistantClientCode` is
 * ours: `service_unreachable`, `outcome_unknown` and `malformed_response` describe
 * relationships with the service, not answers from it.
 */
export const ASSISTANT_SERVICE_ERROR_CODES = [
	"invalid_request",
	"not_found",
	"method_not_allowed",
	"operation_conflict",
	"invalid_cursor",
	"unauthorized",
	"cross_origin_forbidden",
	"payload_too_large",
	"unsupported_media_type",
	"service_unavailable",
	"internal_error",
] as const satisfies readonly AssistantClientCode[];

export type AssistantTodoStatus = "open" | "done";
export type AssistantTodoFilter = AssistantTodoStatus | "all";

/** The public todo shape, as served by `GET /v1/todos*`. */
export type AssistantTodo = {
	readonly id: string;
	readonly title: string;
	readonly status: AssistantTodoStatus;
	readonly createdAt: string;
	readonly completedAt: string | null;
};

export type AssistantTodoPage = {
	readonly items: readonly AssistantTodo[];
	readonly nextCursor: string | null;
};

export type AssistantClientErrorInit = {
	readonly code: AssistantClientCode;
	/**
	 * `true` only when we can prove the service never processed the request, so the
	 * caller may safely say "nothing was written". Anything else — a timeout, a
	 * cancellation, a dropped socket, an accepted-but-unreadable response — leaves the
	 * outcome unknown and must be reported as such.
	 */
	readonly definitelyNotApplied: boolean;
	readonly operationId?: string | undefined;
	readonly httpStatus?: number | undefined;
	readonly cause?: unknown;
};

export class AssistantClientError extends Error {
	readonly code: AssistantClientCode;
	readonly definitelyNotApplied: boolean;
	/** Present when the failed call was a mutation, so a retry can reuse the id. */
	readonly operationId: string | undefined;
	readonly httpStatus: number | undefined;

	constructor(message: string, init: AssistantClientErrorInit) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = "AssistantClientError";
		this.code = init.code;
		this.definitelyNotApplied = init.definitelyNotApplied;
		this.operationId = init.operationId;
		this.httpStatus = init.httpStatus;
	}
}

export type CreateTodoInput = {
	readonly title: string;
	readonly operationId: string;
};

export type CompleteTodoInput = {
	readonly id: string;
	readonly operationId: string;
};

export type ListTodosInput = {
	readonly status?: AssistantTodoFilter | undefined;
	readonly limit?: number | undefined;
	readonly cursor?: string | undefined;
};

/** Per-call options. `signal` is pi's cancellation signal for the turn. */
export type AssistantCallOptions = {
	readonly signal?: AbortSignal | undefined;
};

export type AssistantClient = {
	readonly baseUrl: string;
	createTodo(input: CreateTodoInput, options?: AssistantCallOptions): Promise<AssistantTodo>;
	listTodos(input?: ListTodosInput, options?: AssistantCallOptions): Promise<AssistantTodoPage>;
	getTodo(id: string, options?: AssistantCallOptions): Promise<AssistantTodo>;
	completeTodo(input: CompleteTodoInput, options?: AssistantCallOptions): Promise<AssistantTodo>;
};

export type AssistantClientOptions = {
	/** Loopback origin, e.g. `http://127.0.0.1:4318`. A trailing slash is tolerated. */
	readonly baseUrl: string;
	readonly token: string;
	/**
	 * Defaults to {@link ASSISTANT_CLIENT_DEFAULT_TIMEOUT_MS}. Kept below the WeChat
	 * gateway's per-tool budget on purpose: the tool has to survive long enough to tell
	 * the model that the outcome is unknown. Being killed by the host instead would
	 * leave the model with no explanation at all.
	 */
	readonly timeoutMs?: number | undefined;
	/** Test seam. Defaults to the global `fetch`. */
	readonly fetch?: typeof globalThis.fetch | undefined;
};

/**
 * The plan suggested 10s; we use 8s so a timeout is reported *to the model* rather
 * than swallowing the turn when the host cancels the tool call at its own 10s limit.
 */
export const ASSISTANT_CLIENT_DEFAULT_TIMEOUT_MS = 8_000;

/** Matches the service's `maxPageSize`, so the bridge can never ask for more than it serves. */
export const ASSISTANT_CLIENT_MAX_LIMIT = 100;

/** The service's own default; repeated so the tool's text and the request agree. */
export const ASSISTANT_CLIENT_DEFAULT_LIMIT = 20;

/**
 * Connection-level failures that prove the request never reached the service. Node
 * surfaces them on `error.cause` (a bare `Error` or an `AggregateError` from undici).
 */
const NEVER_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_INVALID_URL"]);

const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
};

/** Walk `cause`/`errors` looking for a socket-level code. */
const findConnectionCode = (error: unknown, depth = 0): string | undefined => {
	if (depth > 4 || typeof error !== "object" || error === null) return undefined;
	const direct = errorCode(error);
	if (direct !== undefined && NEVER_CONNECTED_CODES.has(direct)) return direct;
	const errors = (error as { errors?: unknown }).errors;
	if (Array.isArray(errors)) {
		for (const nested of errors) {
			const found = findConnectionCode(nested, depth + 1);
			if (found !== undefined) return found;
		}
	}
	return findConnectionCode((error as { cause?: unknown }).cause, depth + 1);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTodoStatus = (value: unknown): value is AssistantTodoStatus => value === "open" || value === "done";

/** Reject a body that does not match the service contract instead of half-trusting it. */
const parseTodo = (value: unknown): AssistantTodo => {
	const malformed = (detail: string): AssistantClientError =>
		new AssistantClientError(`the service returned a todo this bridge cannot read (${detail})`, {
			code: "malformed_response",
			definitelyNotApplied: false,
		});
	if (!isPlainObject(value)) throw malformed("not an object");
	const { id, title, status, createdAt, completedAt } = value;
	if (typeof id !== "string" || typeof title !== "string" || typeof createdAt !== "string") throw malformed("missing fields");
	if (!isTodoStatus(status)) throw malformed("unknown status");
	if (typeof completedAt !== "string" && completedAt !== null) throw malformed("completedAt is neither a string nor null");
	return { id, title, status, createdAt, completedAt };
};

const parsePage = (value: unknown): AssistantTodoPage => {
	const malformed = (detail: string): AssistantClientError =>
		new AssistantClientError(`the service returned a list this bridge cannot read (${detail})`, {
			code: "malformed_response",
			definitelyNotApplied: false,
		});
	if (!isPlainObject(value)) throw malformed("not an object");
	const items = value.items;
	if (!Array.isArray(items)) throw malformed("items is not an array");
	const nextCursor = value.nextCursor;
	if (nextCursor !== null && typeof nextCursor !== "string") throw malformed("nextCursor is neither a string nor null");
	return { items: items.map(parseTodo), nextCursor };
};

/** Read `{ error: { code, message } }` from a failed response, if it is shaped that way. */
const parseServiceError = (payload: unknown): { readonly code: string; readonly message: string } | undefined => {
	if (!isPlainObject(payload)) return undefined;
	const error = payload.error;
	if (!isPlainObject(error)) return undefined;
	const { code, message } = error;
	if (typeof code !== "string" || typeof message !== "string") return undefined;
	return { code, message };
};

const isServiceCode = (code: string): code is AssistantClientCode =>
	(ASSISTANT_SERVICE_ERROR_CODES as readonly string[]).includes(code);

const clampLimit = (raw: number | undefined): number => {
	if (raw === undefined || !Number.isFinite(raw)) return ASSISTANT_CLIENT_DEFAULT_LIMIT;
	const integer = Math.trunc(raw);
	if (integer < 1) return 1;
	return Math.min(integer, ASSISTANT_CLIENT_MAX_LIMIT);
};

export const createAssistantClient = (options: AssistantClientOptions): AssistantClient => {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? ASSISTANT_CLIENT_DEFAULT_TIMEOUT_MS;
	const doFetch = options.fetch ?? globalThis.fetch;

	const request = async (spec: {
		readonly method: "GET" | "POST";
		readonly path: string;
		readonly body?: unknown;
		readonly operationId?: string | undefined;
		/** Merged with the timeout; pi passes the turn's signal so a cancel stops the call. */
		readonly signal?: AbortSignal | undefined;
	}): Promise<unknown> => {
		const timeoutController = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			timeoutController.abort(new Error("assistant request timed out"));
		}, timeoutMs);
		const composite =
			spec.signal === undefined ? timeoutController.signal : AbortSignal.any([spec.signal, timeoutController.signal]);

		const failed = (message: string, init: AssistantClientErrorInit): AssistantClientError =>
			new AssistantClientError(message, { operationId: spec.operationId, ...init });

		let response: Response;
		let text: string;
		try {
			response = await doFetch(`${baseUrl}${spec.path}`, {
				method: spec.method,
				headers: {
					authorization: `Bearer ${options.token}`,
					accept: "application/json",
					...(spec.body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
				redirect: "error",
				signal: composite,
			});
			text = await response.text();
		} catch (error) {
			// Order matters: a refused connection is proof, a timeout or a cancel is not.
			// `timedOut` is checked after the connection codes because an aborted request
			// can still surface a socket-level cause.
			const connectionCode = findConnectionCode(error);
			if (connectionCode !== undefined && !timedOut) {
				throw failed(
					`the assistant service is not reachable at ${baseUrl} (${connectionCode}). It is probably not running.`,
					{ code: "service_unreachable", definitelyNotApplied: true, cause: error },
				);
			}
			if (timedOut) {
				throw failed(
					`the assistant service at ${baseUrl} did not answer within ${timeoutMs}ms, so the request may still be running.`,
					{ code: "outcome_unknown", definitelyNotApplied: false, cause: error },
				);
			}
			if (spec.signal?.aborted === true) {
				throw failed(
					`the call to the assistant service at ${baseUrl} was cancelled, so the request may still be running.`,
					{ code: "outcome_unknown", definitelyNotApplied: false, cause: error },
				);
			}
			// A dropped socket, a TLS failure, a redirect refusal: assume the worst.
			throw failed(
				`the call to the assistant service at ${baseUrl} failed before an answer arrived, so the outcome is unknown.`,
				{ code: "outcome_unknown", definitelyNotApplied: false, cause: error },
			);
		} finally {
			clearTimeout(timer);
		}

		let payload: unknown;
		try {
			payload = text === "" ? undefined : JSON.parse(text);
		} catch {
			payload = undefined;
		}

		if (!response.ok) {
			const serviceError = parseServiceError(payload);
			if (serviceError === undefined) {
				// An error status whose body we cannot read. A 4xx is a decision made before any
				// write — auth, validation, routing — so nothing was applied. A 5xx is genuinely
				// ambiguous: the service may have committed the todo and then died while writing
				// the response. Saying "it failed" there would invite a duplicate, so it stays
				// an unknown outcome instead.
				throw failed(
					`the assistant service answered ${response.status} with a body this bridge cannot read.`,
					{ code: "malformed_response", definitelyNotApplied: response.status < 500, httpStatus: response.status },
				);
			}
			const code = isServiceCode(serviceError.code) ? serviceError.code : "internal_error";
			throw failed(serviceError.message, {
				code,
				// Every mutation the service performs is transactional, so an error status
				// means nothing was committed. A 5xx is included: the store either rolled
				// back or never opened the transaction.
				definitelyNotApplied: true,
				httpStatus: response.status,
			});
		}

		if (payload === undefined) {
			throw failed(`the assistant service answered ${response.status} with an empty body.`, {
				code: "malformed_response",
				// A 2xx means the service accepted the request and probably committed it.
				definitelyNotApplied: false,
				httpStatus: response.status,
			});
		}
		return payload;
	};

	return {
		baseUrl,
		async createTodo(input, callOptions) {
			const payload = await request({
				method: "POST",
				path: "/v1/todos",
				body: { operationId: input.operationId, title: input.title },
				operationId: input.operationId,
				signal: callOptions?.signal,
			});
			if (!isPlainObject(payload)) {
				throw new AssistantClientError("the service returned a create result this bridge cannot read", {
					code: "malformed_response",
					definitelyNotApplied: false,
					operationId: input.operationId,
				});
			}
			return parseTodo(payload.todo);
		},
		async listTodos(input = {}, callOptions) {
			const params = new URLSearchParams();
			params.set("status", input.status ?? "open");
			params.set("limit", String(clampLimit(input.limit)));
			if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
			const payload = await request({ method: "GET", path: `/v1/todos?${params.toString()}`, signal: callOptions?.signal });
			if (!isPlainObject(payload)) {
				throw new AssistantClientError("the service returned a list result this bridge cannot read", {
					code: "malformed_response",
					definitelyNotApplied: false,
				});
			}
			return parsePage(payload);
		},
		async getTodo(id, callOptions) {
			const payload = await request({
				method: "GET",
				path: `/v1/todos/${encodeURIComponent(id)}`,
				signal: callOptions?.signal,
			});
			if (!isPlainObject(payload)) {
				throw new AssistantClientError("the service returned a todo result this bridge cannot read", {
					code: "malformed_response",
					definitelyNotApplied: false,
				});
			}
			return parseTodo(payload.todo);
		},
		async completeTodo(input, callOptions) {
			const payload = await request({
				method: "POST",
				path: `/v1/todos/${encodeURIComponent(input.id)}/complete`,
				body: { operationId: input.operationId },
				operationId: input.operationId,
				signal: callOptions?.signal,
			});
			if (!isPlainObject(payload)) {
				throw new AssistantClientError("the service returned a complete result this bridge cannot read", {
					code: "malformed_response",
					definitelyNotApplied: false,
					operationId: input.operationId,
				});
			}
			return parseTodo(payload.todo);
		},
	};
};
