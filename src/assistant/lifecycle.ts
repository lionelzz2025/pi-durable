// -----------------------------------------------------------------------------
// Shutdown: one drain, however it is asked for.
//
// `SIGINT`, `SIGTERM` and a fatal process error all funnel into the same
// controller, which guarantees the close runs exactly once — closing the listener
// and closing the store are the same resource, and a second close would race the
// first. A second trigger while draining exits immediately, so a drain that hangs
// cannot trap the operator.
//
// Windows note: Node cannot deliver SIGTERM or SIGINT to *another* process on
// Windows; `child.kill("SIGTERM")` terminates the target outright and a handler
// never runs. The graceful path on Windows is the Ctrl-C the operator presses in
// the console that owns the service (Node maps that console event to SIGINT). A
// programmatic SIGTERM is therefore a hard kill there — which is safe, because every
// write is a single transaction and the file lock is released by the OS. The
// injection points here exist so the wiring itself stays verifiable.
// -----------------------------------------------------------------------------

export type ShutdownState = "running" | "draining" | "stopped";

export type ShutdownController = {
	readonly state: () => ShutdownState;
	/** True from the first shutdown request until the close settles. */
	readonly draining: () => boolean;
	/** Start the graceful close. Idempotent: every call returns the same promise. */
	readonly shutdown: (reason: string) => Promise<void>;
};

export const createShutdownController = (options: {
	readonly close: () => Promise<void>;
	readonly report?: (message: string) => void;
}): ShutdownController => {
	const report = options.report ?? ((): void => undefined);
	let state: ShutdownState = "running";
	let draining: Promise<void> | undefined;

	return {
		state: () => state,
		draining: () => state === "draining",
		shutdown: (reason) => {
			if (draining === undefined) {
				state = "draining";
				report(`${reason} received; draining in-flight requests, then closing`);
				draining = options.close().then(
					() => {
						state = "stopped";
						report("stopped; the database lock is released");
					},
					(error: unknown) => {
						state = "stopped";
						throw error;
					},
				);
			}
			return draining;
		},
	};
};

/** The slice of the process this module needs, so a test can supply its own. */
export type SignalSource = {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
};

/**
 * Wire the process signals and the fatal-error paths to the controller.
 *
 * A normal drain does not call `exit`: once the listener and the store are closed
 * nothing holds the event loop, so the process ends on its own with exit code 0 and
 * a flushed stdout. A second trigger, or a drain that fails, exits with 1.
 */
export const installShutdownHandlers = (options: {
	readonly controller: ShutdownController;
	/** Defaults to the real `process`. */
	readonly source?: SignalSource;
	readonly exit?: (code: number) => void;
	readonly report?: (message: string) => void;
	readonly failure?: (message: string, detail?: unknown) => void;
}): void => {
	const source = options.source ?? process;
	const exit = options.exit ?? ((code: number): void => process.exit(code));
	const report = options.report ?? ((): void => undefined);
	const failure = options.failure ?? ((): void => undefined);

	const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
		report(`${signal} received`);
		if (options.controller.draining()) {
			failure(`${signal} received again; exiting immediately`);
			exit(1);
			return;
		}
		void options.controller.shutdown(signal).catch((error: unknown) => {
			failure("shutdown failed", error);
			exit(1);
		});
	};

	const onFatal = (reason: "unhandledRejection" | "uncaughtException", detail: unknown): void => {
		failure(reason, detail);
		if (options.controller.draining()) {
			exit(1);
			return;
		}
		void options.controller
			.shutdown(reason)
			.catch(() => undefined)
			.then(() => {
				exit(1);
			});
	};

	source.on("SIGINT", () => onSignal("SIGINT"));
	source.on("SIGTERM", () => onSignal("SIGTERM"));
	source.on("unhandledRejection", (detail: unknown) => onFatal("unhandledRejection", detail));
	source.on("uncaughtException", (detail: unknown) => onFatal("uncaughtException", detail));
};
