// -----------------------------------------------------------------------------
// Narrow local declarations for the two modules pi injects into extensions.
//
// Why this file exists instead of a dependency: pi's extension loader doesn't resolve
// these specifiers from `node_modules` at all — it installs them as jiti *aliases*
// (see `@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`, `getAliases()`).
// The alias always wins over anything this repository could install, so adding
// `typebox` as a dependency would give us a *second* TypeBox instance at typecheck time
// while the host still hands the extension its own copy at runtime. That mismatch is
// exactly the kind of thing that breaks schema validation silently, so we don't do it.
//
// Consequences, stated plainly:
//   * This file is an approximation, not the host's type surface. It cannot catch
//     misuse of host APIs we did not declare, and it will not notice a host upgrade.
//   * What it *does* buy: our own code is typechecked. To keep that meaningful, the
//     host-supplied `params` is declared as `Record<string, unknown>` rather than
//     `any`/`Static<T>`, so `index.ts` is forced to validate model input itself.
//   * The real contract is verified by loading this extension with pi's real loader in
//     tests/assistant/phase3-extension.test.ts, not by types.
// -----------------------------------------------------------------------------

declare module "typebox" {
	/** Stand-in for TypeBox's `TSchema`. */
	export type TSchema = Record<string, unknown>;

	/** Stand-in for TypeBox's `Static`. We never rely on it — see the header. */
	export type Static<T> = unknown;

	export const Type: {
		Object(
			properties: Record<string, TSchema>,
			options?: Record<string, unknown>,
		): TSchema;
		String(options?: {
			readonly description?: string;
			readonly minLength?: number;
			readonly maxLength?: number;
			readonly pattern?: string;
			readonly default?: string;
		}): TSchema;
		Integer(options?: {
			readonly description?: string;
			readonly minimum?: number;
			readonly maximum?: number;
			readonly default?: number;
		}): TSchema;
		Union(members: TSchema[], options?: Record<string, unknown>): TSchema;
		Literal(value: string, options?: Record<string, unknown>): TSchema;
		Optional(schema: TSchema): TSchema;
	};
}

declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionToolContent = { readonly type: "text"; readonly text: string };

	export interface ExtensionToolResult<TDetails = unknown> {
		readonly content: ExtensionToolContent[];
		readonly details: TDetails;
		/** Machine-readable form; it must agree with `content`, which the model reads. */
		readonly structuredContent?: unknown;
		/**
		 * Report a failure without throwing: the model sees `content` as an error result
		 * while `details` is preserved for the UI.
		 */
		readonly isError?: boolean;
	}

	export interface ExtensionToolDefinition<TParams extends import("typebox").TSchema = import("typebox").TSchema> {
		readonly name: string;
		readonly label: string;
		readonly description: string;
		readonly promptSnippet?: string;
		readonly promptGuidelines?: string[];
		readonly parameters: TParams;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<ExtensionToolResult<unknown>>;
	}

	export interface ExtensionAPI {
		registerTool<TParams extends import("typebox").TSchema>(tool: ExtensionToolDefinition<TParams>): void;
	}

	export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
}
