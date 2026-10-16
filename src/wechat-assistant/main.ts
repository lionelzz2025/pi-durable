import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { loadWechatConfig, DEFAULT_CONFIG } from "./config.ts";
import { openCredentialStore } from "./channel/credentials.ts";
import { loginWechat } from "./channel/login.ts";
import { acquireAccountLock } from "./channel/account-lock.ts";
import { WechatApi } from "./channel/api.ts";
import { runPersistentReceiver } from "./receiver.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fasthubProvider } from "../providers/fasthub.ts";
import { runAssistantDaemon } from "./assistant-daemon.ts";
import { senderFromApi } from "./sender.ts";
import { WechatCdn } from "./channel/cdn.ts";
import { backupStoppedDatabase, restoreDatabaseToNewPath } from "./backup.ts";
import { exportLegacyTodos, importLegacyTodos, requireSeparateMigrationPaths } from "./migration.ts";
import { openWechatHarness } from "./runtime.ts";
import { createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runOfflineSelftest } from "./selftest.ts";

export const runWechatCli = async (args: string[]): Promise<void> => {
  const [command, ...flags] = args;
  if (command === "selftest") {
    if (flags.length) throw Error("Offline selftest takes no options");
    console.log(JSON.stringify({ result: "offline-pass", ...(await runOfflineSelftest()) }));
    return;
  }
  let configPath = DEFAULT_CONFIG; let authorize = false; let exclusive = false; let receiveOnly = false; let allowModel = false;
  let source: string | undefined; let destination: string | undefined; let allowMigration = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--config" && flags[i + 1]) configPath = flags[++i]!;
    else if (flags[i] === "--allow-wechat") authorize = true;
    else if (flags[i] === "--legacy-stopped") exclusive = true;
    else if (flags[i] === "--receive-only") receiveOnly = true;
    else if (flags[i] === "--allow-model") allowModel = true;
    else if (flags[i] === "--source" && flags[i + 1]) source = flags[++i];
    else if (flags[i] === "--destination" && flags[i + 1]) destination = flags[++i];
    else if (flags[i] === "--allow-migration") allowMigration = true;
    else throw new Error("Unknown or incomplete CLI option");
  }
  if (!["login", "start", "status", "doctor", "backup", "restore", "migrate"].includes(command ?? "")) {
    throw new Error("Usage: wechat-assistant <selftest|login|start|status|doctor|backup|restore|migrate> [--config ABSOLUTE_PATH]");
  }
  const config = await loadWechatConfig(configPath);
  if (command === "backup" || command === "restore" || command === "migrate") {
    if (!allowMigration || !source || !isAbsolute(source) || !destination || !isAbsolute(destination)) {
      throw Error("Offline maintenance requires --allow-migration --source ABSOLUTE_PATH --destination ABSOLUTE_PATH");
    }
    if (command === "backup") await backupStoppedDatabase(source, destination!);
    else if (command === "restore") await restoreDatabaseToNewPath(source, destination!);
    else {
      const databasePath = resolve(config.dataDir, "assistant.sqlite");
      requireSeparateMigrationPaths(source, databasePath);
      requireSeparateMigrationPaths(destination, databasePath);
      await backupStoppedDatabase(source, destination);
      const exported = await exportLegacyTodos(destination);
      const harness = await openWechatHarness(databasePath, { models: createModels(), registry: createRegistry() });
      try { console.log(JSON.stringify({ result: await importLegacyTodos(harness, exported), todos: exported.todos.length, receipts: exported.receipts.length, sourceHash: exported.sourceHash })); }
      finally { await harness.close(BACKGROUND_CONTEXT); }
    }
    if (command !== "migrate") console.log(JSON.stringify({ result: "created", destination }));
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify({ config: "valid", runtime: "offline-not-probed", shell: config.shell.enabled ? "enabled-requires-local-tty-approval" : "disabled",
      database: resolve(config.dataDir, "assistant.sqlite"), accountOwnership: "not-verified; stop legacy plugin before login/start",
      liveWechat: "not-tested", model: "not-invoked" }));
    return;
  }
  if (command === "start" && !receiveOnly && !allowModel) throw new Error("Agent start requires explicit --allow-model authorization; use --receive-only for inbox capture");
  if ((command === "login" || command === "start") && (!authorize || !exclusive)) throw new Error("Connection requires --allow-wechat and --legacy-stopped; stop and disable the legacy plugin first");
  const release = command === "login" ? await acquireAccountLock(config.accountId) : undefined;
  try {
    const store = await openCredentialStore(resolve(config.dataDir, "credentials.sqlite"));
    try {
      const prior = store.load();
      if (prior && (prior.accountId !== config.accountId || prior.userId !== config.boundUserId)) throw new Error("Stored credentials do not match configured identity");
      if (command === "status") {
        console.log(JSON.stringify({ credentials: prior ? "present-not-remotely-validated" : "missing", runtime: "offline-not-probed",
          accountOwnership: "not-verified", database: resolve(config.dataDir, "assistant.sqlite") }));
        return;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        if (command === "start") {
          if (!prior) throw new Error("Login credentials required");
          if (receiveOnly) {
            console.log("Receive-only: durable inbox enabled; no model processing or replies");
            await runPersistentReceiver({ config, credentials: prior, legacyStopped: exclusive, signal: controller.signal,
              onState: (state) => { console.log(JSON.stringify({ channel: state, mode: "receive-only" })); } });
          } else {
            // Only this project-owned provider is wired; never fall back to global pi models.
            const provider = fasthubProvider();
            const models = createModels(); models.setProvider(provider);
            if (!models.getModel(config.model.provider, config.model.modelId)) throw Error("Configured model is unavailable in this standalone runtime");
            if (!process.env.FH_NOVOSNS_API_KEY) throw Error("Configured model credential unavailable");
            const api = new WechatApi();
            await runAssistantDaemon({ config, credentials: prior, harnessOptions: { models }, api, cdn: new WechatCdn(),
              sender: senderFromApi(api, prior.token), signal: controller.signal, legacyStopped: exclusive,
              onState: (state) => { console.log(JSON.stringify({ channel: state, mode: "assistant" })); } });
          }
          return;
        }
        const credentials = await loginWechat({ api: new WechatApi(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
          expectedAccountId: config.accountId, expectedUserId: config.boundUserId,
          showQr: (content) => { console.log("Local QR content (do not share):"); console.log(content); } });
        store.save(credentials);
        console.log("Credentials saved; no polling started");
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    } finally { store.close(); }
  } finally { await release?.(); }
};
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWechatCli(process.argv.slice(2)).catch(() => {
    // No exception payload: network/SQLite errors may include secret or path data.
    console.error("WeChat command failed; check configuration, ownership confirmation and credentials. No fallback was started.");
    process.exitCode = 1;
  });
}
