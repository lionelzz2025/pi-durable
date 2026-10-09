// -----------------------------------------------------------------------------
// Child-process probe for the Phase 1 cross-process exclusivity checks.
//
// Usage: node tests/assistant/fixtures/store-child.ts <dbPath> <plain|exclusive|hold> <attempts>
//
//   plain      open with the library default (WAL, no exclusive lock) and write
//   exclusive  open through openAssistantStore (single-writer guard) and write
//   hold       take the guard, report, then stay alive until the parent kills us
//
// Prints exactly one JSON line and exits 0 even on failure, so the parent reads a
// structured outcome instead of decoding a stack trace.
// -----------------------------------------------------------------------------

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Session } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ASSISTANT_BUSY_TIMEOUT_MS, openAssistantStore } from "../../../src/assistant/storage.ts";

const context = BACKGROUND_CONTEXT;

type Counters = { attempts: number };

const CounterDoc = defineDoc<Counters>({
	kind: "phase1.counter",
	version: 1,
	scope: "session",
	initial: () => ({ attempts: 0 }),
});

const report = (payload: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const describeError = (error: unknown): string => {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
};

const [databasePath, mode, rawAttempts] = process.argv.slice(2);

try {
	let session: Session;
	let close: () => Promise<void>;

	if (mode === "plain") {
		const storage = await openNodeSqliteStorage(databasePath!, { busyTimeoutMs: ASSISTANT_BUSY_TIMEOUT_MS });
		session = createSession(storage);
		close = () => session.close(context);
	} else {
		const store = await openAssistantStore(databasePath!);
		session = store.session;
		close = store.close;
	}

	if (mode === "hold") {
		// The guard (and its file lock) is already held: openAssistantStore probes
		// the store with one read transaction. Wait to be killed, so the parent can
		// prove the lock dies with the process rather than with a lock file.
		report({ ok: true, mode, holding: true });
		setInterval(() => undefined, 1_000);
	} else {
		const value = await session.commit(async (tx) => {
			const counter = await tx.doc(CounterDoc);
			counter.attempts = Number(rawAttempts);
			return counter.attempts;
		}, context);
		report({ ok: true, mode, value });
		await close();
	}
} catch (error) {
	report({ ok: false, mode, error: describeError(error) });
}

// "hold" never reaches here; every other path exits after reporting.
if (mode !== "hold") process.exit(0);
