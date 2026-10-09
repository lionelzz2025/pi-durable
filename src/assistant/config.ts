// -----------------------------------------------------------------------------
// Assistant service configuration, resolved from the environment.
//
// Kept separate from main.ts so it can be unit-tested without starting anything.
// -----------------------------------------------------------------------------

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_DATABASE_FILENAME } from "./storage.ts";

/** Loopback only. The service is never reachable from another host. */
export const ASSISTANT_DEFAULT_HOST = "127.0.0.1";
export const ASSISTANT_DEFAULT_PORT = 4318;

/** Minimum token length. `randomBytes(32).toString("base64url")` yields 43 characters. */
export const ASSISTANT_MIN_TOKEN_CHARS = 32;

/** Reported by `GET /health`. Bump by hand when the service contract changes. */
export const ASSISTANT_SERVICE_VERSION = "0.1.0";

/** Raised for any invalid environment input. The message never echoes the token. */
export class AssistantConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssistantConfigError";
	}
}

export type AssistantConfig = {
	/** Directory holding the SQLite file and its sidecars. */
	readonly dataDir: string;
	readonly databasePath: string;
	readonly host: string;
	readonly port: number;
	readonly token: string;
};

/**
 * Project root, derived from this file's location (src/assistant/config.ts) rather
 * than from the caller's cwd, so the default data directory does not depend on where
 * a tool, a test or a shortcut happened to be started from.
 */
export const assistantProjectRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const parsePort = (raw: string | undefined): number => {
	if (raw === undefined || raw.trim() === "") return ASSISTANT_DEFAULT_PORT;
	const text = raw.trim();
	if (!/^[0-9]{1,5}$/.test(text)) throw new AssistantConfigError("ASSISTANT_PORT must be an integer between 1 and 65535");
	const port = Number(text);
	if (port < 1 || port > 65535) throw new AssistantConfigError("ASSISTANT_PORT must be between 1 and 65535");
	return port;
};

const parseToken = (raw: string | undefined): string => {
	if (raw === undefined || raw === "") {
		throw new AssistantConfigError(
			"ASSISTANT_TOKEN is required. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
		);
	}
	if (raw.length < ASSISTANT_MIN_TOKEN_CHARS) {
		throw new AssistantConfigError(`ASSISTANT_TOKEN must be at least ${ASSISTANT_MIN_TOKEN_CHARS} characters`);
	}
	// Printable ASCII only, so the token survives a shell, a header and a .env file
	// without quoting surprises.
	for (const character of raw) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x21 || code > 0x7e) {
			throw new AssistantConfigError("ASSISTANT_TOKEN must contain only printable ASCII characters (no spaces)");
		}
	}
	return raw;
};

const parseDataDir = (raw: string | undefined, projectRoot: string): string => {
	if (raw === undefined || raw.trim() === "") return join(projectRoot, "data", "assistant");
	const trimmed = raw.trim();
	return isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed);
};

/**
 * Resolve the full configuration. Throws {@link AssistantConfigError} on any invalid
 * value; the message is safe to print.
 */
export const resolveAssistantConfig = (
	env: Readonly<Record<string, string | undefined>>,
	options: { readonly projectRoot?: string } = {},
): AssistantConfig => {
	const projectRoot = options.projectRoot ?? assistantProjectRoot();
	const dataDir = parseDataDir(env.ASSISTANT_DATA_DIR, projectRoot);
	return {
		dataDir,
		databasePath: join(dataDir, ASSISTANT_DATABASE_FILENAME),
		host: ASSISTANT_DEFAULT_HOST,
		port: parsePort(env.ASSISTANT_PORT),
		token: parseToken(env.ASSISTANT_TOKEN),
	};
};
