import assert from "node:assert/strict";
import { test } from "node:test";
import { ILINK_ORIGIN, ProtocolError, WechatApi, isSessionExpired, validateOrigin } from "../../src/wechat-assistant/channel/api.ts";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("protocol rejects foreign origins and redirects before exposing credentials", async () => {
  for (const url of ["http://ilinkai.weixin.qq.com", "https://evil.test", `${ILINK_ORIGIN}/other`, `${ILINK_ORIGIN}?x=1`, "https://user:secret@ilinkai.weixin.qq.com"]) assert.throws(() => validateOrigin(url));
  const api = new WechatApi({ transport: async () => new Response(null, { status: 302 }) });
  await assert.rejects(api.getUpdates("secret", ""), ProtocolError);
});

test("poll forwards caller cursor without persistence, with cancellation and fixed origin", async () => {
  let calls = 0;
  const api = new WechatApi({ transport: async (url, init) => {
    calls++;
    assert.equal(url.origin, ILINK_ORIGIN);
    assert.equal(url.pathname, "/ilink/bot/getupdates");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret");
    assert.deepEqual(JSON.parse(String(init.body)), { get_updates_buf: "durable-cursor", base_info: { channel_version: "1.0.0" } });
    return response({ ret: 0, msgs: [], get_updates_buf: "next" });
  } });
  assert.equal((await api.getUpdates("secret", "durable-cursor")).get_updates_buf, "next");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.getUpdates("secret", "", controller.signal));
  assert.equal(calls, 1);
});

test("send preserves caller-owned client ID and never retries ambiguous network outcome", async () => {
  const ids: string[] = [];
  const api = new WechatApi({ transport: async (_url, init) => {
    const body = JSON.parse(String(init.body)); ids.push(body.msg.client_id);
    assert.equal(body.msg.to_user_id, "bound-user");
    assert.equal(body.msg.context_token, "context");
    return response({ ret: 0 });
  } });
  await api.sendMessage("secret", "bound-user", "context", "stable-outbox-key", [{ type: 1, text_item: { text: "hello" } }]);
  assert.deepEqual(ids, ["stable-outbox-key"]);
  await assert.rejects(api.sendMessage("secret", "", "context", "id", []));
  let attempts = 0;
  const failing = new WechatApi({ transport: async () => { attempts++; throw Error("token=secret-private"); } });
  await assert.rejects(failing.sendMessage("secret", "user", "context", "id", [{ type: 1 }]), (error: unknown) => {
    assert.ok(error instanceof ProtocolError); assert.equal(error.kind, "network");
    assert.doesNotMatch(String(error), /secret-private/); return true;
  });
  assert.equal(attempts, 1);
});

test("API errors redact payload and classify session expiry including errcode-only", async () => {
  const api = new WechatApi({ transport: async () => response({ errcode: -14, errmsg: "credential secret", token: "private" }) });
  await assert.rejects(api.getUpdates("secret", ""), (error: unknown) => {
    assert.ok(isSessionExpired(error)); assert.doesNotMatch(JSON.stringify(error) + String(error), /private|credential secret/); return true;
  });
});

test("bounded response parser rejects oversized/malformed bodies and invalid poll shapes", async () => {
  for (const body of ["not-json", "[]", JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 3 })]) {
    const api = new WechatApi({ transport: async () => new Response(body) });
    await assert.rejects(api.getUpdates("secret", ""), ProtocolError);
  }
  const api = new WechatApi({ maxResponseBytes: 10, transport: async () => response({ huge: "x".repeat(100) }) });
  await assert.rejects(api.fetchQrCode(), ProtocolError);
});

test("QR requests are cancellable, unauthenticated and query-encoded", async () => {
  const api = new WechatApi({ transport: async (url, init) => {
    assert.equal((init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(init.method, "GET"); assert.ok(init.signal);
    if (url.pathname.endsWith("get_bot_qrcode")) return response({ qrcode: "a&b", qrcode_img_content: "local-qr" });
    assert.equal(url.searchParams.get("qrcode"), "a&b");
    return response({ status: "wait" });
  } });
  assert.equal((await api.fetchQrCode()).qrcode, "a&b");
  assert.equal((await api.getQrCodeStatus("a&b")).status, "wait");
});
