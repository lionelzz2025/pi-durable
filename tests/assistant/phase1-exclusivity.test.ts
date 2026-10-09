// -----------------------------------------------------------------------------
// Phase 1 — cross-process exclusivity of the assistant database.
//
// These are the three facts the architecture depends on:
//   1. The library default (WAL) does NOT exclude a second process, and the first
//      process keeps serving its cached tracker value after the second writes.
//   2. `openAssistantStore` (WAL + `PRAGMA locking_mode = EXCLUSIVE` + a probe read)
//      rejects every other process fast, keeps the owner fully usable, and releases
//      the lock on close.
//   3. A SIGKILLed owner leaves no stale lock behind, because the lock lives in the
//      OS file handle rather than in a lock file.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAssistantStore } from "../../src/assistant/storage.ts";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const runDir = join(here, "..", "..", "data", "test-runs", `phase1-exclusive-${process.pid}-${Date.now()}`);
const childScript = join(here, "fixtures", "store-child.ts");

type Counters = { attempts: number };

const CounterDoc = defineDoc<Counters>({
	kind: "phase1.counter",
	version: 1,
	scope: "session",
	initial: () => ({ attempts: 0 }),
});

const dbPath = (name: string): string => join(runDir, name);

// --- child-process plumbing --------------------------------------------------

const spawnChild = (args: readonly string[]): ChildProcessWithoutNullStreams =>
	spawn(process.execPath, [childScript, ...args], { windowsHide: true });

/** Resolve with the child's first JSON line, without destroying its stdout. */
const readJsonLine = (child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> => {
	const stderr: string[] = [];
	let buffered = "";
	return new Promise((resolve, reject) => {
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
		const onData = (chunk: Buffer): void => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			child.stdout.off("data", onData);
			resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => {
			reject(new Error(`child exited (code ${code}) before reporting. stderr: ${stderr.join("")}`));
		});
	});
};

const runChild = async (
	args: readonly string[],
): Promise<{ readonly result: Record<string, unknown>; readonly elapsedMs: number }> => {
	const started = Date.now();
	const child = spawnChild(args);
	const result = await readJsonLine(child);
	if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
	return { result, elapsedMs: Date.now() - started };
};

// --- 1: the gap the guard closes --------------------------------------------

test("library default storage does not exclude a second process", async () => {
	await mkdir(runDir, { recursive: true });
	const path = dbPath("default-not-exclusive.sqlite");

	// Deliberately the library default: WAL + busy timeout, no locking_mode override.
	const storage = await openNodeSqliteStorage(path);
	const session = createSession(storage);
	await session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts = 1;
	}, context);

	const { result } = await runChild([path, "plain", "99"]);
	assert.equal(result.ok, true, `second process was not rejected: ${JSON.stringify(result)}`);
	assert.equal(result.value, 99);

	// The owner's loaded document tracker is not invalidated by another process, so
	// it silently keeps serving the old value. This is why a single writer is not a
	// performance choice but a correctness requirement.
	assert.equal(
		(await session.snapshot(CounterDoc, context))?.attempts,
		1,
		"owner keeps serving its cached tracker while the database already holds 99",
	);
	await session.close(context);

	// The second process really did write the shared durable state.
	const reopened = await openAssistantStore(path);
	assert.equal((await reopened.session.snapshot(CounterDoc, context))?.attempts, 99);
	await reopened.close();
});

// --- 2: the guard rejects competitors, then releases ------------------------

test("the single-writer guard rejects other processes fast and releases on close", async () => {
	await mkdir(runDir, { recursive: true });
	const path = dbPath("guard.sqlite");

	const store = await openAssistantStore(path);
	await store.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts = 1;
	}, context);

	for (const mode of ["plain", "exclusive"] as const) {
		const { result, elapsedMs } = await runChild([path, mode, "99"]);
		assert.equal(result.ok, false, `second process (${mode}) must be rejected: ${JSON.stringify(result)}`);
		assert.match(
			String(result.error),
			/already in use|database is locked/,
			`unexpected rejection reason for ${mode}: ${String(result.error)}`,
		);
		// Fail-fast, not the library's 5s-per-attempt stall. Measured: a rejected
		// child finishes in ~2.3s (≈1.6s node + module startup, ≈0.7s of lock waits),
		// versus ~12.9s when the opener keeps the 5,000 ms busy timeout.
		assert.ok(elapsedMs < 5_000, `rejection took ${elapsedMs}ms; expected fail-fast, not a busy-timeout stall`);
	}

	// Holding the lock must not degrade the owner.
	assert.equal((await store.session.snapshot(CounterDoc, context))?.attempts, 1);
	await store.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts = 2;
	}, context);
	assert.equal((await store.session.snapshot(CounterDoc, context))?.attempts, 2);

	await store.close();

	const after = await runChild([path, "exclusive", "7"]);
	assert.equal(after.result.ok, true, `closing must release the lock: ${JSON.stringify(after.result)}`);
	assert.equal(after.result.value, 7);

	const verify = await openAssistantStore(path);
	assert.equal((await verify.session.snapshot(CounterDoc, context))?.attempts, 7);
	await verify.close();
});

// --- 3: a killed owner strands nothing --------------------------------------

test("a SIGKILLed owner leaves no stale lock", async () => {
	await mkdir(runDir, { recursive: true });
	const path = dbPath("killed-owner.sqlite");

	const seed = await openAssistantStore(path);
	await seed.session.commit(async (tx) => {
		const counter = await tx.doc(CounterDoc);
		counter.attempts = 1;
	}, context);
	await seed.close();

	const holder = spawnChild([path, "hold", "0"]);
	const held = await readJsonLine(holder);
	assert.equal(held.ok, true, `holder failed to take the lock: ${JSON.stringify(held)}`);

	const blocked = await runChild([path, "exclusive", "5"]);
	assert.equal(blocked.result.ok, false, "a held lock must block another process");

	holder.kill("SIGKILL");
	await once(holder, "exit");

	const takeover = await runChild([path, "exclusive", "5"]);
	assert.equal(
		takeover.result.ok,
		true,
		`the OS must release the lock with the process: ${JSON.stringify(takeover.result)}`,
	);
	assert.equal(takeover.result.value, 5);

	const verify = await openAssistantStore(path);
	assert.equal(
		(await verify.session.snapshot(CounterDoc, context))?.attempts,
		5,
		"the database is recovered and writable after the kill",
	);
	await verify.close();
});
