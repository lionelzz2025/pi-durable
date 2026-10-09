// -----------------------------------------------------------------------------
// Assistant service entry point.
//
// Start order (from the plan): validate config -> take exclusive storage -> open the
// session -> listen. Every failure releases what was already acquired, so a failed
// start never leaves a lock or a socket behind.
//
//   npm run assistant
//
// Stop with Ctrl-C, or SIGTERM. Both drain in-flight requests before closing.
// -----------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { ASSISTANT_SERVICE_VERSION, AssistantConfigError, resolveAssistantConfig } from "./config.ts";
import { createShutdownController, installShutdownHandlers } from "./lifecycle.ts";
import { startAssistantServer, type AssistantServer } from "./server.ts";
import { AssistantDatabaseBusyError, openAssistantStore } from "./storage.ts";

const report = (message: string): void => {
	console.log(`[assistant] ${message}`);
};

const fail = (message: string): void => {
	console.error(`[assistant] ${message}`);
	process.exitCode = 1;
};

const run = async (): Promise<void> => {
	// --- config ---------------------------------------------------------------
	let config;
	try {
		config = resolveAssistantConfig(process.env);
	} catch (error) {
		if (error instanceof AssistantConfigError) {
			fail(error.message);
			return;
		}
		throw error;
	}

	// --- exclusive storage ----------------------------------------------------
	let store;
	try {
		store = await openAssistantStore(config.databasePath);
	} catch (error) {
		if (error instanceof AssistantDatabaseBusyError) {
			fail(error.message);
			return;
		}
		console.error("[assistant] could not open the assistant database:", error);
		process.exitCode = 1;
		return;
	}

	// --- listener -------------------------------------------------------------
	let server: AssistantServer;
	try {
		server = await startAssistantServer({
			store,
			token: config.token,
			port: config.port,
			host: config.host,
			version: ASSISTANT_SERVICE_VERSION,
		});
	} catch (error) {
		console.error("[assistant] could not start the listener:", error);
		await store.close().catch(() => undefined);
		process.exitCode = 1;
		return;
	}

	report(`listening on ${server.url} (data directory: ${config.dataDir})`);
	report("the database is held exclusively by this process; press Ctrl-C to stop");

	// The token is intentionally never logged, not even its length.
	const controller = createShutdownController({
		close: () => server.close(),
		report,
	});
	installShutdownHandlers({
		controller,
		report,
		failure: (message, detail) => {
			console.error(`[assistant] ${message}`);
			if (detail !== undefined) console.error(detail);
			process.exitCode = 1;
		},
	});
};

// Only run when executed directly, so a test can import helpers from this module.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	await run();
}
