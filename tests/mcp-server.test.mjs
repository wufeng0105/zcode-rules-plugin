// MCP stdio server（src/mcp/server.mjs）协议往返单测
//
// 黑盒方式：spawn 子进程 → 换行分隔 JSON-RPC 2.0 → initialize / tools/list /
// tools/call / resources/list / resources/read → 关闭。数据目录全部在 os.tmpdir()。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { SECTION_NAMES, locateNamedSection } from "../src/rules/sections.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(REPO_ROOT, "src", "mcp", "server.mjs");
const PANEL_PATH = join(REPO_ROOT, "ui", "panel.html");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

const TOOL_NAMES = [
  "rules_read",
  "rules_write",
  "content_policy_read",
  "content_policy_write",
  "export_agents",
  "selfcheck_run",
];

const TOOL_MINIMAL_ARGS = {
  content_policy_read: {},
  content_policy_write: { text: "策略" },
  export_agents: {},
  rules_read: {},
  rules_write: {
    rules: { name: "最小规则", rules: [], version: 1 },
  },
  selfcheck_run: {},
};

const RULES_FIXTURE = {
  version: 1,
  name: "MCP 规则",
  unmatched: "abstain",
  rules: [
    { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
  ],
};

const KEPT_DIRS = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-mcp-"));
  KEPT_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of KEPT_DIRS) rmSync(dir, { force: true, recursive: true });
});

function createSession({ dataDir } = {}) {
  const env = { ...process.env };
  delete env.ZCODE_RULES_DATA;
  delete env.ZCODE_PLUGIN_DATA;
  delete env.ZCODE_RULES_ROOT;
  if (dataDir) env.ZCODE_RULES_DATA = dataDir;

  const child = spawn(process.execPath, [SERVER_PATH], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const rl = createInterface({ crlfDelay: Infinity, input: child.stdout });
  const queue = [];
  let waiter = null;
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "") return;
    queue.push(JSON.parse(text));
    if (waiter) {
      const notify = waiter;
      waiter = null;
      notify();
    }
  });

  let seq = 0;
  const session = {
    get pending() {
      return queue.length;
    },
    get stderr() {
      return stderrChunks.join("");
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(text) {
      child.stdin.write(`${text}\n`);
    },
    async next(timeoutMs = 8000) {
      if (queue.length > 0) return queue.shift();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(
            new Error(
              `等待 MCP 响应超时；stderr=${stderrChunks.join("").slice(-400) || "<empty>"}`,
            ),
          );
        }, timeoutMs);
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      return queue.shift();
    },
    async request(method, params, { timeoutMs = 8000 } = {}) {
      const id = ++seq;
      session.send({
        id,
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      });
      const response = await session.next(timeoutMs);
      assert.equal(response.id, id, `响应 id 应回显（method=${method}）`);
      return response;
    },
    async close() {
      try {
        child.stdin.end();
      } catch {
        /* 已关闭 */
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", resolve);
      });
    },
  };
  return session;
}

async function withSession(fn, options) {
  const session = createSession(options);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

function toolPayload(response) {
  assert.ok(response.result, `expected result, got ${JSON.stringify(response)}`);
  assert.equal(response.result.content[0].type, "text");
  return JSON.parse(response.result.content[0].text);
}

test("initialize：回显协议版本，声明 tools/resources 能力与 serverInfo", async () => {
  await withSession(async (session) => {
    const response = await session.request("initialize", {
      capabilities: {},
      clientInfo: { name: "zcode-rules-test", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.result.protocolVersion, "2025-06-18");
    assert.equal(response.result.serverInfo.name, "zcode-rules");
    assert.equal(response.result.serverInfo.version, PKG.version);
    assert.equal(typeof response.result.capabilities.tools, "object");
    assert.equal(typeof response.result.capabilities.resources, "object");
  });
});

test("notifications/initialized 不回包；随后 ping 正常", async () => {
  await withSession(async (session) => {
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    session.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(session.pending, 0, "通知不得产生任何响应");

    const ping = await session.request("ping");
    assert.deepEqual(ping.result, {});
  });
});

test("tools/list：暴露 6 个工具，schema 均为 object", async () => {
  await withSession(async (session) => {
    const response = await session.request("tools/list");
    const tools = response.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    }
  });
});

test("tools/call rules_write → rules_read 往返，文件按归一化落盘", async () => {
  const dataDir = tempDir();
  await withSession(
    async (session) => {
      const write = await session.request("tools/call", {
        arguments: { rules: RULES_FIXTURE },
        name: "rules_write",
      });
      assert.equal(write.result.isError, false);
      const written = toolPayload(write);
      assert.equal(written.ok, true);
      assert.equal(written.written, true);
      assert.equal(written.ruleCount, 1);
      assert.ok(existsSync(join(dataDir, "rules.json")));

      const read = await session.request("tools/call", { arguments: {}, name: "rules_read" });
      const readPayload = toolPayload(read);
      assert.equal(readPayload.ok, true);
      assert.equal(readPayload.exists, true);
      assert.equal(readPayload.rules.name, "MCP 规则");
      assert.equal(readPayload.rules.rules.length, 1);
    },
    { dataDir },
  );
});

test("tools/call rules_write 非法规则：isError 且不落盘", async () => {
  const dataDir = tempDir();
  await withSession(
    async (session) => {
      const response = await session.request("tools/call", {
        arguments: { rules: { name: "坏规则", rules: [{ decision: "maybe", id: "x", tool: "" }], version: 1 } },
        name: "rules_write",
      });
      assert.equal(response.result.isError, true);
      const payload = toolPayload(response);
      assert.equal(payload.ok, false);
      assert.ok(payload.errors.length > 0);
      assert.equal(existsSync(join(dataDir, "rules.json")), false);
    },
    { dataDir },
  );
});

test("tools/call content_policy_write / read 往返", async () => {
  const dataDir = tempDir();
  await withSession(
    async (session) => {
      const write = await session.request("tools/call", {
        arguments: { text: "策略：不要把密钥写进日志。" },
        name: "content_policy_write",
      });
      assert.equal(write.result.isError, false);
      assert.equal(toolPayload(write).written, true);

      const read = await session.request("tools/call", {
        arguments: {},
        name: "content_policy_read",
      });
      const payload = toolPayload(read);
      assert.equal(payload.ok, true);
      assert.equal(payload.exists, true);
      assert.equal(payload.text, "策略：不要把密钥写进日志。");
    },
    { dataDir },
  );
});

test("tools/call export_agents：缺省读数据目录，生成双哨兵 AGENTS.md", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  await withSession(
    async (session) => {
      await session.request("tools/call", {
        arguments: { rules: RULES_FIXTURE },
        name: "rules_write",
      });
      await session.request("tools/call", {
        arguments: { text: "策略：保持克制。" },
        name: "content_policy_write",
      });
      const response = await session.request("tools/call", {
        arguments: { agentsPath },
        name: "export_agents",
      });
      assert.equal(response.result.isError, false);
      const payload = toolPayload(response);
      assert.equal(payload.ok, true);
      assert.equal(payload.created, true);
      assert.deepEqual(payload.actions, { policy: "appended", rules: "appended" });
      assert.ok(typeof payload.sha256 === "string" && payload.sha256.length === 64);

      const text = readFileSync(agentsPath, "utf8");
      assert.ok(locateNamedSection(text, SECTION_NAMES.RULES));
      assert.ok(locateNamedSection(text, SECTION_NAMES.CONTENT_POLICY));
      assert.ok(text.includes("策略：保持克制。"));
    },
    { dataDir },
  );
});

test("tools/call export_agents projectRules:false：不要求 rules.json，只写内容策略段", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  await withSession(
    async (session) => {
      // 前提：数据目录里**没有** rules.json。projectRules:false 表示"本次不投影规则段"，
      // 因此工具不该再要求一份它根本不用的规则文件。
      assert.equal(existsSync(join(dataDir, "rules.json")), false);

      const response = await session.request("tools/call", {
        arguments: { agentsPath, policy: "策略：只投影这一段。", projectRules: false },
        name: "export_agents",
      });
      assert.equal(response.result.isError, false);
      const payload = toolPayload(response);
      assert.equal(payload.ok, true);
      assert.equal(payload.projectRules, false);
      assert.equal(payload.actions.rules, "absent");
      assert.equal(payload.sections.rules.present, false);

      const text = readFileSync(agentsPath, "utf8");
      assert.ok(text.includes("BEGIN zcode-content-policy"));
      assert.ok(text.includes("策略：只投影这一段。"));
      assert.equal(text.includes("BEGIN zcode-rules"), false);
    },
    { dataDir },
  );
});

test("tools/call export_agents：projectRules 非布尔 → -32602，且不落盘", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  await withSession(
    async (session) => {
      const response = await session.request("tools/call", {
        arguments: { agentsPath, policy: "策略", projectRules: "no" },
        name: "export_agents",
      });
      assert.ok(response.error, "非布尔 projectRules 必须以 JSON-RPC error 拒绝");
      assert.equal(response.error.code, -32602);
      assert.match(response.error.message, /projectRules/);
      assert.equal(existsSync(agentsPath), false, "参数非法时不得创建文件");
    },
    { dataDir },
  );
});

test("resources/list + resources/read：返回 ui/panel.html 原文", async () => {
  await withSession(async (session) => {
    const list = await session.request("resources/list");
    const [resource] = list.result.resources;
    assert.equal(resource.uri, "ui://zcode-rules/panel.html");
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");

    const read = await session.request("resources/read", {
      uri: "ui://zcode-rules/panel.html",
    });
    const [content] = read.result.contents;
    assert.equal(content.uri, "ui://zcode-rules/panel.html");
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.equal(content.text, readFileSync(PANEL_PATH, "utf8"));
  });
});

test("tools/call selfcheck_run：返回 checks 与 summary", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  await withSession(
    async (session) => {
      await session.request("tools/call", {
        arguments: { rules: RULES_FIXTURE },
        name: "rules_write",
      });
      await session.request("tools/call", {
        arguments: { agentsPath, rules: RULES_FIXTURE, policy: "" },
        name: "export_agents",
      });
      const response = await session.request("tools/call", {
        arguments: { agentsPath, configPath: join(dataDir, "cli-config.json") },
        name: "selfcheck_run",
      });
      assert.equal(response.result.isError, false);
      const payload = toolPayload(response);
      assert.equal(payload.ok, true);
      assert.ok(Array.isArray(payload.checks) && payload.checks.length > 0);
      assert.equal(payload.summary.rulesCount, 1);
      assert.equal(payload.summary.errors, 0);
    },
    { dataDir },
  );
});

test("未知方法返回 -32601；非法 JSON 返回 -32700", async () => {
  await withSession(async (session) => {
    const response = await session.request("does/not/exist");
    assert.equal(response.error.code, -32601);

    session.sendRaw("{ 这不是 JSON");
    const parseError = await session.next();
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null);
  });
});

test("数据目录缺失：每个工具调用都返回 -32002（fail-closed，不猜路径）", async () => {
  await withSession(async (session) => {
    for (const name of TOOL_NAMES) {
      const response = await session.request("tools/call", {
        arguments: TOOL_MINIMAL_ARGS[name],
        name,
      });
      assert.ok(response.error, `${name} 应当返回 JSON-RPC error`);
      assert.equal(response.error.code, -32002, `${name} 应以 -32002 拒绝`);
      assert.match(response.error.message, /ZCODE_RULES_DATA|ZCODE_PLUGIN_DATA/);
    }
    // 面板是静态资源，不依赖数据目录，仍可读取。
    const read = await session.request("resources/read", {
      uri: "ui://zcode-rules/panel.html",
    });
    assert.equal(read.result.contents[0].uri, "ui://zcode-rules/panel.html");
  });
});

test("ping：返回空结果对象", async () => {
  await withSession(async (session) => {
    const response = await session.request("ping");
    assert.deepEqual(response.result, {});
    assert.equal(response.jsonrpc, "2.0");
  });
});
