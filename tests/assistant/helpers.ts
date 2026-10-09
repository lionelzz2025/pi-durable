// -----------------------------------------------------------------------------
// Shared helpers for the assistant service tests (Phases 2-4).
//
// Every run gets its own directory under data/test-runs/ so a failing test's
// database can be inspected afterwards. Nothing here touches data/assistant/ or
// any other real data, and nothing here deletes files (AGENTS.md: recycle bin
// only) — a run directory is left in place for inspection.
// -----------------------------------------------------------------------------

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { startAssistantServer, type AssistantServer } from "../../src/assistant/server.ts";
import { createTodoService, type TodoService } from "../../src/assistant/store.ts";
import { openAssistantStore, ASSISTANT_DATABASE_FILENAME, type AssistantStore } from "../../src/assistant/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(here, "..", "..");
export const serviceEntry = join(projectRoot, "src", "assistant", "main.ts");

let runCounter = 0;

/** A fresh `data/test-runs/<label>-<pid>-<time>-<n>/` directory. */
export const createRunDir = async (label: string): Promise<string> => {
	runCounter += 1;
	const dir = join(projectRoot, "data", "test-runs", `${label}-${process.pid}-${Date.now()}-${runCounter}`);
	await mkdir(dir, { recursive: true });
	return dir;
};

export const databasePathIn = (runDir: string, name = "assistant.sqlite"): string => join(runDir, name);

/** A token that satisfies the production minimum length. */
export const newToken = (): string => `test${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

// --- in-process service ------------------------------------------------------

export type TestService = {
	readonly store: AssistantStore;
	readonly service: TodoService;
	readonly server: AssistantServer;
	readonly token: string;
	readonly url: string;
	/**
	 * What the listener logged for itself. The in-process equivalent of a spawned
	 * service's stderr: an unexpected internal failure is described here and nowhere the
	 * client can see, so a test asserts on this instead of polluting the test log.
	 */
	readonly logs: () => readonly string[];
	readonly close: () => Promise<void>;
};

/**
 * Open a store and listen on a random loopback port. `port: 0` avoids the window in
 * which a port reserved by a probe is taken by something else.
 */
export const startTestService = async (
	databasePath: string,
	options: {
		readonly token?: string;
		readonly now?: () => string;
		readonly newId?: () => string;
	} = {},
): Promise<TestService> => {
	const store = await openAssistantStore(databasePath);
	const service = createTodoService(store, { now: options.now, newId: options.newId });
	const token = options.token ?? newToken();
	const serverLogs: string[] = [];
	let server: AssistantServer;
	try {
		server = await startAssistantServer({
			store,
			token,
			port: 0,
			host: "127.0.0.1",
			version: "test",
			log: (message, detail) => {
				serverLogs.push(detail === undefined ? message : `${message} ${describe(detail)}`);
			},
		});
	} catch (error) {
		await store.close().catch(() => undefined);
		throw error;
	}
	return {
		store,
		service,
		server,
		token,
		url: `http://127.0.0.1:${server.port}`,
		logs: () => serverLogs,
		close: async () => {
			await server.close();
		},
	};
};

// --- HTTP ---------------------------------------------------------------------

/** The subset of a service a caller needs: where it is and how to authenticate. */
export type Api = { readonly url: string; readonly token: string };

export type ApiResponse = {
	readonly status: number;
	readonly text: string;
	/** Parsed body, or `undefined` when the body was empty or not JSON. */
	readonly json: Record<string, unknown> | undefined;
	readonly headers: Headers;
};

export type CallOptions = {
	/** Serialized as JSON, with `content-type: application/json`. */
	readonly body?: unknown;
	/** Sent verbatim; pair with `contentType` to forge a bad request. */
	readonly raw?: string;
	/** Defaults to `application/json`. `null` omits the header entirely. */
	readonly contentType?: string | null;
	/** Defaults to the service token. `null` omits the header (anonymous request). */
	readonly token?: string | null;
	readonly headers?: Readonly<Record<string, string>>;
};

export const callApi = async (
	api: Api,
	method: string,
	path: string,
	options: CallOptions = {},
): Promise<ApiResponse> => {
	const headers: Record<string, string> = { ...options.headers };
	const token = options.token === undefined ? api.token : options.token;
	if (token !== null) headers.authorization = `Bearer ${token}`;

	let body: string | undefined;
	if (options.raw !== undefined) body = options.raw;
	else if (options.body !== undefined) body = JSON.stringify(options.body);
	if (body !== undefined && options.contentType !== null) {
		headers["content-type"] = options.contentType ?? "application/json";
	}

	const response = await fetch(`${api.url}${path}`, { method, headers, body, redirect: "error" });
	const text = await response.text();
	let json: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = text === "" ? undefined : JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			json = parsed as Record<string, unknown>;
		}
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json, headers: response.headers };
};

/** The `error.code` of a failed response, for concise assertions. */
export const errorCodeOf = (response: ApiResponse): unknown => {
	const error = response.json?.error;
	if (typeof error !== "object" || error === null) return undefined;
	return (error as Record<string, unknown>).code;
};

// --- spawned service ---------------------------------------------------------

export type ServiceProcess = {
	/** `stdin` is `ignore`, so only `stdout`/`stderr` are streams. */
	readonly child: ChildProcessByStdio<null, Readable, Readable>;
	readonly port: number;
	readonly token: string;
	readonly api: Api;
	/** The database file this process was pointed at (`<dataDir>/assistant.sqlite`). */
	readonly databasePath: string;
	readonly stdout: () => string;
	readonly stderr: () => string;
	/** Combined stdout and stderr, for "must never appear in a log" assertions. */
	readonly logs: () => string;
	/** Resolves once the service reports that it is listening. */
	readonly listening: Promise<void>;
	/**
	 * SIGTERM, then wait for the process to be gone. On Windows Node cannot deliver
	 * SIGTERM to another process: the child is terminated outright, `exitCode` stays
	 * `null` and `signalCode` becomes `"SIGTERM"`. Tests must not assert an exit code
	 * here (see `lifecycle.ts`); a hard exit is the expected Windows behaviour.
	 */
	readonly terminate: () => Promise<void>;
	/** SIGKILL: no handlers run, so this is the "hard exit" case. */
	readonly kill: () => void;
	readonly exited: Promise<number | null>;
	/** How the process died: `null` for a normal exit, the signal name otherwise. */
	readonly signalCode: () => NodeJS.Signals | null;
};

/** Reserve a port by binding and releasing it. The plan prescribes random ports. */
export const reserveFreePort = async (): Promise<number> => {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("could not reserve a port");
	return address.port;
};

/** Spawn `src/assistant/main.ts` as a real, separate service process. */
export const spawnService = async (options: {
	readonly dataDir: string;
	readonly token?: string;
	readonly port?: number;
	/** Overrides merged last, so a test can supply a deliberately invalid value. */
	readonly env?: Readonly<Record<string, string>>;
}): Promise<ServiceProcess> => {
	const port = options.port ?? (await reserveFreePort());
	const token = options.token ?? newToken();
	const databasePath = join(options.dataDir, ASSISTANT_DATABASE_FILENAME);
	const child = spawn(process.execPath, [serviceEntry], {
		windowsHide: true,
		env: {
			...process.env,
			ASSISTANT_DATA_DIR: options.dataDir,
			ASSISTANT_TOKEN: token,
			ASSISTANT_PORT: String(port),
			...options.env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let out = "";
	let err = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		err += chunk.toString("utf8");
	});

	const exited = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});

	const listening = new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => {
			reject(new Error(`service did not start in time\nstdout:\n${out}\nstderr:\n${err}`));
		}, 20_000);
		deadline.unref?.();
		const settle = (): void => {
			if (out.includes("listening on ")) {
				clearTimeout(deadline);
				resolve();
			}
		};
		child.stdout.on("data", settle);
		void exited.then((code) => {
			clearTimeout(deadline);
			reject(new Error(`service exited with code ${code} before listening\nstdout:\n${out}\nstderr:\n${err}`));
		});
		settle();
	});
	// Nothing awaits this rejection at spawn time (the caller may not call `listening`),
	// which would be an unhandled rejection. `terminate`/`kill` still work either way.
	listening.catch(() => undefined);

	return {
		child,
		port,
		token,
		api: { url: `http://127.0.0.1:${port}`, token },
		databasePath,
		stdout: () => out,
		stderr: () => err,
		logs: () => out + err,
		listening,
		exited,
		signalCode: () => child.signalCode,
		terminate: async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			const stopped = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000).unref?.()),
			]);
			if (!stopped) {
				child.kill("SIGKILL");
				await exited;
			}
		},
		kill: () => {
			child.kill("SIGKILL");
		},
	};
};

/** Wait until the service answers `/health`, or fail with what the process said. */
export const waitUntilReady = async (process_: ServiceProcess): Promise<void> => {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const response = await callApi(process_.api, "GET", "/health").catch(() => undefined);
		if (response?.status === 200) return;
		if (Date.now() > deadline) {
			throw new Error(
				`service never became ready\nstdout:\n${process_.stdout()}\nstderr:\n${process_.stderr()}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

/** Bind a port and keep it, so a service started on it is guaranteed to fail. */
export const holdPort = async (): Promise<{ readonly port: number; readonly release: () => Promise<void> }> => {
	const holder = createServer();
	await new Promise<void>((resolve, reject) => {
		holder.once("error", reject);
		holder.listen(0, "127.0.0.1", () => resolve());
	});
	const address = holder.address();
	if (address === null || typeof address === "string") throw new Error("could not hold a port");
	return {
		port: address.port,
		release: async () => {
			await new Promise<void>((resolve) => holder.close(() => resolve()));
		},
	};
};

/**
 * Poll the listing until it holds exactly `expected` records, then fail with the
 * process log if it never does. Used to prove a commit really landed before the
 * client is denied its response (V07/V08).
 */
export const waitForTodoCount = async (api: Api, expected: number, process_?: ServiceProcess): Promise<void> => {
	const deadline = Date.now() + 20_000;
	let last: unknown = "no response";
	for (;;) {
		const response = await callApi(api, "GET", "/v1/todos?status=all&limit=100").catch((error: unknown) => {
			last = error;
			return undefined;
		});
		if (response !== undefined) {
			last = `${response.status} ${response.text.slice(0, 200)}`;
			if (response.status === 200) {
				const items = response.json?.items;
				if (Array.isArray(items) && items.length === expected) return;
			}
		}
		if (Date.now() > deadline) {
			throw new Error(
				`expected ${expected} todo(s) but saw: ${String(last)}\nstdout:\n${process_?.stdout() ?? ""}\nstderr:\n${process_?.stderr() ?? ""}`,
			);
		}
		await sleep(25);
	}
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describe = (detail: unknown): string => (detail instanceof Error ? detail.message : String(detail));
