// -----------------------------------------------------------------------------
// Phase 3 verification, V16: pi's *real* extension loader.
//
// `extensions/durable-assistant/host-modules.d.ts` declares the host API by hand, which
// means tsc cannot tell us whether those declarations match pi. This file closes that
// gap the only way that counts: it imports the loader out of the installed pi package
// and loads the extension with it, then executes a tool through the object the loader
// produced against a real service.
//
// Hermetic by construction: cwd and agentDir are pointed at empty directories inside
// `data/test-runs/`, so pi's own extension discovery finds nothing else — the only
// extension loaded is ours. The user's global extensions (the WeChat bridge among them)
// are never touched.
//
// If pi is not installed where this test can find it, the loader test *skips* with a
// reason rather than passing quietly. V16 then rests on the manual `pi -p` smoke run
// recorded in progress.md.
//
// Run:  npm test
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createRunDir, databasePathIn, startTestService, type TestService } from "./helpers.ts";

const EXTENSION_DIR = join(import.meta.dirname, "..", "..", "extensions", "durable-assistant");
const EXTENSION_ENTRY = join(EXTENSION_DIR, "index.ts");

const TOOL_NAMES = ["assistant_todo_complete", "assistant_todo_create", "assistant_todo_get", "assistant_todo_list"];

/** The host modules an extension may resolve through pi's loader aliases. */
const ALLOWED_IMPORTS = new Set([
	"node:crypto",
	"typebox",
	"@earendil-works/pi-coding-agent",
	"./client.ts",
]);

// --- locating the installed pi package ---------------------------------------

/**
 * The directory holding the installed `@earendil-works/pi-coding-agent` package.
 *
 * This repository does not depend on pi (the extension resolves it through the loader's
 * alias), so the package has to be found. Three independent routes, in order of
 * explicitness: an override for CI, the npm prefix that owns the `pi` launcher, and
 * npm's global root.
 */
const findPiPackageDir = (): string | undefined => {
	const candidates: string[] = [];

	const override = process.env.PI_CODING_AGENT_PACKAGE;
	if (override !== undefined && override.length > 0) candidates.push(override);

	const launcher = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" });
	const launcherPath = (launcher.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (launcherPath !== undefined) {
		candidates.push(join(join(launcherPath, ".."), "node_modules", "@earendil-works", "pi-coding-agent"));
	}

	const npmRoot = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8" });
	const npmRootPath = (npmRoot.stdout ?? "").trim();
	if (npmRootPath.length > 0) candidates.push(join(npmRootPath, "@earendil-works", "pi-coding-agent"));

	return candidates.find((candidate) => existsSync(join(candidate, "dist", "index.js")));
};

// --- the loader's surface, as far as this test uses it ------------------------

type LoaderToolResult = {
	readonly content: ReadonlyArray<{ readonly text: string }>;
	readonly details: unknown;
	readonly isError?: boolean;
	readonly structuredContent?: unknown;
};

type LoadedTool = {
	readonly definition: {
		readonly name: string;
		readonly label: string;
		readonly description: string;
		execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<LoaderToolResult>;
	};
};

type LoaderResult = {
	readonly extensions: ReadonlyArray<{ readonly path: string; readonly tools: Map<string, LoadedTool> }>;
	readonly errors: ReadonlyArray<{ readonly path: string; readonly error: string }>;
};

type DiscoverAndLoadExtensions = (
	configuredPaths: readonly string[],
	cwd: string,
	agentDir?: string,
) => Promise<LoaderResult>;

// --- source-level invariants --------------------------------------------------

/** Every `from "..."` specifier in a source file, in order. */
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

test("V16: the extension imports only what the host loader can resolve", () => {
	// The extension is loaded by path as a *package*, next to a playground that has its
	// own dependencies. Every import here must either be a Node builtin, one of pi's
	// jiti aliases, or a sibling file — anything else would work under tsc and fail in
	// pi. This test is the cheap half of that contract; the loader test below is the
	// expensive half.
	for (const file of ["index.ts", "client.ts"]) {
		const source = readFileSync(join(EXTENSION_DIR, file), "utf8");
		for (const specifier of importSpecifiers(source)) {
			assert.ok(ALLOWED_IMPORTS.has(specifier), `${file} imports ${JSON.stringify(specifier)}, which the host loader cannot resolve`);
		}
		// The service's own code is deliberately *not* imported: the bridge duplicates the
		// handful of constants it needs so that loading the extension can never pull in the
		// playground's runtime dependencies.
		assert.doesNotMatch(source, /from\s+"[^"]*\/src\//);
	}

	// `client.ts` is the HTTP layer and has no imports at all. That is worth pinning: it
	// means the part of the bridge that does the talking cannot fail to load for a reason
	// unrelated to pi, and it keeps the failure surface of a tool call limited to `fetch`.
	assert.deepEqual(importSpecifiers(readFileSync(join(EXTENSION_DIR, "client.ts"), "utf8")), []);
});

test("V16: host packages are peer dependencies, so pi starts without a warning", () => {
	const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	const hostPackages = ["typebox", "@earendil-works/pi-coding-agent"];

	for (const dependency of hostPackages) {
		// A real (non-peer) dependency would install a second copy that can bypass the
		// loader's aliases — pi warns about exactly this at startup.
		assert.equal(manifest.dependencies?.[dependency], undefined, `${dependency} must not be a dependency`);
		assert.equal(manifest.peerDependencies?.[dependency], "*", `${dependency} must be a peerDependency with a "*" range`);
	}
	assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
});

// --- the real loader ----------------------------------------------------------

test("V16: pi's real loader loads the bridge and its tools work end to end", { timeout: 120_000 }, async (t) => {
	const piDir = findPiPackageDir();
	if (piDir === undefined) {
		t.skip(
			"could not locate the installed pi package (set PI_CODING_AGENT_PACKAGE to its directory); " +
				"V16's loader half then rests on the manual `pi -p` smoke run in progress.md",
		);
		return;
	}

	const piEntry = join(piDir, "dist", "index.js");
	const { discoverAndLoadExtensions } = (await import(pathToFileURL(piEntry).href)) as {
		discoverAndLoadExtensions: DiscoverAndLoadExtensions;
	};
	assert.equal(typeof discoverAndLoadExtensions, "function", `${piEntry} does not export discoverAndLoadExtensions`);

	// Empty cwd and empty agentDir: pi's own discovery has nowhere to look, so the only
	// extension in the result is the one requested.
	const runDir = await createRunDir("v16-loader");
	const emptyCwd = join(runDir, "cwd");
	const emptyAgentDir = join(runDir, "agent");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(emptyCwd, { recursive: true });
	await mkdir(join(emptyAgentDir, "extensions"), { recursive: true });

	const result = await discoverAndLoadExtensions([EXTENSION_DIR], emptyCwd, emptyAgentDir);
	assert.deepEqual(
		result.errors.map((error) => `${error.path}: ${error.error}`),
		[],
		"pi's loader reported errors",
	);
	assert.equal(result.extensions.length, 1, `expected exactly one extension, got ${result.extensions.length}`);
	const loaded = result.extensions[0];
	assert.ok(loaded !== undefined);

	// The loaded path is *our* entry file, i.e. the loader really did resolve the package.
	assert.equal(loaded.path.replace(/\\/g, "/").endsWith("extensions/durable-assistant/index.ts"), true, `unexpected path ${loaded.path}`);
	assert.deepEqual([...loaded.tools.keys()].sort(), TOOL_NAMES);

	// Presence is not proof of usability: run the tool object the loader produced, with
	// the real 5-argument signature, against a real service. This is the one place where
	// the hand-written host declarations are checked against the host.
	const runDirForService = await createRunDir("v16-service");
	const service: TestService = await startTestService(databasePathIn(runDirForService));
	try {
		// `ASSISTANT_PORT`/`ASSISTANT_TOKEN` are read from the extension's own process
		// environment when a tool runs, so pointing them at the test service is enough.
		const previousPort = process.env.ASSISTANT_PORT;
		const previousToken = process.env.ASSISTANT_TOKEN;
		process.env.ASSISTANT_PORT = String(service.server.port);
		process.env.ASSISTANT_TOKEN = service.token;
		try {
			const create = loaded.tools.get("assistant_todo_create");
			assert.ok(create !== undefined);
			const created = await create.definition.execute("call-1", { title: "loaded through pi" }, undefined, undefined, undefined);
			assert.notEqual(created.isError, true, JSON.stringify(created.content));
			const todo = (created.details as { todo?: { id: string; title: string; status: string } }).todo;
			assert.equal(todo?.title, "loaded through pi");
			assert.equal(todo?.status, "open");

			const list = loaded.tools.get("assistant_todo_list");
			assert.ok(list !== undefined);
			const listed = await list.definition.execute("call-2", {}, undefined, undefined, undefined);
			assert.deepEqual(listed.structuredContent, listed.details);
			assert.equal((listed.details as { items: unknown[] }).items.length, 1);

			// The write really landed in the service's own storage.
			const response = await fetch(new URL(`/v1/todos/${todo?.id ?? ""}`, `http://127.0.0.1:${service.server.port}`), {
				headers: { authorization: `Bearer ${service.token}` },
			});
			assert.equal(response.status, 200);

			const complete = loaded.tools.get("assistant_todo_complete");
			assert.ok(complete !== undefined);
			const completed = await complete.definition.execute("call-3", { id: todo?.id }, undefined, undefined, undefined);
			assert.equal((completed.details as { todo?: { status: string } }).todo?.status, "done");
		} finally {
			if (previousPort === undefined) delete process.env.ASSISTANT_PORT;
			else process.env.ASSISTANT_PORT = previousPort;
			if (previousToken === undefined) delete process.env.ASSISTANT_TOKEN;
			else process.env.ASSISTANT_TOKEN = previousToken;
		}
	} finally {
		await service.close();
	}
});

test("V16: the loader reports a broken entry rather than hiding it", { timeout: 120_000 }, async (t) => {
	const piDir = findPiPackageDir();
	if (piDir === undefined) {
		t.skip("could not locate the installed pi package");
		return;
	}
	const { discoverAndLoadExtensions } = (await import(pathToFileURL(join(piDir, "dist", "index.js")).href)) as {
		discoverAndLoadExtensions: DiscoverAndLoadExtensions;
	};

	// A negative control for the test above: if the loader reported "no errors" no matter
	// what, the previous assertions would be worthless. This proves the error channel is
	// live and that a genuinely broken extension is caught.
	const runDir = await createRunDir("v16-loader-negative");
	const emptyCwd = join(runDir, "cwd");
	const emptyAgentDir = join(runDir, "agent");
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(emptyCwd, { recursive: true });
	await mkdir(join(emptyAgentDir, "extensions"), { recursive: true });
	const brokenDir = join(runDir, "broken-extension");
	await mkdir(brokenDir, { recursive: true });
	await writeFile(join(brokenDir, "index.ts"), 'export default function () { throw new Error("this factory is deliberately broken"); }\n');

	const result = await discoverAndLoadExtensions([brokenDir], emptyCwd, emptyAgentDir);
	assert.ok(result.errors.length > 0, "the loader accepted a factory that throws");
	assert.match(JSON.stringify(result.errors), /deliberately broken/);
	assert.equal(result.extensions.length, 0);
});
