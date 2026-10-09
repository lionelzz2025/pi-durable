import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { openCredentialStore } from "../../src/wechat-assistant/channel/credentials.ts";
import { loginWechat } from "../../src/wechat-assistant/channel/login.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";

const credentials = { token: "test-secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
test("credential DB persists replacement and refuses identity switching without losing original", async () => {
  const path = resolve("data/test-runs", `credentials-${randomUUID()}`, "secrets.sqlite");
  const first = await openCredentialStore(path);
  assert.equal(first.load(), undefined);
  first.save(credentials);
  assert.throws(() => first.save({ ...credentials, accountId: "other" }), /identity change/);
  assert.deepEqual(first.load(), credentials);
  first.save({ ...credentials, token: "new-secret" });
  first.close(); first.close();
  const second = await openCredentialStore(path);
  try { assert.deepEqual(second.load(), { ...credentials, token: "new-secret" }); }
  finally { second.close(); }
});
const confirmed = { status: "confirmed", bot_token: credentials.token, baseurl: credentials.baseUrl,
  ilink_bot_id: credentials.accountId, ilink_user_id: credentials.userId };
const setup = (responses: unknown[]) => {
  const calls: string[] = [];
  const api = new WechatApi({ transport: async (url) => {
    calls.push(url.pathname);
    assert.ok(responses.length, "unexpected request");
    return Response.json(responses.shift());
  } });
  return { api, calls };
};
const options = (api: WechatApi) => ({ api, signal: AbortSignal.timeout(5_000), showQr: (_content: string) => {},
  expectedAccountId: "bot", expectedUserId: "user", pollDelayMs: 1 });
test("QR waits then confirms expected binding, without durable write or model call", async () => {
  const { api, calls } = setup([{ qrcode: "q", qrcode_img_content: "local-qr" }, { status: "wait" }, { status: "scaned" }, confirmed]);
  let display = "";
  assert.deepEqual(await loginWechat({ ...options(api), showQr: (content) => { display = content; } }), credentials);
  assert.equal(display, "local-qr");
  assert.equal(calls.length, 4);
});
test("QR expired, redirected, malformed or wrong binding fail closed", async () => {
  for (const status of [{ status: "expired" }, { status: "scaned_but_redirect", redirect_host: "evil.test" },
    { ...confirmed, ilink_user_id: "foreign" }, { ...confirmed, bot_token: "" }, { ...confirmed, baseurl: "https://evil.test" }]) {
    const { api, calls } = setup([{ qrcode: "q", qrcode_img_content: "qr" }, status]);
    await assert.rejects(loginWechat(options(api)));
    assert.equal(calls.length, 2);
  }
});
test("cancelled login performs no requests", async () => {
  const { api, calls } = setup([]);
  await assert.rejects(loginWechat({ ...options(api), signal: AbortSignal.abort() }));
  assert.equal(calls.length, 0);
});
