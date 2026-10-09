import assert from "node:assert/strict";
import { test } from "node:test";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
import { SendOutcomeUnknown } from "../../src/wechat-assistant/outbox.ts";
import { senderFromApi } from "../../src/wechat-assistant/sender.ts";

const chunk = { userId: "user", contextToken: "ctx", clientId: "cid", text: "hi" };

test("a network failure is an unknown outcome; an HTTP failure is a definite one", async () => {
  const network = new WechatApi({ transport: async () => { throw new Error("socket closed"); } });
  await assert.rejects(senderFromApi(network, "token")(chunk), SendOutcomeUnknown);
  const http = new WechatApi({ transport: async () => new Response("{}", { status: 500 }) });
  await assert.rejects(senderFromApi(http, "token")(chunk), (error: unknown) => !(error instanceof SendOutcomeUnknown));
});

test("a successful send posts the caller-owned client id and recipient", async () => {
  let body = "";
  let url = "";
  const api = new WechatApi({
    transport: async (requestUrl, init) => {
      url = String(requestUrl);
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await senderFromApi(api, "token")(chunk);
  assert.ok(url.endsWith("/ilink/bot/sendmessage"));
  const sent = JSON.parse(body) as { msg: { to_user_id: string; client_id: string; context_token: string; item_list: Array<{ text_item: { text: string } }> } };
  assert.equal(sent.msg.to_user_id, "user");
  assert.equal(sent.msg.client_id, "cid");
  assert.equal(sent.msg.context_token, "ctx");
  assert.equal(sent.msg.item_list[0]?.text_item.text, "hi");
});
