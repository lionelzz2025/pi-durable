// -----------------------------------------------------------------------------
// pi bridge extension: four tools that delegate todo work to the local assistant
// service over HTTP.
//
// Scope discipline (task_plan.md §"pi 桥接工具"):
//   * The factory only *registers* tools. No socket, no timer, no probe at load time.
//   * The bridge never touches SQLite, WeChat login, or the WeChat connection.
//   * No automatic retry of mutations: a retry made silently behind the model's back
//     would make "did it work?" unanswerable. Unknown outcomes are *reported* instead.
//
// `client.ts` holds everything about talking to the service. This file holds only the
// pi-facing surface: schemas, input validation, and how a failure is phrased.
// -----------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolResult } from "@earendil-works/pi-coding-agent";

import {
	ASSISTANT_CLIENT_DEFAULT_LIMIT,
	ASSISTANT_CLIENT_MAX_LIMIT,
	AssistantClientError,
	createAssistantClient,
	type AssistantClient,
	type AssistantTodo,
	type AssistantTodoFilter,
} from "./client.ts";

// --- contract constants -------------------------------------------------------
//
// Duplicated from src/assistant/{store,config}.ts on purpose: this package must not
// import the service, because that would pull the playground's runtime dependencies
// into the pi host process. A test asserts these stay equal to the service's values.

/** The service's default port (`ASSISTANT_PORT`). */
export const ASSISTANT_BRIDGE_DEFAULT_PORT = 4318;
/** The service's `ASSISTANT_LIMITS.titleMaxChars`. */
export const ASSISTANT_BRIDGE_TITLE_MAX_CHARS = 500;
/** The service's `ASSISTANT_LIMITS.operationIdMaxChars`. */
export const ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS = 128;
/** The service's `ASSISTANT_LIMITS.maxPageSize`. */
export const ASSISTANT_BRIDGE_MAX_PAGE_SIZE = ASSISTANT_CLIENT_MAX_LIMIT;
/** The accepted operationId alphabet (the service's `OPERATION_ID_PATTERN`). */
export const ASSISTANT_BRIDGE_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const TODO_FILTERS: readonly AssistantTodoFilter[] = ["open", "done", "all"];

type BridgeEnv = Readonly<Record<string, string | undefined>>;

// --- input validation ---------------------------------------------------------
//
// Every helper takes `unknown`. The tool schema covers the happy path, but the model can
// still send a wrong type, and `params` comes from the host, not from us.

class BridgeInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BridgeInputError";
	}
}

const normalizeTitle = (raw: unknown): string => {
	if (typeof raw !== "string") throw new BridgeInputError("`title` is required and must be a string");
	const title = raw.trim();
	if (title.length === 0) throw new BridgeInputError("`title` must not be empty");
	if (title.length > ASSISTANT_BRIDGE_TITLE_MAX_CHARS) {
		throw new BridgeInputError(`\`title\` must be at most ${ASSISTANT_BRIDGE_TITLE_MAX_CHARS} characters`);
	}
	return title;
};

/**
 * Resolve a caller-supplied operationId, or `undefined` when the caller did not name one.
 * An explicit value is the *only* way a model can deliberately retry a write.
 */
const normalizeOperationId = (raw: unknown): string | undefined => {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new BridgeInputError("`operationId` must be a string");
	if (raw.length > ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS) {
		throw new BridgeInputError(`\`operationId\` must be at most ${ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS} characters`);
	}
	if (!ASSISTANT_BRIDGE_OPERATION_ID_PATTERN.test(raw)) {
		throw new BridgeInputError("`operationId` may only contain A-Z a-z 0-9 . _ : -");
	}
	return raw;
};

/**
 * Fall back to pi's `toolCallId`, which is the identity of "this invocation". Re-executing
 * the same tool call therefore reuses the same operationId and cannot duplicate the write.
 *
 * Deliberately *not* truncated: provider call ids carry their entropy in the suffix, so
 * cutting one down to length would let two different calls collapse onto a single id —
 * which would silently return the wrong todo. An over-long id falls back to a fresh UUID.
 */
export const deriveOperationId = (toolCallId: string): string => {
	const sanitized = toolCallId.replace(/[^A-Za-z0-9._:-]/g, "-");
	if (sanitized.length > 0 && sanitized.length <= ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS) return sanitized;
	return randomUUID();
};

const normalizeStatus = (raw: unknown): AssistantTodoFilter => {
	if (raw === undefined || raw === null || raw === "") return "open";
	if (typeof raw === "string" && (TODO_FILTERS as readonly string[]).includes(raw)) return raw as AssistantTodoFilter;
	throw new BridgeInputError(`\`status\` must be one of ${TODO_FILTERS.join(", ")}`);
};

const normalizeLimit = (raw: unknown): number => {
	if (raw === undefined || raw === null || raw === "") return ASSISTANT_CLIENT_DEFAULT_LIMIT;
	const text = typeof raw === "number" ? String(raw) : raw;
	if (typeof text !== "string" || !/^[0-9]{1,3}$/.test(text.trim())) {
		throw new BridgeInputError(`\`limit\` must be an integer between 1 and ${ASSISTANT_BRIDGE_MAX_PAGE_SIZE}`);
	}
	const limit = Number(text.trim());
	if (limit < 1 || limit > ASSISTANT_BRIDGE_MAX_PAGE_SIZE) {
		throw new BridgeInputError(`\`limit\` must be between 1 and ${ASSISTANT_BRIDGE_MAX_PAGE_SIZE}`);
	}
	return limit;
};

const normalizeId = (raw: unknown): string => {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new BridgeInputError("`id` is required and must be a non-empty string");
	}
	return raw.trim();
};

const normalizeCursor = (raw: unknown): string | undefined => {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new BridgeInputError("`cursor` must be a string");
	return raw;
};

// --- configuration ------------------------------------------------------------

export type BridgeConfig = { readonly baseUrl: string; readonly token: string };

/**
 * Resolve the service location from the environment. `ASSISTANT_TOKEN` is read at call
 * time, not at load time, so a missing token becomes a tool error the model can act on
 * instead of a failure to load the extension.
 */
export const resolveBridgeConfig = (env: BridgeEnv): BridgeConfig => {
	const rawPort = env.ASSISTANT_PORT;
	let port = ASSISTANT_BRIDGE_DEFAULT_PORT;
	if (rawPort !== undefined && rawPort.trim() !== "") {
		if (!/^[0-9]{1,5}$/.test(rawPort.trim())) throw new BridgeInputError("ASSISTANT_PORT must be an integer between 1 and 65535");
		port = Number(rawPort.trim());
		if (port < 1 || port > 65535) throw new BridgeInputError("ASSISTANT_PORT must be between 1 and 65535");
	}
	const token = env.ASSISTANT_TOKEN;
	if (token === undefined || token === "") {
		throw new BridgeInputError(
			"ASSISTANT_TOKEN is not set in this pi process, so the assistant bridge cannot authenticate. Set it to the same value the assistant service uses, then restart pi.",
		);
	}
	return { baseUrl: `http://127.0.0.1:${port}`, token };
};

/** The error-name half of a failure, for `details` and for tests. */
export const failureCode = (error: unknown): string => {
	if (error instanceof BridgeInputError) return "invalid_input";
	if (error instanceof AssistantClientError) return error.code;
	return "bridge_error";
};

export const definitelyNotApplied = (error: unknown): boolean => {
	if (error instanceof BridgeInputError) return true;
	if (error instanceof AssistantClientError) return error.definitelyNotApplied;
	// A bug in this extension told us nothing about the write's fate.
	return false;
};

export const httpStatusOf = (error: unknown): number | undefined =>
	error instanceof AssistantClientError ? error.httpStatus : undefined;

type FailureSpec = { readonly kind: "read" | "mutation"; readonly operationId?: string | undefined };

/**
 * What a failure means for the caller's safety. This is the most important text in the
 * bridge: a model told "it failed" when the truth is "unknown" will happily create a
 * duplicate, and a model told "unknown" when it definitely failed will nag the user.
 */
export const describeFailure = (error: unknown, spec: FailureSpec): string => {
	if (error instanceof BridgeInputError) {
		return `${error.message}\nNothing was sent to the assistant service.`;
	}
	if (error instanceof AssistantClientError) {
		const lines = [error.message];
		if (spec.kind === "read") {
			lines.push("No todo data was changed. Reading again is safe.");
			return lines.join("\n");
		}
		if (error.definitelyNotApplied) {
			lines.push("Nothing was written: the assistant service did not accept the request.");
			return lines.join("\n");
		}
		lines.push(
			"The outcome is UNKNOWN: the request may already have been committed. Do not invent a new operation for the same intent.",
		);
		const operationId = error.operationId ?? spec.operationId;
		lines.push(
			operationId === undefined
				? "Retry with the operationId reported by the failed call."
				: `Retry with operationId "${operationId}": the service resolves the same operationId to the same todo, so such a retry cannot duplicate it.`,
		);
		return lines.join("\n");
	}
	const detail = error instanceof Error ? error.message : String(error);
	return [
		`The assistant bridge failed unexpectedly: ${detail}`,
		spec.kind === "read"
			? "No todo data was changed."
			: "Nothing can be concluded about whether the write was applied, so do not report it as failed.",
	].join("\n");
};

// --- result shaping -----------------------------------------------------------

type BridgeDetails =
	| { readonly ok: true; readonly tool: string; readonly todo: AssistantTodo }
	| {
			readonly ok: true;
			readonly tool: string;
			readonly items: readonly AssistantTodo[];
			readonly nextCursor: string | null;
	  }
	| {
			readonly ok: false;
			readonly tool: string;
			readonly code: string;
			readonly definitelyNotApplied: boolean;
			readonly operationId?: string;
			readonly httpStatus?: number;
	  };

type Success = { readonly details: BridgeDetails; readonly text: string };

/** A successful result: the model-facing text and the structured form agree. */
const succeed = (details: BridgeDetails, text: string): ExtensionToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
	structuredContent: details,
});

/** A failed result. Reported with `isError` rather than thrown, so `details` survives. */
const failed = (
	tool: string,
	spec: FailureSpec,
	error: unknown,
): ExtensionToolResult<unknown> => {
	const status = httpStatusOf(error);
	const details: BridgeDetails = {
		ok: false,
		tool,
		code: failureCode(error),
		definitelyNotApplied: definitelyNotApplied(error),
		...(spec.operationId === undefined ? {} : { operationId: spec.operationId }),
		...(status === undefined ? {} : { httpStatus: status }),
	};
	return { content: [{ type: "text", text: describeFailure(error, spec) }], details, structuredContent: details, isError: true };
};

const describeTodo = (todo: AssistantTodo): string =>
	[`title: ${todo.title}`, `id: ${todo.id}`, `status: ${todo.status}`, `createdAt: ${todo.createdAt}`, `completedAt: ${todo.completedAt ?? "-"}`].join(
		"\n",
	);

const describeTodoLine = (todo: AssistantTodo): string =>
	`- [${todo.status}] ${todo.title} (id ${todo.id}, created ${todo.createdAt}${todo.completedAt === null ? "" : `, completed ${todo.completedAt}`})`;

// --- tool schemas -------------------------------------------------------------

const optionalOperationId = () =>
	Type.Optional(
		Type.String({
			maxLength: ASSISTANT_BRIDGE_OPERATION_ID_MAX_CHARS,
			description:
				"Identity of this operation. Omit it for a new intent. To retry a call whose outcome was unknown, pass the exact operationId that call reported — the service then returns the original todo instead of creating a second one.",
		}),
	);

const CreateParameters = Type.Object(
	{
		title: Type.String({
			minLength: 1,
			maxLength: ASSISTANT_BRIDGE_TITLE_MAX_CHARS,
			description: "What needs to be done, as one short line.",
		}),
		operationId: optionalOperationId(),
	},
	{ additionalProperties: false },
);

const ListParameters = Type.Object(
	{
		status: Type.Optional(
			Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Literal("all")], {
				description: "Which todos to return. Defaults to open.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: ASSISTANT_BRIDGE_MAX_PAGE_SIZE,
				default: ASSISTANT_CLIENT_DEFAULT_LIMIT,
				description: `Page size, 1 to ${ASSISTANT_BRIDGE_MAX_PAGE_SIZE}. Defaults to ${ASSISTANT_CLIENT_DEFAULT_LIMIT}.`,
			}),
		),
		cursor: Type.Optional(Type.String({ description: "nextCursor from the previous page. Omit for the first page." })),
	},
	{ additionalProperties: false },
);

const GetParameters = Type.Object(
	{ id: Type.String({ minLength: 1, description: "The todo id returned by create or list." }) },
	{ additionalProperties: false },
);

const CompleteParameters = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "The todo id to mark done." }),
		operationId: optionalOperationId(),
	},
	{ additionalProperties: false },
);

// --- registration -------------------------------------------------------------

/**
 * Register the four bridge tools on `pi`. Split out from the default export so tests can
 * pass a fake `ExtensionAPI` and a fixed environment, then drive the real tools against a
 * real service over real HTTP.
 */
export const registerDurableAssistantTools = (pi: ExtensionAPI, env: BridgeEnv = process.env): void => {
	/** Resolve config, run the call, and turn *any* failure into a reported tool error. */
	const guarded = async (
		tool: string,
		spec: FailureSpec,
		run: (client: AssistantClient) => Promise<Success>,
	): Promise<ExtensionToolResult<unknown>> => {
		let client: AssistantClient;
		try {
			client = createAssistantClient(resolveBridgeConfig(env));
		} catch (error) {
			return failed(tool, spec, error);
		}
		try {
			const outcome = await run(client);
			return succeed(outcome.details, outcome.text);
		} catch (error) {
			return failed(tool, spec, error);
		}
	};

	pi.registerTool({
		name: "assistant_todo_create",
		label: "Create todo",
		description:
			"Create a todo in the user's persistent todo store. Use this for a NEW intention. To retry a create whose outcome was unknown, call it again with the same operationId instead of a new one.",
		promptSnippet: "assistant_todo_create — add a todo to the persistent store",
		promptGuidelines: [
			"Call assistant_todo_create once per intention. If the result says the outcome is unknown, retry with the same operationId it reported — never with a fresh one, or the user gets a duplicate todo.",
			"Pass operationId only when retrying: it is the identity of the operation, not a description of the todo.",
		],
		parameters: CreateParameters,
		async execute(toolCallId, params, signal) {
			let title: string;
			let operationId: string;
			try {
				title = normalizeTitle(params.title);
				operationId = normalizeOperationId(params.operationId) ?? deriveOperationId(toolCallId);
			} catch (error) {
				return failed("assistant_todo_create", { kind: "mutation" }, error);
			}
			return guarded("assistant_todo_create", { kind: "mutation", operationId }, async (client) => {
				const todo = await client.createTodo({ title, operationId }, { signal });
				return {
					details: { ok: true, tool: "assistant_todo_create", todo },
					text: [
						"Created a todo.",
						describeTodo(todo),
						`operationId: ${operationId}`,
						"Keep this operationId: passing it again returns this same todo instead of creating another.",
					].join("\n"),
				};
			});
		},
	});

	pi.registerTool({
		name: "assistant_todo_list",
		label: "List todos",
		description: "List todos from the persistent store, one bounded page at a time, oldest first.",
		promptSnippet: "assistant_todo_list — read the persistent todo store",
		parameters: ListParameters,
		async execute(_toolCallId, params, signal) {
			let status: AssistantTodoFilter;
			let limit: number;
			let cursor: string | undefined;
			try {
				status = normalizeStatus(params.status);
				limit = normalizeLimit(params.limit);
				cursor = normalizeCursor(params.cursor);
			} catch (error) {
				return failed("assistant_todo_list", { kind: "read" }, error);
			}
			return guarded("assistant_todo_list", { kind: "read" }, async (client) => {
				const page = await client.listTodos({ status, limit, cursor }, { signal });
				if (page.items.length === 0) {
					return {
						details: { ok: true, tool: "assistant_todo_list", items: [], nextCursor: page.nextCursor },
						text: cursor === undefined ? `No ${status} todos.` : "No more todos.",
					};
				}
				const lines = [`${page.items.length} ${status} todo(s):`, ...page.items.map(describeTodoLine)];
				lines.push(
					page.nextCursor === null
						? "End of list (no nextCursor)."
						: `More results are available: call assistant_todo_list again with cursor "${page.nextCursor}".`,
				);
				return {
					details: { ok: true, tool: "assistant_todo_list", items: page.items, nextCursor: page.nextCursor },
					text: lines.join("\n"),
				};
			});
		},
	});

	pi.registerTool({
		name: "assistant_todo_get",
		label: "Get todo",
		description: "Read one todo by id from the persistent store.",
		promptSnippet: "assistant_todo_get — read one todo by id",
		parameters: GetParameters,
		async execute(_toolCallId, params, signal) {
			let id: string;
			try {
				id = normalizeId(params.id);
			} catch (error) {
				return failed("assistant_todo_get", { kind: "read" }, error);
			}
			return guarded("assistant_todo_get", { kind: "read" }, async (client) => {
				const todo = await client.getTodo(id, { signal });
				return {
					details: { ok: true, tool: "assistant_todo_get", todo },
					text: describeTodo(todo),
				};
			});
		},
	});

	pi.registerTool({
		name: "assistant_todo_complete",
		label: "Complete todo",
		description:
			"Mark a todo done. Completing an already-done todo is not an error and returns the same todo. To retry a completion whose outcome was unknown, call it again with the same operationId.",
		promptSnippet: "assistant_todo_complete — mark a todo done",
		promptGuidelines: [
			"If assistant_todo_complete reports an unknown outcome, retry with the same operationId. Completing twice is idempotent, so a retry cannot mark the wrong todo done.",
		],
		parameters: CompleteParameters,
		async execute(toolCallId, params, signal) {
			let id: string;
			let operationId: string;
			try {
				id = normalizeId(params.id);
				operationId = normalizeOperationId(params.operationId) ?? deriveOperationId(toolCallId);
			} catch (error) {
				return failed("assistant_todo_complete", { kind: "mutation" }, error);
			}
			return guarded("assistant_todo_complete", { kind: "mutation", operationId }, async (client) => {
				const todo = await client.completeTodo({ id, operationId }, { signal });
				return {
					details: { ok: true, tool: "assistant_todo_complete", todo },
					text: [`Todo ${todo.id} is done.`, describeTodo(todo), `operationId: ${operationId}`].join("\n"),
				};
			});
		},
	});
};

/** What pi loads. Registers tools and nothing else. */
export default function durableAssistant(pi: ExtensionAPI): void {
	registerDurableAssistantTools(pi, process.env);
}
