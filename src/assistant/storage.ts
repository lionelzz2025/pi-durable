// -----------------------------------------------------------------------------
// Assistant storage: open the durable SQLite file as the *single* writer.
//
// Why this module exists (Phase 1 evidence, @earendil-works/pi-durable@1.1.0):
//
//  * `openNodeSqliteStorage` sets `PRAGMA journal_mode = WAL` and a 5s busy
//    timeout, which gives multi-process readers plus one writer *serialised by
//    SQLite* — not exclusivity. Measured: with process A holding the file, a
//    second process opened the same file and committed successfully, and A's
//    loaded document tracker kept serving its stale value afterwards.
//  * Therefore the service must enforce single-writer itself. `PRAGMA
//    locking_mode = EXCLUSIVE` on the one connection we use makes SQLite hold an
//    OS-level file lock for the connection lifetime: every other process fails
//    with `database is locked` while we hold it. The OS drops the lock when the
//    process dies, so a crash cannot strand a lock file (there is no lock file,
//    and no age-based takeover heuristic is needed).
//  * The lock is taken lazily on the first read or write transaction, so opening
//    must be followed by `probeExclusiveAccess()` before the service reports
//    readiness.
// -----------------------------------------------------------------------------

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	createSession,
	type Session,
	type Storage,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
	openNodeSqliteDatabase,
	type NodeSqliteStorageOptions,
} from "@earendil-works/pi-durable/storage/sqlite/node";

/** File name of the assistant database inside the data directory. */
export const ASSISTANT_DATABASE_FILENAME = "assistant.sqlite";

/**
 * SQLite waits this long for a competing file lock before failing.
 *
 * The library default is 5,000 ms, but SQLite can retry the lock several times
 * while opening (`journal_mode = WAL`, then the schema-version read, then the
 * migration write), and a measured rejection of a second process cost ~12.9 s.
 * That is far too slow for a service that must refuse to start, and it would
 * exceed the bridge tools' HTTP timeout. 250 ms is still generous for the
 * uncontended case, which never waits at all.
 */
export const ASSISTANT_BUSY_TIMEOUT_MS = 250;

/** Raised when another process already owns the assistant database. */
export class AssistantDatabaseBusyError extends Error {
	readonly databasePath: string;

	constructor(databasePath: string, options?: { readonly cause?: unknown }) {
		super(
			`The assistant database is already in use by another process: ${databasePath}. ` +
				"Stop the other instance (or point ASSISTANT_DATA_DIR elsewhere) and start again.",
			options,
		);
		this.name = "AssistantDatabaseBusyError";
		this.databasePath = databasePath;
	}
}

/** SQLite reports a lost race for the file lock as SQLITE_BUSY / "database is locked". */
const isBusyError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false;
	const { code, errcode, message } = error as {
		readonly code?: unknown;
		readonly errcode?: unknown;
		readonly message?: unknown;
	};
	if (code === "ERR_SQLITE_ERROR" && typeof message === "string" && /locked|busy/i.test(message)) return true;
	if (typeof errcode === "number" && (errcode & 0xff) === 5) return true; // SQLITE_BUSY
	return typeof message === "string" && /database is locked|database table is locked|SQLITE_BUSY/i.test(message);
};

export type AssistantStore = {
	/** Absolute path of the SQLite file this store owns. */
	readonly databasePath: string;
	readonly session: Session;
	/**
	 * Enumeration handle. Writes must go through `session.commit`; listing must
	 * come from here because `SessionImpl@1.1.0` does not implement the `scan*`
	 * methods its own type declares.
	 */
	readonly storage: Storage;
	/** Idempotent: a second call is a no-op. */
	readonly close: () => Promise<void>;
};

export type OpenAssistantStoreOptions = {
	readonly sqlite?: NodeSqliteStorageOptions;
	readonly context?: Context;
};

/**
 * Open the assistant database, take the exclusive single-writer lock, and prove
 * it is held. Throws {@link AssistantDatabaseBusyError} when another process owns
 * the file.
 */
export const openAssistantStore = async (
	databasePath: string,
	options: OpenAssistantStoreOptions = {},
): Promise<AssistantStore> => {
	const context = options.context ?? BACKGROUND_CONTEXT;

	let database;
	try {
		database = await openNodeSqliteDatabase(databasePath, {
			busyTimeoutMs: ASSISTANT_BUSY_TIMEOUT_MS,
			...options.sqlite,
		});
		await database.exec("PRAGMA locking_mode = EXCLUSIVE");
	} catch (error) {
		throw isBusyError(error) ? new AssistantDatabaseBusyError(databasePath, { cause: error }) : error;
	}

	let storage: Storage;
	try {
		storage = await SqliteStorage.open(database);
	} catch (error) {
		await database.close().catch(() => undefined);
		throw isBusyError(error) ? new AssistantDatabaseBusyError(databasePath, { cause: error }) : error;
	}

	const session = createSession(storage);

	try {
		// First transaction of the connection: this is where WAL+EXCLUSIVE takes and
		// keeps the file locks. Without it, a competing process could still slip in
		// until our first business write.
		await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, context);
	} catch (error) {
		await session.close(context).catch(() => undefined);
		throw isBusyError(error) ? new AssistantDatabaseBusyError(databasePath, { cause: error }) : error;
	}

	let closed = false;
	return {
		databasePath,
		session,
		storage,
		close: async () => {
			if (closed) return;
			closed = true;
			await session.close(context);
		},
	};
};
