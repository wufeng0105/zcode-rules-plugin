// v0.4.3：投影模式（projectRules）的**产品配置通道**回归
//
// 架构：这个开关不归插件所有。链路是
//   manifest.userConfig.projectRules（产品详情页「配置」的原生开关）
//     → config.json 的 plugins.options["<pluginId>"]
//     → 产品按 manifest 里 `${user_config.projectRules}` 注入本进程 env
//     → server.mjs 解析成 boolean（resolveProjectRules）→ 显式传给纯函数。
//
// 所以这里刻意分成三层测：
//   1) manifest 声明与接线（静态，防两份清单/变量名漂移）；
//   2) env 解析（纯函数，边界值）；
//   3) 经 MCP 工具的真实行为（不传参数时用配置；显式参数可一次性覆盖）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  createContext,
  handleMessage,
  resolveProjectRules,
} from "../src/mcp/server.mjs";
import { runSelfcheck } from "../src/mcp/operations.mjs";
import { SECTION_NAMES, locateNamedSection } from "../src/rules/sections.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, ".zcode-plugin", "plugin.json"), "utf8"));
const KEPT = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-projection-"));
  KEPT.push(dir);
  return dir;
}
after(() => {
  for (const dir of KEPT) rmSync(dir, { force: true, recursive: true });
});

const RULES = {
  version: 1,
  name: "投影模式测试规则",
  unmatched: "abstain",
  rules: [{ id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf" }],
};

async function callTool(context, name, args) {
  const response = await handleMessage(
    { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } },
    context,
  );
  assert.ok(response?.result, `tool 调用应有 result：${JSON.stringify(response)}`);
  return JSON.parse(response.result.content[0].text);
}

test("manifest：声明「投影规则段」为产品原生布尔开关，默认 true", () => {
  const option = MANIFEST.userConfig?.projectRules;
  assert.ok(option, "userConfig 必须声明 projectRules（否则详情页没有开关、${user_config.projectRules} 也会报缺失）");
  assert.equal(option.type, "boolean");
  assert.equal(option.default, true, "默认必须 true：升级不改变既有行为");
  assert.ok(typeof option.title === "string" && option.title.length > 0, "开关必须有标题");
  assert.match(option.description, /hook/, "描述必须说清 hook 不受影响");
  assert.match(option.description, /重启/, "描述必须说清改完要重启才生效");
});

test("manifest：MCP server 的 env 用 ${user_config.projectRules} 接线（防变量名漂移）", () => {
  const env = MANIFEST.mcpServers?.["zcode-rules"]?.env ?? {};
  assert.equal(
    env.ZCODE_RULES_PROJECT_RULES,
    "${user_config.projectRules}",
    "env 必须引用 userConfig 的 projectRules —— 否则开关不生效",
  );
  // 既有两项不能被改坏
  assert.equal(env.ZCODE_RULES_DATA, "${ZCODE_PLUGIN_DATA}");
  assert.equal(env.ZCODE_RULES_ROOT, "${ZCODE_PLUGIN_ROOT}");
});

test("resolveProjectRules：只有明确 false 才关闭，其余（含缺省/未展开）一律 true", () => {
  assert.equal(resolveProjectRules({}), true, "env 缺省 = true（与 0.4.2 行为一致）");
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: "true" }), true);
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: "false" }), false);
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: " FALSE " }), false, "大小写/空白容忍");
  // 旧版产品不认 ${user_config.*} 时会把模板原样传下来 —— 必须退化成 true（安全侧）
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: "${user_config.projectRules}" }), true);
  // 非 false 的其它取值不猜语义
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: "0" }), true);
  assert.equal(resolveProjectRules({ ZCODE_RULES_PROJECT_RULES: "off" }), true);
});

test("createContext：把产品注入值解析成 projectRules，并带进上下文", () => {
  const dir = tempDir();
  const off = createContext({ ZCODE_RULES_DATA: dir, ZCODE_RULES_PROJECT_RULES: "false" });
  assert.equal(off.projectRules, false);
  assert.equal(off.dataDir, dir);
  const on = createContext({ ZCODE_RULES_DATA: dir });
  assert.equal(on.projectRules, true);
});

test("MCP：不传 projectRules 时按配置关 → 只投影内容策略段（且不要求 rules.json）", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  writeFileSync(join(dataDir, "content-policy.json"), JSON.stringify({ version: 1, text: "只看策略。" }), "utf8");
  const context = createContext({ ZCODE_RULES_DATA: dataDir, ZCODE_RULES_PROJECT_RULES: "false" });

  const payload = await callTool(context, "export_agents", { agentsPath });
  assert.equal(payload.ok, true);
  assert.equal(payload.projectRules, false, "返回值必须回显生效模式");
  assert.equal(payload.actions.rules, "absent");

  const text = readFileSync(agentsPath, "utf8");
  assert.ok(text.includes("<!-- BEGIN zcode-content-policy"));
  assert.equal(text.includes("<!-- BEGIN zcode-rules"), false);
});

test("MCP：显式参数可一次性覆盖配置（不落盘、不改配置）", async () => {
  const dataDir = tempDir();
  const agentsPath = join(dataDir, "AGENTS.md");
  const context = createContext({ ZCODE_RULES_DATA: dataDir, ZCODE_RULES_PROJECT_RULES: "false" });

  // 配置是关的，但显式传 true → 本次照常投影（rules 由调用方给）
  const payload = await callTool(context, "export_agents", {
    agentsPath,
    policy: "策略",
    projectRules: true,
    rules: RULES,
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.projectRules, true);
  assert.ok(locateNamedSection(readFileSync(agentsPath, "utf8"), SECTION_NAMES.RULES), "显式 true 应投影规则段");
  // 上下文里的配置值不因这次覆盖而改变
  assert.equal(context.projectRules, false);
});

test("自检：配置关闭时「没有规则段」是 info（不是 warn），并报出模式", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# 用户正文\n", "utf8");
  writeFileSync(join(dir, "rules.json"), JSON.stringify(RULES), "utf8");

  const off = runSelfcheck({ agentsPath, configPath: join(dir, "config.json"), dataDir: dir, projectRules: false });
  const offCheck = off.checks.find((check) => check.id === "rules-section");
  assert.equal(offCheck.level, "info", "按配置不投影属于预期态，不该 warn");
  assert.equal(offCheck.absent, true);
  assert.match(offCheck.message, /按配置关闭/);
  const mode = off.checks.find((check) => check.id === "projection-mode");
  assert.ok(mode, "自检必须报出当前投影模式");
  assert.equal(mode.level, "info");
  assert.match(mode.message, /关闭/);
  assert.equal(off.summary.projectRules, false);
  assert.equal(off.ok, true, "info 不阻断");

  const on = runSelfcheck({ agentsPath, configPath: join(dir, "config.json"), dataDir: dir });
  const onCheck = on.checks.find((check) => check.id === "rules-section");
  assert.equal(onCheck.level, "warn", "开着却没导出 → 仍是 warn（信号不能丢）");
  assert.equal(on.summary.projectRules, true);
});

test("自检：缺省 projectRules 视为 true（向后兼容 0.4.2 的调用方）", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# 正文\n", "utf8");
  const result = runSelfcheck({ agentsPath, configPath: join(dir, "config.json"), dataDir: dir });
  assert.equal(result.summary.projectRules, true);
  assert.ok(!result.checks.some((check) => check.level === "error"));
});
