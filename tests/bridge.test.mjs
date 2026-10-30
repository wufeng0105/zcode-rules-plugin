// src/mcp/bridge.mjs 单测：JSON-RPC 帧序列化 / 解析 / 配对（用假 postMessage target）
//
// 假宿主 = 一个 postMessage 目标 + 一个事件目标：
//   · target.postMessage 收到面板发来的帧 → 记下来，按需回一条响应（模拟宿主 AppBridge）
//   · eventTarget.dispatch 把响应投回桥（模拟 iframe 收到 message 事件）
// 全程零依赖、零网络、不碰真实窗口。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BridgeError,
  BridgeTimeoutError,
  DEFAULT_TIMEOUT_MS,
  INITIALIZE_METHOD,
  INITIALIZED_NOTIFICATION,
  PROTOCOL_VERSION,
  buildNotificationFrame,
  buildRequestFrame,
  buildToolCallParams,
  createBridge,
  isJsonRpcFrame,
  parseFrame,
  readResourceText,
  unwrapToolResult,
} from "../src/mcp/bridge.mjs";

/** 假宿主：记录面板发来的帧，并可主动回包 / 推通知。 */
function fakeHost() {
  const sent = [];
  const listeners = new Set();
  const target = {
    postMessage(message) {
      sent.push(message);
    },
  };
  const eventTarget = {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
  };
  const deliver = (data, source = "host") => {
    for (const listener of listeners) listener({ data, source });
  };
  const reply = (request, result, source = "host") => {
    deliver({ id: request.id, jsonrpc: "2.0", result }, source);
  };
  const replyError = (request, code, message, data, source = "host") => {
    deliver({ error: { code, message, ...(data === undefined ? {} : { data }) }, id: request.id, jsonrpc: "2.0" }, source);
  };
  return {
    deliver,
    eventTarget,
    get listenerCount() {
      return listeners.size;
    },
    reply,
    replyError,
    sent,
    target,
    last() {
      return sent[sent.length - 1];
    },
  };
}

function makeBridge(host = fakeHost(), options = {}) {
  const bridge = createBridge({
    eventTarget: host.eventTarget,
    target: host.target,
    ...options,
  });
  return { bridge, host };
}

/** 让 microtask 走完（回包是异步投递的）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("帧形状：buildRequestFrame 是 { jsonrpc, id, method, params } 四键", () => {
  const frame = buildRequestFrame(7, "tools/call", { arguments: {}, name: "rules_read" });
  assert.deepEqual(Object.keys(frame).sort(), ["id", "jsonrpc", "method", "params"]);
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.id, 7);
  assert.equal(frame.method, "tools/call");
  assert.deepEqual(frame.params, { arguments: {}, name: "rules_read" });
  // JSON 往返后逐字段不变（序列化不丢字段、不串类型）
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), frame);
});

test("帧形状：buildNotificationFrame 没有 id（通知不回包）", () => {
  const frame = buildNotificationFrame("ui/notifications/initialized", {});
  assert.deepEqual(Object.keys(frame).sort(), ["jsonrpc", "method", "params"]);
  assert.equal(Object.prototype.hasOwnProperty.call(frame, "id"), false);
  assert.equal(frame.jsonrpc, "2.0");
});

test("tools/call 参数形状恒为 { name, arguments }（空参数补 {}）", () => {
  assert.deepEqual(buildToolCallParams("rules_read", {}), { arguments: {}, name: "rules_read" });
  assert.deepEqual(buildToolCallParams("content_policy_write", { text: "策略" }), {
    arguments: { text: "策略" },
    name: "content_policy_write",
  });
  assert.deepEqual(buildToolCallParams("rules_read"), { arguments: {}, name: "rules_read" });
  assert.throws(() => buildToolCallParams("", {}), TypeError);
  assert.throws(() => buildToolCallParams("   ", {}), TypeError);
  assert.throws(() => buildToolCallParams(undefined, {}), TypeError);
});

test("parseFrame：响应 / 通知 / 宿主请求 / 非法帧四类分得清", () => {
  assert.equal(parseFrame({ id: 1, jsonrpc: "2.0", result: {} }).kind, "response");
  assert.equal(parseFrame({ error: { code: -1, message: "x" }, id: 2, jsonrpc: "2.0" }).kind, "response");
  assert.equal(parseFrame({ jsonrpc: "2.0", method: "ui/notifications/tool-result" }).kind, "notification");
  assert.equal(parseFrame({ id: 3, jsonrpc: "2.0", method: "tools/list" }).kind, "request");
  // 非法：非 JSON-RPC 2.0 / 既无 method 又无 id / 响应既无 result 又无 error
  assert.equal(parseFrame({ id: 1, result: {} }).kind, "invalid");
  assert.equal(parseFrame({ jsonrpc: "2.0" }).kind, "invalid");
  assert.equal(parseFrame({ id: 4, jsonrpc: "2.0" }).kind, "invalid");
  assert.equal(parseFrame(null).kind, "invalid");
  assert.equal(parseFrame("字符串").kind, "invalid");
  assert.equal(parseFrame([]).kind, "invalid");
  assert.equal(isJsonRpcFrame({ jsonrpc: "2.0" }), true);
  assert.equal(isJsonRpcFrame({ jsonrpc: "1.0" }), false);
});

test("请求 → 回包：id 逐帧递增，回包按 id 配对到正确的 promise", async () => {
  const { bridge, host } = makeBridge();
  const first = bridge.callTool("rules_read", {});
  const second = bridge.callTool("content_policy_read", {});
  assert.equal(host.sent.length, 2);
  assert.equal(host.sent[0].id, 1);
  assert.equal(host.sent[1].id, 2);
  assert.equal(host.sent[0].method, "tools/call");
  assert.deepEqual(host.sent[0].params, { arguments: {}, name: "rules_read" });

  // 乱序回包：先回第二个，再回第一个，各自拿到自己的结果。
  host.reply(host.sent[1], { content: [{ text: '{"who":"policy"}', type: "text" }] });
  host.reply(host.sent[0], { content: [{ text: '{"who":"rules"}', type: "text" }] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(unwrapToolResult(a).data.who, "rules");
  assert.equal(unwrapToolResult(b).data.who, "policy");
  assert.equal(bridge.pendingCount, 0);
  bridge.dispose();
});

test("错误回包 → 抛 BridgeError，带 code 与 data", async () => {
  const { bridge, host } = makeBridge();
  const pendingRequest = bridge.callTool("rules_read", {});
  host.replyError(host.last(), -32002, "数据目录未配置", { hint: "设置 ZCODE_PLUGIN_DATA" });  await assert.rejects(pendingRequest, (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, -32002);
    assert.equal(error.message, "数据目录未配置");
    assert.deepEqual(error.data, { hint: "设置 ZCODE_PLUGIN_DATA" });
    return true;
  });
  assert.equal(bridge.pendingCount, 0);
  bridge.dispose();
});

test("错误回包缺 code/message 时不崩：退化为 -32603 与兜底文案", async () => {
  const { bridge, host } = makeBridge();
  const pendingRequest = bridge.request("tools/list", {});
  host.deliver({ error: {}, id: host.last().id, jsonrpc: "2.0" });
  await assert.rejects(pendingRequest, (error) => {
    assert.equal(error.code, -32603);
    assert.match(error.message, /未知 JSON-RPC 错误/);
    return true;
  });
  bridge.dispose();
});

test("忽略非法帧与非响应帧（不 resolve、不抛、不改 pending）", async () => {
  const { bridge, host } = makeBridge();
  const pendingRequest = bridge.callTool("rules_read", {});
  const id = host.last().id;
  // 非 JSON-RPC / 通知 / 无 result 的响应：都不能把请求提前结算掉。
  host.deliver({ hello: "world" });
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} });
  host.deliver({ id, jsonrpc: "2.0" });
  await flush();
  assert.equal(bridge.pendingCount, 1, "非法帧不得结算请求");
  // 只有合法响应才结算
  host.deliver({ id, jsonrpc: "2.0", result: { ok: true } });
  assert.deepEqual(await pendingRequest, { ok: true });
  bridge.dispose();
});

test("source 过滤：来自其它窗口的消息一律不处理", async () => {
  const { bridge, host } = makeBridge(fakeHost(), { source: "trusted-frame" });
  const pendingRequest = bridge.callTool("rules_read", {});
  host.deliver({ id: host.last().id, jsonrpc: "2.0", result: { spoofed: true } }, "evil-frame");
  await flush();
  assert.equal(bridge.pendingCount, 1, "陌生 source 的响应不得被接受");
  host.deliver({ id: host.last().id, jsonrpc: "2.0", result: { ok: true } }, "trusted-frame");
  assert.deepEqual(await pendingRequest, { ok: true });
  bridge.dispose();
});

test("超时：没有回包时抛 BridgeTimeoutError，并把 pending 清干净", async () => {
  const host = fakeHost();
  const bridge = createBridge({ eventTarget: host.eventTarget, target: host.target, timeoutMs: 20 });
  await assert.rejects(bridge.callTool("rules_read", {}), (error) => {
    assert.ok(error instanceof BridgeTimeoutError);
    assert.equal(error.method, "tools/call");
    assert.equal(error.timeoutMs, 20);
    return true;
  });
  assert.equal(bridge.pendingCount, 0);
  assert.ok(bridge.diagnostics.some((entry) => entry.kind === "timeout"));
  bridge.dispose();
});

test("超时之后迟到的回包被忽略，不产生未处理拒绝", async () => {
  const host = fakeHost();
  const bridge = createBridge({ eventTarget: host.eventTarget, target: host.target, timeoutMs: 20 });
  const pendingRequest = bridge.callTool("rules_read", {});
  const id = host.last().id;
  await assert.rejects(pendingRequest, BridgeTimeoutError);
  host.deliver({ id, jsonrpc: "2.0", result: { late: true } });
  await flush();
  assert.ok(bridge.diagnostics.some((entry) => entry.kind === "unexpected-response" && entry.detail.id === id));
  bridge.dispose();
});

test("initialize：发 ui/initialize，回包后补 ui/notifications/initialized", async () => {
  const { bridge, host } = makeBridge();
  const pendingInit = bridge.initialize({ name: "zcode-rules-panel", version: "0.3.0" });
  const request = host.last();
  assert.equal(request.method, INITIALIZE_METHOD);
  assert.equal(request.params.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(request.params.appInfo, { name: "zcode-rules-panel", version: "0.3.0" });

  host.reply(request, { hostCapabilities: {}, hostInfo: { name: "zcode", version: "1" } });
  const result = await pendingInit;
  assert.equal(result.hostInfo.name, "zcode");
  // 握手完成后必须补一条 initialized 通知（无 id）
  const handshake = host.sent[1];
  assert.equal(host.sent.length, 2);
  assert.equal(handshake.method, INITIALIZED_NOTIFICATION);
  assert.equal(Object.prototype.hasOwnProperty.call(handshake, "id"), false);
  assert.equal(JSON.parse(JSON.stringify(handshake)).jsonrpc, "2.0");
  bridge.dispose();
});

test("initialize：握手失败时不发 initialized 通知（不假装握手成功）", async () => {
  const { bridge, host } = makeBridge();
  const pendingInit = bridge.initialize();
  host.replyError(host.last(), -32601, "Method not found: ui/initialize");
  await assert.rejects(pendingInit, BridgeError);
  assert.equal(host.sent.length, 1, "失败后不得再发 initialized");
  bridge.dispose();
});

test("readResource：uri 进 params.uri；结果按 contents[0].text 取", async () => {
  const { bridge, host } = makeBridge();
  const pendingRead = bridge.readResource("ui://zcode-rules/panel.html");
  assert.deepEqual(host.last().params, { uri: "ui://zcode-rules/panel.html" });
  assert.equal(host.last().method, "resources/read");
  host.reply(host.last(), {
    contents: [{ mimeType: "text/html;profile=mcp-app", text: "<!doctype html>", uri: "ui://zcode-rules/panel.html" }],
  });
  const result = await pendingRead;
  assert.equal(readResourceText(result), "<!doctype html>");
  assert.equal(readResourceText({ contents: [] }), null);
  assert.equal(readResourceText(null), null);
  await assert.rejects(bridge.readResource(""), TypeError);
  bridge.dispose();
});

test("unwrapToolResult：解析 content[0].text 的 JSON，保留 isError", () => {
  const ok = unwrapToolResult({
    content: [{ text: '{"ok":true,"rules":[]}', type: "text" }],
    isError: false,
  });
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.data, { ok: true, rules: [] });

  const bad = unwrapToolResult({ content: [{ text: "不是 JSON", type: "text" }], isError: true });
  assert.equal(bad.isError, true);
  assert.equal(bad.data, null);
  assert.equal(bad.raw, "不是 JSON");

  assert.deepEqual(unwrapToolResult(null), { data: null, isError: false, raw: null });
  assert.deepEqual(unwrapToolResult({}), { data: null, isError: false, raw: null });
});

test("通知分发：订阅者收到宿主推来的通知，退订后不再收到", async () => {
  const { bridge, host } = makeBridge();
  const seen = [];
  const off = bridge.onNotification((frame) => seen.push(frame.method));
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: {} });
  assert.deepEqual(seen, ["ui/notifications/tool-input", "ui/notifications/host-context-changed"]);
  off();
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} });
  assert.equal(seen.length, 2);
  assert.throws(() => bridge.onNotification("不是函数"), TypeError);
  bridge.dispose();
});

test("dispose：解绑监听、作废未完成请求、之后的发送直接拒绝", async () => {
  const { bridge, host } = makeBridge();
  assert.equal(host.listenerCount, 1);
  const pendingRequest = bridge.callTool("rules_read", {});
  bridge.dispose();
  await assert.rejects(pendingRequest, (error) => {
    assert.equal(error.code, -32000);
    assert.match(error.message, /桥已关闭/);
    return true;
  });
  assert.equal(host.listenerCount, 0);
  assert.equal(bridge.closed, true);
  await assert.rejects(bridge.callTool("rules_read", {}), /桥已关闭/);
  // 重复 dispose 幂等
  bridge.dispose();
});

test("targetOrigin 缺省为 '*'，可显式覆盖", async () => {
  const origins = [];
  const target = { postMessage: (message, origin) => origins.push(origin) };

  const defaultHost = fakeHost();
  const bridge = createBridge({ eventTarget: defaultHost.eventTarget, target });
  const pending = bridge.callTool("rules_read", {});
  defaultHost.deliver({ id: 1, jsonrpc: "2.0", result: {} });
  await pending;
  assert.deepEqual(origins, ["*"], "缺省 targetOrigin 必须是 '*'");
  bridge.dispose();

  origins.length = 0;
  const otherHost = fakeHost();
  const bridge2 = createBridge({
    eventTarget: otherHost.eventTarget,
    target,
    targetOrigin: "https://plugin.example",
  });
  const second = bridge2.callTool("rules_read", {});
  otherHost.deliver({ id: 1, jsonrpc: "2.0", result: {} });
  await second;
  assert.deepEqual(origins, ["https://plugin.example"], "显式 targetOrigin 必须原样传给 postMessage");
  bridge2.dispose();
});

test("默认超时常量是正数（面板与单测共享同一兜底）", () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_TIMEOUT_MS >= 5000 && DEFAULT_TIMEOUT_MS <= 60000);
});

test("createBridge 参数校验：缺 postMessage 的 target 直接抛错", () => {
  assert.throws(() => createBridge({}), TypeError);
  assert.throws(() => createBridge({ target: {} }), TypeError);
});

test("并发多请求：每个 id 都拿到自己的结果（不串包）", async () => {
  const { bridge, host } = makeBridge();
  const names = [
    "rules_read",
    "content_policy_read",
    "export_agents",
    "selfcheck_run",
    "rules_write",
    "content_policy_write",
  ];
  const pending = names.map((name) => bridge.callTool(name, { marker: name }));
  assert.equal(host.sent.length, names.length);
  assert.deepEqual(host.sent.map((frame) => frame.params.name), names);
  // 逆序回包
  for (let index = host.sent.length - 1; index >= 0; index -= 1) {
    host.reply(host.sent[index], { content: [{ text: JSON.stringify({ marker: names[index] }), type: "text" }] });
  }
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((result) => unwrapToolResult(result).data.marker),
    names,
  );
  bridge.dispose();
});
