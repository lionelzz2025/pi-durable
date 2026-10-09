import assert from "node:assert/strict";
import { test } from "node:test";
import { WechatCdn } from "../../src/wechat-assistant/channel/cdn.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
const options = { query: "secret&url=https://evil.test", signal: AbortSignal.timeout(5_000), maxBytes: 8, timeoutMs: 1000 };
test("CDN uses fixed origin and encoded query; bounded download", async () => {
  const cdn = new WechatCdn(async (url, init) => {
    assert.equal(url.origin, "https://novac2c.cdn.weixin.qq.com");
    assert.equal(url.pathname, "/c2c/download");
    assert.equal(url.searchParams.get("encrypted_query_param"), options.query);
    assert.equal(init.redirect, "error"); return new Response("small");
  });
  assert.equal((await cdn.transfer(options)).bytes?.toString(), "small");
  await assert.rejects(new WechatCdn(async () => new Response("oversized")).transfer(options));
  await assert.rejects(new WechatCdn(async () => new Response(null, { status: 302 })).transfer(options));
});
test("CDN upload validates size before request and requires receipt header", async () => {
  let calls = 0;
  const cdn = new WechatCdn(async (url, init) => {
    calls++; assert.equal(url.pathname, "/c2c/upload"); assert.equal(init.method, "POST");
    return new Response(null, { headers: { "x-encrypted-param": "receipt" } });
  });
  await assert.rejects(cdn.transfer({ ...options, upload: { filekey: "key", encrypted: new Uint8Array(9) } }));
  assert.equal(calls, 0);
  assert.equal((await cdn.transfer({ ...options, upload: { filekey: "key", encrypted: new Uint8Array(8) } })).downloadParam, "receipt");
  await assert.rejects(new WechatCdn(async () => new Response(null)).transfer({ ...options, upload: { filekey: "key", encrypted: new Uint8Array(1) } }));
});
test("media metadata is checked before authentication request and arbitrary upload URL is ignored", async () => {
  const params = { filekey: "key", media_type: 3, to_user_id: "user", rawsize: 1, filesize: 16, rawfilemd5: "a".repeat(32), aeskey: "b".repeat(32) };
  let calls = 0;
  const api = new WechatApi({ transport: async () => { calls++; return Response.json({ ret: 0, upload_param: "param", upload_full_url: "https://evil.test" }); } });
  await assert.rejects(api.getUploadUrl("secret", { ...params, rawsize: -1 }));
  assert.equal(calls, 0);
  assert.deepEqual(await api.getUploadUrl("secret", params), { ret: 0, upload_param: "param" });
});
