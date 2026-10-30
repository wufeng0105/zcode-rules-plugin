// 面板侧最小 MCP Apps 桥：JSON-RPC 2.0 over postMessage，零依赖。
//
// 为什么手写而不是打 SDK：插件零运行时依赖（不装包、不联网），面板在沙箱 iframe 内以单文件
// HTML 运行，无法 `import` 本仓库模块；因此 panel.html 内联同一份逻辑，本文件保留**可单测**
// 的实现（tests/bridge.test.mjs 用假 postMessage target 断言帧形状与解析）。
//
// wire 形状（与官方 `@modelcontextprotocol/ext-apps` App 一致，证据见 ZCode 检出）：
//   请求：{ jsonrpc: "2.0", id: <number>, method: <string>, params: <object> }
//   响应：{ jsonrpc: "2.0", id, result }  或  { jsonrpc: "2.0", id, error: { code, message, data? } }
//   通知：{ jsonrpc: "2.0", method: <string>, params: <object> }（无 id，不回包）
//
// 三个操作：
//   initialize()      → 发 `ui/initialize`，回包后补一条 `ui/notifications/initialized`
//                       （方法名带 `ui/` 前缀：这是 MCP Apps 的握手方法，宿主 AppBridge 只认它；
//                        ZCode 宿主在 packages/ui/src/plugin-ui/app/pluginUiHostController.ts 里
//                        用官方 AppBridge 处理该方法，官方 pdf 面板 0.2.2 的打包产物同样发 `ui/initialize`）
//   callTool(name, a) → 发 `tools/call`，params = { name, arguments }
//   readResource(uri) → 发 `resources/read`，params = { uri }
//
// 只做「发帧 / 收帧 / 对 id」：不缓存业务、不猜数据目录、不重试。超时与错误交给调用方显示。

/** 面板声明的 MCP Apps 协议版本（与宿主打包的 ext-apps 2.0.0 常量同值）。 */
export const PROTOCOL_VERSION = "2026-01-26";
/** 握手方法（MCP Apps；不是 MCP 协议本身的 `initialize`）。 */
export const INITIALIZE_METHOD = "ui/initialize";
/** 握手完成通知（无 id，不回包）。 */
export const INITIALIZED_NOTIFICATION = "ui/notifications/initialized";
export const TOOLS_CALL_METHOD = "tools/call";
export const RESOURCES_READ_METHOD = "resources/read";
/** 默认请求超时（毫秒）：自检要读几个小文件，20s 足够；超时只报错，不重发。 */
export const DEFAULT_TIMEOUT_MS = 20000;

/** JSON-RPC 层错误（回包带 `error` 时抛这个）。 */
export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** 回包超时（只表示「这个 id 没等到回包」）。 */
export class BridgeTimeoutError extends Error {
  constructor(method, id, timeoutMs) {
    super(`${method} 在 ${timeoutMs}ms 内没有回包（id=${id}）`);
    this.name = "BridgeTimeoutError";
    this.id = id;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 是 JSON-RPC 2.0 帧（其它消息一律丢弃，不抛错）。 */
export function isJsonRpcFrame(data) {
  return isRecord(data) && data.jsonrpc === "2.0";
}

/**
 * 解析一条收件消息。
 * 返回 `{ kind: "response", frame }` / `{ kind: "notification", frame }` /
 *      `{ kind: "request", frame }`（宿主/服务器发起的请求，本客户端不处理） /
 *      `{ kind: "invalid", reason }`。
 */
export function parseFrame(data) {
  if (!isJsonRpcFrame(data)) return { kind: "invalid", reason: "不是 JSON-RPC 2.0 帧" };
  const hasId = Object.prototype.hasOwnProperty.call(data, "id");
  const hasMethod = typeof data.method === "string" && data.method !== "";
  if (hasMethod && hasId) return { kind: "request", frame: data };
  if (hasMethod) return { kind: "notification", frame: data };
  if (!hasId) return { kind: "invalid", reason: "既没有 method 也没有 id" };
  if (!Object.prototype.hasOwnProperty.call(data, "result") && !isRecord(data.error)) {
    return { kind: "invalid", reason: "响应既没有 result 也没有 error" };
  }
  return { kind: "response", frame: data };
}

/** 组一帧请求（导出便于单测直接断言帧形状）。 */
export function buildRequestFrame(id, method, params) {
  return { id, jsonrpc: "2.0", method, params: params ?? {} };
}

/** 组一帧通知。 */
export function buildNotificationFrame(method, params) {
  return { jsonrpc: "2.0", method, params: params ?? {} };
}

/** `tools/call` 的参数形状（页面只能选工具名与参数，不能选连接/会话）。 */
export function buildToolCallParams(name, args) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("callTool 需要非空工具名");
  }
  return { arguments: args ?? {}, name };
}

/**
 * 把 `tools/call` 的结果拆成结构化数据。
 * 本插件的工具统一回 `content[0].text` = JSON，因此这里解析它；解析失败返回原始文本。
 */
export function unwrapToolResult(result) {
  if (!isRecord(result)) return { isError: false, data: null, raw: null };
  const isError = result.isError === true;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isRecord(first) && typeof first.text === "string" ? first.text : null;
  if (text === null) return { isError, data: null, raw: null };
  try {
    return { isError, data: JSON.parse(text), raw: text };
  } catch {
    return { isError, data: null, raw: text };
  }
}

/** 从 `resources/read` 结果里取第一项文本。 */
export function readResourceText(result) {
  if (!isRecord(result) || !Array.isArray(result.contents)) return null;
  const first = result.contents[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : null;
}

/**
 * 建一个 postMessage 桥。
 *
 * @param {object} options
 * @param {{ postMessage(message: unknown, targetOrigin?: string): void }} options.target 发送目标（面板里是 window.parent）
 * @param {object} [options.eventTarget] 收件窗口（有 addEventListener/removeEventListener；缺省 globalThis）
 * @param {object|null} [options.source] 只接受该 source 的消息（缺省不过滤）
 * @param {string} [options.targetOrigin] 缺省 "*"（宿主 relay 自己校验 origin）
 * @param {number} [options.timeoutMs] 单请求超时
 */
export function createBridge(options = {}) {
  const target = options.target;
  if (!target || typeof target.postMessage !== "function") {
    throw new TypeError("createBridge 需要带 postMessage 的 target");
  }
  const eventTarget = options.eventTarget ?? globalThis;
  const source = options.source ?? null;
  const targetOrigin = options.targetOrigin ?? "*";
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const pending = new Map();
  const notificationListeners = new Set();
  const diagnostics = [];
  let seq = 0;
  let closed = false;

  const record = (kind, detail) => {
    diagnostics.push({ at: now(), detail, kind });
    // 诊断只留在内存里给面板展示，不写盘、不 postMessage。
    if (diagnostics.length > 200) diagnostics.shift();
  };

  function settle(frame) {
    const entry = pending.get(frame.id);
    if (!entry) {
      record("unexpected-response", { id: frame.id });
      return;
    }
    pending.delete(frame.id);
    entry.clear();
    if (isRecord(frame.error)) {
      entry.reject(
        new BridgeError(
          typeof frame.error.code === "number" ? frame.error.code : -32603,
          typeof frame.error.message === "string" ? frame.error.message : "未知 JSON-RPC 错误",
          frame.error.data,
        ),
      );
      return;
    }
    entry.resolve(frame.result);
  }

  function onMessage(event) {
    if (closed || !isRecord(event)) return;
    if (source && event.source !== source) return;
    const parsed = parseFrame(event.data);
    if (parsed.kind === "response") {
      settle(parsed.frame);
      return;
    }
    if (parsed.kind === "notification") {
      for (const listener of notificationListeners) listener(parsed.frame);
      return;
    }
    // `request`（宿主反向请求）本客户端不实现：明确记录，不假装回应。
    record(parsed.kind, parsed.kind === "request" ? parsed.frame.method : parsed.reason);
  }

  if (typeof eventTarget.addEventListener === "function") {
    eventTarget.addEventListener("message", onMessage);
  }

  function send(frame) {
    if (closed) throw new Error("桥已关闭");
    target.postMessage(frame, targetOrigin);
    return frame;
  }

  function request(method, params = {}, options2 = {}) {
    if (typeof method !== "string" || method.trim() === "") {
      return Promise.reject(new TypeError("request 需要非空 method"));
    }
    const perCall = Number.isFinite(options2.timeoutMs) ? options2.timeoutMs : timeoutMs;
    const id = ++seq;
    const frame = buildRequestFrame(id, method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        record("timeout", { id, method });
        reject(new BridgeTimeoutError(method, id, perCall));
      }, perCall);
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, {
        clear: () => clearTimeout(timer),
        method,
        reject,
        resolve,
      });
      try {
        send(frame);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function notify(method, params = {}) {
    return send(buildNotificationFrame(method, params));
  }

  /** 握手：`ui/initialize` → `ui/notifications/initialized`。结果回包里的 hostContext 供状态屏展示。 */
  async function initialize(appInfo = { name: "zcode-rules-panel", version: "0.0.0" }, options2 = {}) {
    const result = await request(INITIALIZE_METHOD, {
      appCapabilities: options2.appCapabilities ?? {},
      appInfo,
      protocolVersion: options2.protocolVersion ?? PROTOCOL_VERSION,
    });
    notify(INITIALIZED_NOTIFICATION, {});
    return result;
  }

  function callTool(name, args) {
    const params = buildToolCallParams(name, args);
    return request(TOOLS_CALL_METHOD, params);
  }

  function readResource(uri) {
    if (typeof uri !== "string" || uri.trim() === "") {
      return Promise.reject(new TypeError("readResource 需要非空 uri"));
    }
    return request(RESOURCES_READ_METHOD, { uri });
  }

  function onNotification(listener) {
    if (typeof listener !== "function") throw new TypeError("onNotification 需要函数");
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function dispose() {
    if (closed) return;
    closed = true;
    if (typeof eventTarget.removeEventListener === "function") {
      eventTarget.removeEventListener("message", onMessage);
    }
    for (const entry of pending.values()) {
      entry.clear();
      entry.reject(new BridgeError(-32000, "桥已关闭，未完成的请求作废"));
    }
    pending.clear();
    notificationListeners.clear();
  }

  return {
    callTool,
    dispose,
    get diagnostics() {
      return diagnostics.slice();
    },
    get closed() {
      return closed;
    },
    get pendingCount() {
      return pending.size;
    },
    initialize,
    notify,
    onNotification,
    readResource,
    request,
  };
}
