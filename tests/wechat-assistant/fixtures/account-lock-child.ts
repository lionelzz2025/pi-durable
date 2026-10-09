import { acquireAccountLock } from "../../../src/wechat-assistant/channel/account-lock.ts";
const [root, account] = process.argv.slice(2);
if (!root || !account) throw Error("Missing args");
const release = await acquireAccountLock(account, root);
console.log("holding");
const timer = setInterval(() => {}, 1000);
process.once("SIGINT", () => { clearInterval(timer); void release(); });
