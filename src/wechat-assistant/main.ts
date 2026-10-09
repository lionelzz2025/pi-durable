import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadWechatConfig, DEFAULT_CONFIG } from "./config.ts";
import { openCredentialStore } from "./channel/credentials.ts";
import { loginWechat } from "./channel/login.ts";
import { acquireAccountLock } from "./channel/account-lock.ts";
import { WechatApi } from "./channel/api.ts";
import { runPersistentReceiver } from "./receiver.ts";

export const runWechatCli = async (args: string[]): Promise<void> => {
  const [command, ...flags] = args;
  let configPath = DEFAULT_CONFIG; let authorize = false; let exclusive = false; let receiveOnly = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--config" && flags[i + 1]) configPath = flags[++i]!;
    else if (flags[i] === "--allow-wechat") authorize = true;
    else if (flags[i] === "--legacy-stopped") exclusive = true;
    else if (flags[i] === "--receive-only") receiveOnly = true;
    else throw new Error("Unknown or incomplete CLI option");
  }
  if (!["login", "start", "status", "doctor", "backup", "migrate"].includes(command ?? "")) {
    throw new Error("Usage: wechat-assistant <login|start|status|doctor|backup|migrate> [--config ABSOLUTE_PATH]");
  }
  const config = await loadWechatConfig(configPath);
  if (command === "backup" || command === "migrate") {
    throw new Error(`${command} is not available until durable integration is implemented`);
  }
  if (command === "doctor") {
    console.log(JSON.stringify({ config: "valid", runtime: "not-integrated", shell: "disabled", accountOwnership: "requires legacy shutdown confirmation" }));
    return;
  }
  if (command === "start" && !receiveOnly) throw new Error("Agent start is not available yet; explicit --receive-only stores inputs without processing or replies");
  if ((command === "login" || command === "start") && (!authorize || !exclusive)) throw new Error("Connection requires --allow-wechat and --legacy-stopped; stop and disable the legacy plugin first");
  const release = command === "login" ? await acquireAccountLock(config.accountId) : undefined;
  try {
    const store = await openCredentialStore(resolve(config.dataDir, "credentials.sqlite"));
    try {
      const prior = store.load();
      if (prior && (prior.accountId !== config.accountId || prior.userId !== config.boundUserId)) throw new Error("Stored credentials do not match configured identity");
      if (command === "status") {
        console.log(JSON.stringify({ credentials: prior ? "present-not-remotely-validated" : "missing", runtime: "not-integrated" }));
        return;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        if (command === "start") {
          if (!prior) throw new Error("Login credentials required");
          console.log("Receive-only: durable inbox enabled; no model processing or replies");
          await runPersistentReceiver({ config, credentials: prior, legacyStopped: exclusive, signal: controller.signal,
            onState: (state) => { console.log(JSON.stringify({ channel: state, mode: "receive-only" })); } });
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
