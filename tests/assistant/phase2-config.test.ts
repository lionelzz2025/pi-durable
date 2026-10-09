// -----------------------------------------------------------------------------
// Phase 2 verification, V13 (unit level): configuration resolution.
//
// `phase2-process.test.ts` covers V13 end to end — an invalid token or port must stop
// the real service before it opens anything. This file covers the same contract one
// level down, because the *default* resolution path is otherwise never exercised:
// `helpers.ts` always passes `ASSISTANT_DATA_DIR` explicitly, so "the default data
// directory does not depend on the caller's cwd" was implemented but untested.
//
// That rule is not cosmetic. It is what stops a service launched from another
// directory (a shortcut, an editor task, a cron job) from quietly opening a *second*
// database and serving an empty todo list while the real one sits untouched.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
	ASSISTANT_DEFAULT_HOST,
	ASSISTANT_DEFAULT_PORT,
	ASSISTANT_MIN_TOKEN_CHARS,
	AssistantConfigError,
	assistantProjectRoot,
	resolveAssistantConfig,
} from "../../src/assistant/config.ts";
import { ASSISTANT_DATABASE_FILENAME } from "../../src/assistant/storage.ts";
import { createRunDir } from "./helpers.ts";

/** A token that passes every check, so tests can isolate the field under test. */
const GOOD_TOKEN = "k".repeat(ASSISTANT_MIN_TOKEN_CHARS);

/** Resolve with a fixed, explicit project root so assertions do not depend on the real tree. */
const REQUESTED_ROOT = join("C:", "some", "project");
const resolve = (env: Record<string, string | undefined>) =>
	resolveAssistantConfig({ ASSISTANT_TOKEN: GOOD_TOKEN, ...env }, { projectRoot: REQUESTED_ROOT });

// --- defaults ----------------------------------------------------------------

test("V13 config: defaults are loopback, port 4318, and a project-anchored data directory", () => {
	const config = resolve({});
	assert.equal(config.host, ASSISTANT_DEFAULT_HOST);
	assert.equal(config.host, "127.0.0.1", "the service must never listen on another interface");
	assert.equal(config.port, ASSISTANT_DEFAULT_PORT);
	assert.equal(config.port, 4318);
	assert.equal(config.dataDir, join(REQUESTED_ROOT, "data", "assistant"));
	assert.equal(config.databasePath, join(REQUESTED_ROOT, "data", "assistant", ASSISTANT_DATABASE_FILENAME));
	// An empty/whitespace data dir means "not set", not "the current directory".
	assert.equal(resolve({ ASSISTANT_DATA_DIR: "" }).dataDir, config.dataDir);
	assert.equal(resolve({ ASSISTANT_DATA_DIR: "   " }).dataDir, config.dataDir);
});

test("V13 config: a relative data directory resolves against the project root, an absolute one is kept", () => {
	// Relative: anchored at the project, so a different cwd cannot move it.
	assert.equal(resolve({ ASSISTANT_DATA_DIR: "somewhere/nested" }).dataDir, join(REQUESTED_ROOT, "somewhere", "nested"));
	// Surrounding whitespace is trimmed rather than becoming part of the path.
	assert.equal(resolve({ ASSISTANT_DATA_DIR: "  relative/dir  " }).dataDir, join(REQUESTED_ROOT, "relative", "dir"));
	// Absolute: used verbatim.
	const absolute = process.platform === "win32" ? "C:\\assistant-data" : "/tmp/assistant-data";
	assert.equal(resolve({ ASSISTANT_DATA_DIR: absolute }).dataDir, absolute);
});

test("V13 config: the data directory does not follow the working directory", async () => {
	// The strongest available statement of the rule: nothing here can be satisfied by
	// reading `process.cwd()`, because the probe runs somewhere else entirely — and it
	// prints its own cwd so we know that is actually true.
	const runDir = await createRunDir("v13-config-cwd");
	const elsewhere = join(runDir, "started-from-here");
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(elsewhere, { recursive: true });

	const configUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "assistant", "config.ts")).href;
	const probePath = join(runDir, "probe.mjs");
	await writeFile(
		probePath,
		[
			`import { assistantProjectRoot, resolveAssistantConfig } from ${JSON.stringify(configUrl)};`,
			// Note: no ASSISTANT_DATA_DIR — this is the default-resolution path under test.
			`const config = resolveAssistantConfig({ ASSISTANT_TOKEN: ${JSON.stringify(GOOD_TOKEN)} });`,
			"console.log(JSON.stringify({",
			"  cwd: process.cwd(),",
			"  root: assistantProjectRoot(),",
			"  dataDir: config.dataDir,",
			"  databasePath: config.databasePath,",
			"}));",
		].join("\n"),
	);

	const probe = spawnSync(process.execPath, [probePath], { cwd: elsewhere, encoding: "utf8" });
	assert.equal(probe.status, 0, `probe failed:\n${probe.stderr}`);
	const reported = JSON.parse(probe.stdout.trim()) as {
		cwd: string;
		root: string;
		dataDir: string;
		databasePath: string;
	};

	// The probe really did run somewhere else, so the assertions below mean something.
	assert.equal(reported.cwd.replace(/\\/g, "/"), elsewhere.replace(/\\/g, "/"));
	assert.notEqual(reported.root.replace(/\\/g, "/"), reported.cwd.replace(/\\/g, "/"));
	// The root comes from the module's own location, and the default data dir hangs off it.
	assert.equal(reported.root, assistantProjectRoot());
	assert.equal(reported.dataDir, join(assistantProjectRoot(), "data", "assistant"));
	assert.equal(reported.databasePath, join(reported.dataDir, ASSISTANT_DATABASE_FILENAME));
	// And it is not inside the directory it was started from.
	assert.equal(reported.dataDir.startsWith(elsewhere), false);
});

// --- port --------------------------------------------------------------------

test("V13 config: the port is parsed strictly, and an unusable one is rejected", () => {
	assert.equal(resolve({}).port, ASSISTANT_DEFAULT_PORT);
	assert.equal(resolve({ ASSISTANT_PORT: "" }).port, ASSISTANT_DEFAULT_PORT);
	assert.equal(resolve({ ASSISTANT_PORT: "   " }).port, ASSISTANT_DEFAULT_PORT);
	assert.equal(resolve({ ASSISTANT_PORT: " 4321 " }).port, 4321);
	assert.equal(resolve({ ASSISTANT_PORT: "1" }).port, 1);
	assert.equal(resolve({ ASSISTANT_PORT: "65535" }).port, 65535);

	// Rejected rather than quietly coerced to NaN/default — a typo in a port must not
	// silently move the service somewhere the caller is not looking.
	for (const bad of ["0", "65536", "-1", "80.5", "abc", "4 318", "0x10", "1e3", "８０"]) {
		assert.throws(
			() => resolve({ ASSISTANT_PORT: bad }),
			(err: unknown) => err instanceof AssistantConfigError && /ASSISTANT_PORT must/.test((err as Error).message),
			`port ${JSON.stringify(bad)} should have been rejected`,
		);
	}
});

// --- token -------------------------------------------------------------------

test("V13 config: the token is required, length-checked, and never echoed back", () => {
	assert.throws(
		() => resolveAssistantConfig({}),
		(err: unknown) => err instanceof AssistantConfigError && /ASSISTANT_TOKEN is required/.test((err as Error).message),
	);
	assert.throws(() => resolveAssistantConfig({ ASSISTANT_TOKEN: "" }), AssistantConfigError);

	// The error tells the user how to make a good one, so the message is worth pinning:
	// it is the only guidance they get at startup.
	try {
		resolveAssistantConfig({});
		assert.fail("expected a throw");
	} catch (error) {
		assert.match((error as Error).message, /randomBytes\(32\)\.toString\('base64url'\)/);
	}

	assert.throws(
		() => resolve({ ASSISTANT_TOKEN: "s".repeat(ASSISTANT_MIN_TOKEN_CHARS - 1) }),
		(err: unknown) => err instanceof AssistantConfigError && /at least 32 characters/.test((err as Error).message),
	);
	// Exactly at the floor is accepted; the boundary is inclusive.
	assert.equal(resolve({ ASSISTANT_TOKEN: GOOD_TOKEN }).token, GOOD_TOKEN);

	// Printable ASCII only: this is what makes the token safe to put in a shell, an
	// Authorization header and a .env file without quoting surprises.
	for (const bad of ["a".repeat(31) + " ", "a".repeat(31) + "\t", "a".repeat(31) + "é", "a".repeat(31) + "密", "a".repeat(31) + "\n"]) {
		assert.throws(
			() => resolve({ ASSISTANT_TOKEN: bad }),
			(err: unknown) =>
				err instanceof AssistantConfigError && /printable ASCII/.test((err as Error).message),
			`token ${JSON.stringify(bad)} should have been rejected`,
		);
	}

	// A rejected token must not appear in the message: config errors are printed to the
	// console and may end up in a log or a bug report.
	const secret = "Z".repeat(31) + "!";
	try {
		resolve({ ASSISTANT_TOKEN: secret });
		assert.fail("expected a throw");
	} catch (error) {
		assert.equal((error as Error).message.includes(secret), false, "the error message leaked the token");
	}
});
