#!/usr/bin/env node
// 零依赖 MCP stdio server（换行分隔 JSON-RPC 2.0）。
//
// 传输：stdout 每行一个 JSON-RPC 对象；stdin 逐行读取。日志只走 stderr，绝不污染协议流。
// 支持：initialize / notifications/initialized（及任意通知，不回包）/ ping /
//       tools/list / tools/call / resources/list / resources/read。
//
// fail-closed：数据目录只认 ZCODE_RULES_DATA（或等价的 ZCODE_PLUGIN_DATA）。
// 两者都缺失时，任何工具调用直接返回 JSON-RPC error（-32002），**不猜路径、不落盘**。
//
// 宿主路径：AGENTS.md 默认 os.homedir()/.zcode/AGENTS.md（用户级，F6）；
// 工具接受 agentsPath 覆盖参数（测试用）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  PANEL_RESOURCE_URI,
  defaultAgentsPath,
  exportAgents,
  loadPolicy,
  loadRules,
  pluginRoot,
  renderPanelHtml,
  resolveDataPaths,
  runSelfcheck,
  savePolicy,
  saveRules,
} from "./operations.mjs";

export const SERVER_NAME = "zcode-rules";
export const SERVER_INSTRUCTIONS =
  "zcode-rules 数据面：读写规则/内容策略、导出 AGENTS.md 双哨兵段、运行自检。空规则+空策略=零行为变化。";

const SUPPORTED_PROTOCOL_VERSION = "2024-11-05";
const PANEL_MIME_TYPE = "text/html;profile=mcp-app";

const ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  internal: -32603,
  invalidParams: -32602,
  methodNotFound: -32601,
  notConfigured: -32002,
});

const RULES_INPUT_SCHEMA = {
  type: "object",
  description:
    "规则文件对象：{ version: 1, name, unmatched?, onTimeout?, watchdogMs?, rules: [{ id, tool, decision, commandPattern?, comment? }] }",
  additionalProperties: true,
};

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "rules_read",
    description: "读取 rules.json 中的结构化规则（缺省返回 exists=false，不报错）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rules_write",
    description:
      "校验并写入 rules.json。非法规则拒绝写入（isError），不产生/不覆盖文件；写入的是归一化后的规则。",
    inputSchema: {
      type: "object",
      properties: { rules: RULES_INPUT_SCHEMA },
      required: ["rules"],
      additionalProperties: false,
    },
  },
  {
    name: "content_policy_read",
    description: "读取 content-policy.json 中的自由文本内容策略（缺省为空文本）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "content_policy_write",
    description: "写入自由文本内容策略（空串表示无策略，零行为变化）。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "自由文本内容策略；空串表示无策略" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "export_agents",
    description:
      "把规则与内容策略投影到 AGENTS.md 的两个命名哨兵段（zcode-rules / zcode-content-policy）。缺文件则创建只含两段的文件；返回动作摘要，不返回全文。projectRules=false 时只投影 zcode-content-policy 段，并摘除已有的 zcode-rules 段（hook 判定读 rules.json，不受影响）。",
    inputSchema: {
      type: "object",
      properties: {
        agentsPath: {
          type: "string",
          description: "覆盖 AGENTS.md 路径（默认 os.homedir()/.zcode/AGENTS.md；测试用）",
        },
        projectRules: {
          type: "boolean",
          default: true,
          description:
            "是否把 zcode-rules 段投影进 AGENTS.md（默认 true）。false = 只投影内容策略段，并摘除已有的 zcode-rules 段；此时 rules 参数不读也不校验",
        },
        rules: RULES_INPUT_SCHEMA,
        policy: { type: "string", description: "覆盖内容策略文本；缺省读 dataDir/content-policy.json" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "selfcheck_run",
    description:
      "运行自检：规则合法性 / 内容策略状态 / 两段投影一致性（手改提示）/ AGENTS.md 尺寸 >90KiB 预警 / 版本号 / config 无手工 PermissionRequest 接线。只读。",
    inputSchema: {
      type: "object",
      properties: {
        agentsPath: {
          type: "string",
          description: "覆盖 AGENTS.md 路径（默认 os.homedir()/.zcode/AGENTS.md；测试用）",
        },
        configPath: {
          type: "string",
          description: "覆盖 CLI config 路径（默认 os.homedir()/.zcode/cli/config.json；测试用）",
        },
      },
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** serverInfo.version：优先 manifest，其次 package.json，最后兜底（不读 cwd）。 */
export function readServerVersion() {
  const readJson = (filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  };
  const root = process.env.ZCODE_RULES_ROOT?.trim() || pluginRoot();
  const manifest = readJson(join(root, ".zcode-plugin", "plugin.json"));
  if (typeof manifest?.version === "string" && manifest.version.trim() !== "") {
    return manifest.version.trim();
  }
  const pkg = readJson(join(root, "package.json"));
  return typeof pkg?.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : "0.0.0";
}

/** 运行期上下文：数据目录 + 版本号。数据目录缺失时 dataDir=null（工具调用 fail-closed）。 */
export function createContext(env = process.env) {
  return {
    dataDir: firstNonEmpty(env.ZCODE_RULES_DATA, env.ZCODE_PLUGIN_DATA),
    version: readServerVersion(),
  };
}

function successResponse(id, result) {
  return { id, jsonrpc: "2.0", result };
}

function errorResponse(id, code, message, data) {
  return {
    error: { code, message, ...(data === undefined ? {} : { data }) },
    id: id ?? null,
    jsonrpc: "2.0",
  };
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: Boolean(isError),
  };
}

function assertAllowedArgs(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new RpcError(ERROR_CODES.invalidParams, `未知参数：${key}（允许：${allowed.join(", ") || "<无>"}）`);
    }
  }
}

async function callTool(name, args, context) {
  const paths = resolveDataPaths(context.dataDir);

  switch (name) {
    case "rules_read": {
      const loaded = loadRules(paths.rulesPath);
      return {
        data: {
          errors: loaded.errors,
          exists: loaded.exists,
          ok: loaded.ok,
          path: loaded.path,
          rules: loaded.rules,
          warnings: loaded.warnings,
        },
        isError: !loaded.ok,
      };
    }
    case "rules_write": {
      const result = saveRules(paths.rulesPath, args.rules);
      return { data: result, isError: !result.ok };
    }
    case "content_policy_read": {
      const loaded = loadPolicy(paths.policyPath);
      return {
        data: {
          bytes: loaded.bytes,
          errors: loaded.errors,
          exists: loaded.exists,
          ok: loaded.ok,
          path: loaded.path,
          text: loaded.text,
          warnings: loaded.warnings,
        },
        isError: !loaded.ok,
      };
    }
    case "content_policy_write": {
      const result = savePolicy(paths.policyPath, args.text);
      return { data: result, isError: !result.ok };
    }
    case "export_agents": {
      // T68：projectRules===false 表示「本次不投影规则段」。此时不读、不要求 rules.json ——
      // 它仍然被 hook 直接读取，与本工具无关；再要求一份规则文件属于自相矛盾的摩擦。
      const projectRules = args.projectRules;
      let rules = args.rules;
      if (projectRules !== false && rules === undefined) {
        const loaded = loadRules(paths.rulesPath);
        if (!loaded.ok) {
          return { data: { errors: loaded.errors, ok: false }, isError: true };
        }
        if (!loaded.exists) {
          return {
            data: { errors: ["规则文件不存在：请先 rules_write，或显式传 rules"], ok: false },
            isError: true,
          };
        }
        rules = loaded.rules;
      }
      let policy = args.policy;
      if (policy === undefined) {
        const loadedPolicy = loadPolicy(paths.policyPath);
        if (!loadedPolicy.ok) {
          return { data: { errors: loadedPolicy.errors, ok: false }, isError: true };
        }
        policy = loadedPolicy.text;
      }
      const agentsPath =
        typeof args.agentsPath === "string" && args.agentsPath.trim() !== ""
          ? args.agentsPath
          : defaultAgentsPath();
      const result = exportAgents({
        agentsPath,
        policy,
        rules,
        ...(projectRules === undefined ? {} : { projectRules }),
      });
      return { data: result, isError: !result.ok };
    }
    case "selfcheck_run": {
      const agentsPath =
        typeof args.agentsPath === "string" && args.agentsPath.trim() !== ""
          ? args.agentsPath
          : defaultAgentsPath();
      const configPath =
        typeof args.configPath === "string" && args.configPath.trim() !== ""
          ? args.configPath
          : undefined;
      const result = runSelfcheck({ agentsPath, configPath, dataDir: context.dataDir });
      return { data: result, isError: !result.ok };
    }
    default:
      throw new RpcError(ERROR_CODES.invalidParams, `未知工具：${name}`);
  }
}

function validateToolArguments(name, rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (!isRecord(rawArgs)) {
    throw new RpcError(ERROR_CODES.invalidParams, "tools/call 的 arguments 必须是对象");
  }
  switch (name) {
    case "rules_read":
    case "content_policy_read":
      assertAllowedArgs(rawArgs, []);
      return {};
    case "rules_write":
      assertAllowedArgs(rawArgs, ["rules"]);
      if (!isRecord(rawArgs.rules)) {
        throw new RpcError(ERROR_CODES.invalidParams, "rules_write 需要对象参数 rules");
      }
      return { rules: rawArgs.rules };
    case "content_policy_write":
      assertAllowedArgs(rawArgs, ["text"]);
      if (typeof rawArgs.text !== "string") {
        throw new RpcError(ERROR_CODES.invalidParams, "content_policy_write 需要字符串参数 text");
      }
      return { text: rawArgs.text };
    case "export_agents": {
      assertAllowedArgs(rawArgs, ["agentsPath", "policy", "projectRules", "rules"]);
      if (rawArgs.agentsPath !== undefined && typeof rawArgs.agentsPath !== "string") {
        throw new RpcError(ERROR_CODES.invalidParams, "agentsPath 必须是字符串");
      }
      if (rawArgs.policy !== undefined && typeof rawArgs.policy !== "string") {
        throw new RpcError(ERROR_CODES.invalidParams, "policy 必须是字符串");
      }
      if (rawArgs.projectRules !== undefined && typeof rawArgs.projectRules !== "boolean") {
        throw new RpcError(ERROR_CODES.invalidParams, "projectRules 必须是布尔值");
      }
      if (rawArgs.rules !== undefined && !isRecord(rawArgs.rules)) {
        throw new RpcError(ERROR_CODES.invalidParams, "rules 必须是对象");
      }
      return {
        ...(rawArgs.agentsPath === undefined ? {} : { agentsPath: rawArgs.agentsPath }),
        ...(rawArgs.policy === undefined ? {} : { policy: rawArgs.policy }),
        ...(rawArgs.projectRules === undefined ? {} : { projectRules: rawArgs.projectRules }),
        ...(rawArgs.rules === undefined ? {} : { rules: rawArgs.rules }),
      };
    }
    case "selfcheck_run":
      assertAllowedArgs(rawArgs, ["agentsPath", "configPath"]);
      if (rawArgs.agentsPath !== undefined && typeof rawArgs.agentsPath !== "string") {
        throw new RpcError(ERROR_CODES.invalidParams, "agentsPath 必须是字符串");
      }
      if (rawArgs.configPath !== undefined && typeof rawArgs.configPath !== "string") {
        throw new RpcError(ERROR_CODES.invalidParams, "configPath 必须是字符串");
      }
      return {
        ...(rawArgs.agentsPath === undefined ? {} : { agentsPath: rawArgs.agentsPath }),
        ...(rawArgs.configPath === undefined ? {} : { configPath: rawArgs.configPath }),
      };
    default:
      throw new RpcError(ERROR_CODES.invalidParams, `未知工具：${name}`);
  }
}

async function handleInitialize(params, context) {
  const requested =
    isRecord(params) && typeof params.protocolVersion === "string" && params.protocolVersion.trim() !== ""
      ? params.protocolVersion.trim()
      : SUPPORTED_PROTOCOL_VERSION;
  return {
    capabilities: {
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
    },
    instructions: SERVER_INSTRUCTIONS,
    protocolVersion: requested,
    serverInfo: { name: SERVER_NAME, version: context.version },
  };
}

async function handleToolsCall(params, context) {
  if (!isRecord(params) || typeof params.name !== "string" || params.name.trim() === "") {
    throw new RpcError(ERROR_CODES.invalidParams, "tools/call 需要字符串参数 name");
  }
  const name = params.name.trim();
  if (!TOOL_NAMES.includes(name)) {
    throw new RpcError(ERROR_CODES.invalidParams, `未知工具：${name}`);
  }
  if (!context.dataDir) {
    // fail-closed：不猜目录、不落盘；每个工具调用都明确拒绝。
    throw new RpcError(
      ERROR_CODES.notConfigured,
      "数据目录未配置：请设置 ZCODE_RULES_DATA 或 ZCODE_PLUGIN_DATA（拒绝猜测路径）",
    );
  }
  const args = validateToolArguments(name, params.arguments);
  const { data, isError } = await callTool(name, args, context);
  return toolResult(data, isError);
}

function handleResourcesRead(params) {
  if (!isRecord(params) || typeof params.uri !== "string") {
    throw new RpcError(ERROR_CODES.invalidParams, "resources/read 需要字符串参数 uri");
  }
  if (params.uri !== PANEL_RESOURCE_URI) {
    throw new RpcError(ERROR_CODES.invalidParams, `未知资源：${params.uri}`);
  }
  return {
    contents: [
      {
        mimeType: PANEL_MIME_TYPE,
        text: renderPanelHtml(),
        uri: PANEL_RESOURCE_URI,
      },
    ],
  };
}

/** 处理单条 JSON-RPC 消息；通知返回 null（不回包）。 */
export async function handleMessage(message, context = createContext()) {
  if (!isRecord(message)) {
    return errorResponse(null, ERROR_CODES.invalidRequest, "Invalid Request：消息必须是 JSON 对象");
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(message, "id");
  const id = message.id;
  if (typeof message.method !== "string" || message.method.trim() === "") {
    if (isNotification) return null;
    return errorResponse(id, ERROR_CODES.invalidRequest, "Invalid Request：缺少 method");
  }
  if (isNotification) {
    // notifications/initialized 及一切通知：按 JSON-RPC 2.0 不产生响应。
    return null;
  }
  const method = message.method.trim();
  const params = message.params;
  try {
    switch (method) {
      case "initialize":
        return successResponse(id, await handleInitialize(params, context));
      case "ping":
        return successResponse(id, {});
      case "tools/list":
        return successResponse(id, { tools: TOOL_DEFINITIONS });
      case "tools/call":
        return successResponse(id, await handleToolsCall(params, context));
      case "resources/list":
        return successResponse(id, {
          resources: [
            {
              description: "ZCode 规则面板（静态占位；四屏在 M3 实现）",
              mimeType: PANEL_MIME_TYPE,
              name: "zcode-rules-panel",
              title: "ZCode 规则",
              uri: PANEL_RESOURCE_URI,
            },
          ],
        });
      case "resources/read":
        return successResponse(id, handleResourcesRead(params));
      default:
        return errorResponse(id, ERROR_CODES.methodNotFound, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) {
      return errorResponse(id, error.code, error.message, error.data);
    }
    return errorResponse(
      id,
      ERROR_CODES.internal,
      `内部错误：${String(error?.message ?? error)}`,
    );
  }
}

/** 处理一行输入；空行返回 null，JSON 解析失败返回 -32700。 */
export async function handleLine(line, context = createContext()) {
  const text = String(line ?? "").trim();
  if (text === "") return null;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return errorResponse(
      null,
      ERROR_CODES.parse,
      `Parse error：${String(error?.message ?? error)}`,
    );
  }
  return handleMessage(message, context);
}

export async function main() {
  const context = createContext();
  process.stderr.write(
    `[${SERVER_NAME}] mcp stdio ready · version=${context.version} · ` +
      `dataDir=${context.dataDir ?? "<未配置，工具调用将 fail-closed>"}\n`,
  );
  const rl = createInterface({ crlfDelay: Infinity, input: process.stdin });
  for await (const line of rl) {
    const response = await handleLine(line, context);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
const isMain = entryHref !== "" && entryHref.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
