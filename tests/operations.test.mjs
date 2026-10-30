// MCP 数据面（src/mcp/operations.mjs）单测
//
// 全部在 os.tmpdir() 的临时目录内完成；不读真实 home、不读 ZCode 检出。
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { renderAgentsSection, validateRules } from "../src/rules/rules-engine.mjs";
import { SECTION_NAMES, locateNamedSection } from "../src/rules/sections.mjs";
import {
  AGENTS_SIZE_WARN_BYTES,
  POLICY_FILE,
  exportAgents,
  loadPolicy,
  loadRules,
  panelPath,
  renderPanelHtml,
  resolveDataPaths,
  runSelfcheck,
  savePolicy,
  saveRules,
} from "../src/mcp/operations.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEPT_DIRS = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-ops-"));
  KEPT_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of KEPT_DIRS) rmSync(dir, { force: true, recursive: true });
});

const RULES_A = {
  version: 1,
  name: "数据面规则",
  unmatched: "abstain",
  rules: [
    { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
    { id: "allow-read", tool: "Read", decision: "allow", comment: "读文件放行" },
  ],
};

const RULES_B = {
  version: 1,
  name: "数据面规则 B",
  unmatched: "deny",
  rules: [{ id: "deny-push", tool: "Bash", decision: "deny", commandPattern: "git push" }],
};

const INVALID_RULES = {
  version: 1,
  name: "非法规则",
  rules: [{ id: "bad", tool: "", decision: "maybe" }],
};

function dataDirFixture() {
  const dataDir = tempDir();
  return { dataDir, ...resolveDataPaths(dataDir) };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("loadRules：文件不存在视为空规则（exists=false），不是错误", () => {
  const { rulesPath } = dataDirFixture();
  const loaded = loadRules(rulesPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.exists, false);
  assert.equal(loaded.rules, null);
  assert.deepEqual(loaded.errors, []);
});

test("saveRules：合法规则归一化落盘，可被 loadRules 读回", () => {
  const { rulesPath } = dataDirFixture();
  const saved = saveRules(rulesPath, RULES_A);
  assert.equal(saved.ok, true);
  assert.equal(saved.written, true);
  assert.equal(saved.ruleCount, 2);
  assert.ok(existsSync(rulesPath));
  assert.equal(saved.sha256.length, 64);

  const loaded = loadRules(rulesPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.rules.name, "数据面规则");
  assert.equal(loaded.rules.rules.length, 2);
  assert.equal(loaded.rules.rules[0].decision, "deny");
  assert.equal(loaded.rules.rules[1].decision, "allow");
});

test("saveRules：非法规则拒绝写入，文件不产生", () => {
  const { rulesPath } = dataDirFixture();
  const saved = saveRules(rulesPath, INVALID_RULES);
  assert.equal(saved.ok, false);
  assert.equal(saved.written, false);
  assert.ok(saved.errors.length > 0);
  assert.equal(existsSync(rulesPath), false);
});

test("saveRules：非法规则不覆盖既有合法文件", () => {
  const { rulesPath } = dataDirFixture();
  assert.equal(saveRules(rulesPath, RULES_A).ok, true);
  const before = readFileSync(rulesPath, "utf8");
  const rejected = saveRules(rulesPath, INVALID_RULES);
  assert.equal(rejected.ok, false);
  assert.equal(readFileSync(rulesPath, "utf8"), before);
});

test("loadPolicy：缺省为空文本（零行为变化）", () => {
  const { policyPath } = dataDirFixture();
  const loaded = loadPolicy(policyPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.exists, false);
  assert.equal(loaded.text, "");
});

test("savePolicy：写入后可读回，二次写入字节完全相同", () => {
  const { policyPath } = dataDirFixture();
  const first = savePolicy(policyPath, "策略：不得外传密钥。");
  assert.equal(first.ok, true);
  const bytesAfterFirst = readFileSync(policyPath, "utf8");
  const second = savePolicy(policyPath, "策略：不得外传密钥。");
  assert.equal(second.ok, true);
  assert.equal(readFileSync(policyPath, "utf8"), bytesAfterFirst);

  const loaded = loadPolicy(policyPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.text, "策略：不得外传密钥。");
  assert.equal(loaded.exists, true);
  assert.equal(readJson(policyPath).version, 1);
});

test("content-policy 保留 CJK 与 CRLF 原貌", () => {
  const { policyPath } = dataDirFixture();
  const text = "第一行\r\n第二行：不要输出密钥\r\n";
  assert.equal(savePolicy(policyPath, text).ok, true);
  assert.equal(loadPolicy(policyPath).text, text);
});

test("exportAgents：AGENTS.md 不存在时创建只含两个哨兵段的文件", () => {
  const { dataDir } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  const result = exportAgents({ agentsPath, policy: "策略：保持克制。", rules: RULES_A });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.actions, { policy: "appended", rules: "appended" });

  const text = readFileSync(agentsPath, "utf8");
  const rules = locateNamedSection(text, SECTION_NAMES.RULES);
  const policy = locateNamedSection(text, SECTION_NAMES.CONTENT_POLICY);
  assert.ok(rules && policy);
  const outside = `${text.slice(0, rules.begin)}${text.slice(rules.end, policy.begin)}${text.slice(policy.end)}`;
  assert.equal(outside.trim(), "");
  const normalized = validateRules(RULES_A);
  assert.equal(normalized.ok, true);
  assert.equal(text.slice(rules.begin, rules.end), renderAgentsSection(normalized.rules));

  // 摘要不含全文大对象，只给动作/尺寸/哈希
  assert.equal(typeof result.bytes, "number");
  assert.equal(result.sha256.length, 64);
  assert.equal(result.sections.rules.present, true);
  assert.equal(result.sections.policy.present, true);
});

test("exportAgents：保留用户前缀与装后尾注，只替换两段", () => {
  const { dataDir } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  const prefix = "# 我的 AGENTS.md\n\n个人说明：保留我。\n";
  writeFileSync(agentsPath, prefix, "utf8");

  const first = exportAgents({ agentsPath, policy: "策略一", rules: RULES_A });
  assert.equal(first.ok, true);
  const withTail = `${readFileSync(agentsPath, "utf8")}\n## 尾注\n\n装后自己写的内容。\n`;
  writeFileSync(agentsPath, withTail, "utf8");

  const second = exportAgents({ agentsPath, policy: "策略二", rules: RULES_B });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.actions, { policy: "replaced", rules: "replaced" });

  const final = readFileSync(agentsPath, "utf8");
  assert.ok(final.startsWith(prefix));
  assert.ok(final.endsWith("\n## 尾注\n\n装后自己写的内容。\n"));
  assert.ok(final.includes("数据面规则 B"));
  assert.ok(!final.includes("禁止递归删除"), "旧规则段内容应被替换");
  assert.ok(final.includes("策略二"));
});

test("exportAgents：二次导出幂等（字节不变、changed=false）", () => {
  const { dataDir } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  const first = exportAgents({ agentsPath, policy: "策略一", rules: RULES_A });
  assert.equal(first.ok, true);
  const bytes = readFileSync(agentsPath, "utf8");
  const second = exportAgents({ agentsPath, policy: "策略一", rules: RULES_A });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(agentsPath, "utf8"), bytes);
});

test("exportAgents：非法规则拒绝导出，且不改写 AGENTS.md", () => {
  const { dataDir } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  writeFileSync(agentsPath, "用户原文\n", "utf8");
  const result = exportAgents({ agentsPath, policy: "", rules: INVALID_RULES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(readFileSync(agentsPath, "utf8"), "用户原文\n");
  assert.equal(statSync(agentsPath).size, Buffer.byteLength("用户原文\n", "utf8"));
});

test("runSelfcheck：干净状态全绿（规则/策略/投影/版本/尺寸）", () => {
  const { dataDir, rulesPath, policyPath } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  assert.equal(saveRules(rulesPath, RULES_A).ok, true);
  assert.equal(savePolicy(policyPath, "策略：保持克制。").ok, true);
  assert.equal(exportAgents({ agentsPath, policy: "策略：保持克制。", rules: RULES_A }).ok, true);

  const result = runSelfcheck({ agentsPath, configPath: join(dataDir, "config.json"), dataDir });
  assert.equal(result.ok, true);
  const levels = Object.fromEntries(result.checks.map((check) => [check.id, check.level]));
  assert.equal(levels["rules-valid"], "ok");
  assert.equal(levels["policy-state"], "ok");
  assert.equal(levels["agents-exists"], "ok");
  assert.equal(levels["rules-section"], "ok");
  assert.equal(levels["policy-section"], "ok");
  assert.equal(levels["agents-size"], "ok");
  assert.equal(levels["version"], "ok");
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.rulesCount, 2);
  assert.ok(result.summary.agentsBytes > 0);
});

test("runSelfcheck：规则段被手改 → 警告定位到 zcode-rules 段", () => {
  const { dataDir, rulesPath } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  assert.equal(saveRules(rulesPath, RULES_A).ok, true);
  assert.equal(savePolicy(join(dataDir, POLICY_FILE), "").ok, true);
  assert.equal(exportAgents({ agentsPath, policy: "", rules: RULES_A }).ok, true);

  const text = readFileSync(agentsPath, "utf8");
  const loc = locateNamedSection(text, SECTION_NAMES.RULES);
  assert.ok(loc);
  const tampered = `${text.slice(0, loc.begin)}${text
    .slice(loc.begin, loc.end)
    .replace("禁止递归删除", "已被人手改")}${text.slice(loc.end)}`;
  writeFileSync(agentsPath, tampered, "utf8");

  const result = runSelfcheck({ agentsPath, configPath: join(dataDir, "config.json"), dataDir });
  assert.equal(result.ok, true, "手改是 warn，不是 error");
  const ruleCheck = result.checks.find((check) => check.id === "rules-section");
  assert.equal(ruleCheck.level, "warn");
  assert.match(ruleCheck.message, /手改|不一致/);
  const policyCheck = result.checks.find((check) => check.id === "policy-section");
  assert.equal(policyCheck.level, "ok", "未动的策略段不应误报");
});

test("runSelfcheck：AGENTS.md >90KiB 触发尺寸预警，阈值下不触发", () => {
  const { dataDir, rulesPath } = dataDirFixture();
  const agentsPath = join(dataDir, "AGENTS.md");
  assert.equal(saveRules(rulesPath, RULES_A).ok, true);
  assert.equal(exportAgents({ agentsPath, policy: "", rules: RULES_A }).ok, true);

  const small = runSelfcheck({ agentsPath, configPath: join(dataDir, "config.json"), dataDir });
  assert.equal(small.checks.find((check) => check.id === "agents-size").level, "ok");

  appendFileSync(agentsPath, `\n${"x".repeat(AGENTS_SIZE_WARN_BYTES)}\n`, "utf8");
  const big = runSelfcheck({ agentsPath, configPath: join(dataDir, "config.json"), dataDir });
  assert.equal(big.ok, true, "尺寸预警是 warn，不阻断");
  const sizeCheck = big.checks.find((check) => check.id === "agents-size");
  assert.equal(sizeCheck.level, "warn");
  assert.match(sizeCheck.message, /90 KiB/);
  assert.ok(big.summary.agentsBytes > AGENTS_SIZE_WARN_BYTES);
});

test("runSelfcheck：rules.json 缺失 → rules-default info（使用内置空规则）", () => {
  const { dataDir } = dataDirFixture();
  const result = runSelfcheck({
    agentsPath: join(dataDir, "AGENTS.md"),
    configPath: join(dataDir, "config.json"),
    dataDir,
  });
  assert.equal(result.ok, true);
  const checks = Object.fromEntries(result.checks.map((check) => [check.id, check]));
  assert.equal(checks["rules-valid"].level, "warn");
  assert.equal(checks["rules-default"].level, "info");
  assert.match(checks["rules-default"].message, /内置空规则/);
  assert.match(checks["rules-default"].message, /abstain/);
});

test("runSelfcheck：config 不存在 → config-no-manual-hooks 通过", () => {
  const { dataDir } = dataDirFixture();
  const configPath = join(dataDir, "cli-config.json");
  const result = runSelfcheck({ agentsPath: join(dataDir, "AGENTS.md"), configPath, dataDir });
  const check = result.checks.find((entry) => entry.id === "config-no-manual-hooks");
  assert.equal(check.level, "ok");
  assert.match(check.message, /无手工 PermissionRequest 接线/);
  assert.equal(result.ok, true);
});

test("runSelfcheck：config 含手工 PermissionRequest 接线 → warning（不阻断）", () => {
  const { dataDir } = dataDirFixture();
  const configPath = join(dataDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        hooks: {
          events: {
            PermissionRequest: [{ hooks: [{ command: "node legacy-permission-rules.mjs", type: "command" }] }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const result = runSelfcheck({ agentsPath: join(dataDir, "AGENTS.md"), configPath, dataDir });
  assert.equal(result.ok, true, "手工接线是 warning，不是 error");
  const check = result.checks.find((entry) => entry.id === "config-no-manual-hooks");
  assert.equal(check.level, "warn");
  assert.match(check.message, /A 路线残留/);
  assert.equal(result.summary.errors, 0);
  assert.ok(result.summary.warnings >= 1);
});

test("runSelfcheck：PermissionRequest 为空数组或 hooks 缺省 → 通过", () => {
  const { dataDir } = dataDirFixture();
  const configPath = join(dataDir, "config.json");
  const target = () => runSelfcheck({ agentsPath: join(dataDir, "AGENTS.md"), configPath, dataDir });

  writeFileSync(
    configPath,
    `${JSON.stringify({ hooks: { events: { PermissionRequest: [] } } }, null, 2)}\n`,
    "utf8",
  );
  assert.equal(target().checks.find((entry) => entry.id === "config-no-manual-hooks").level, "ok");

  writeFileSync(
    configPath,
    `${JSON.stringify(
      { hooks: { events: { SessionStart: [{ hooks: [{ command: "node x.mjs", type: "command" }] }] } } },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const otherEvent = target().checks.find((entry) => entry.id === "config-no-manual-hooks");
  assert.equal(otherEvent.level, "ok", "只认 PermissionRequest，不误报其它事件");
});

test("runSelfcheck：config 非法 JSON → warning（无法确认无接线）", () => {
  const { dataDir } = dataDirFixture();
  const configPath = join(dataDir, "config.json");
  writeFileSync(configPath, "{ 这不是 JSON", "utf8");
  const result = runSelfcheck({ agentsPath: join(dataDir, "AGENTS.md"), configPath, dataDir });
  assert.equal(result.ok, true);
  const check = result.checks.find((entry) => entry.id === "config-no-manual-hooks");
  assert.equal(check.level, "warn");
  assert.match(check.message, /未能确认/);
});

test("renderPanelHtml 与 ui/panel.html 逐字节一致，且无假按钮/脚本", () => {
  const html = renderPanelHtml();
  assert.equal(html, readFileSync(panelPath(), "utf8"));

  const pkg = readJson(join(REPO_ROOT, "package.json"));
  assert.ok(html.includes(`v${pkg.version}`), "面板版本号必须与 package.json 一致");
  assert.ok(html.includes("面板四屏在 M3 实现"));
  assert.ok(!/<button\b/i.test(html), "禁止假按钮");
  assert.ok(!/\bonclick\s*=/i.test(html), "禁止假交互");
  assert.ok(!/<script\b/i.test(html), "静态占位页不应有脚本");
  assert.ok(!/<form\b/i.test(html), "静态占位页不应有表单");
});

