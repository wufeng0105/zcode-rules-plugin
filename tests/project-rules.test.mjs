// T68（v0.4.2）：exportAgents 的 `projectRules` 开关单测
//
// 语义（约定）：`projectRules !== false` 保持原行为（两段都投影）；
// 只有显式 `false` 才：① 不写 zcode-rules 段 ② 摘除已有的 zcode-rules 段
// ③ 只投影 zcode-content-policy 段 ④ `rules` 既不读也不校验。
//
// 为什么"摘除"而不是"留着不动"：留着的旧规则文本会继续注入模型上下文，看起来像
// "当前规则"——比没有更糟。摘除只动哨兵段本身，段外字节原样（sections.mjs 的外科式删段）。
//
// 全部在 os.tmpdir() 的临时目录内完成；不读真实 home、不读 ZCode 检出。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { renderAgentsSection, validateRules } from "../src/rules/rules-engine.mjs";
import { SECTION_NAMES, locateNamedSection } from "../src/rules/sections.mjs";
import {
  exportAgents,
  resolveDataPaths,
  runSelfcheck,
  savePolicy,
  saveRules,
} from "../src/mcp/operations.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEPT_DIRS = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-project-rules-"));
  KEPT_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of KEPT_DIRS) rmSync(dir, { force: true, recursive: true });
});

const RULES = {
  version: 1,
  name: "T68 规则集",
  unmatched: "abstain",
  rules: [
    { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
    { id: "allow-read", tool: "Read", decision: "allow", comment: "读文件放行" },
  ],
};

const POLICY = "策略：回答先给结论。\n第二行：不要外传密钥。";

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

test("projectRules:false + 文件不存在 → 只创建 zcode-content-policy 段，无 zcode-rules 段", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const result = exportAgents({ agentsPath, policy: POLICY, projectRules: false });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.equal(result.projectRules, false);
  assert.equal(result.actions.rules, "absent");
  assert.equal(result.actions.policy, "appended");
  assert.equal(result.ruleCount, 0);
  assert.equal(result.sections.rules.present, false);
  assert.equal(result.sections.policy.present, true);

  const text = readText(agentsPath);
  assert.ok(text.includes("BEGIN zcode-content-policy"), "必须有内容策略段");
  assert.ok(!text.includes("BEGIN zcode-rules"), "不得出现规则段");
  assert.ok(text.includes("第二行：不要外传密钥。"), "策略正文必须逐字写入");
  assert.equal(locateNamedSection(text, SECTION_NAMES.RULES), null, "规则段必须不存在");
});

test("projectRules:false + 已有两段 → 摘除规则段、更新策略段、段外用户内容逐字保留", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const prefix = "# 我的 AGENTS.md\n\n个人说明：保留我。\n";
  writeFileSync(agentsPath, prefix, "utf8");

  const both = exportAgents({ agentsPath, policy: "策略一", rules: RULES });
  assert.equal(both.ok, true);
  const withTailText = `${readText(agentsPath)}\n## 尾注\n\n装后自己写的内容。\n`;
  writeFileSync(agentsPath, withTailText, "utf8");
  const beforeBytes = Buffer.byteLength(withTailText, "utf8");

  const onlyPolicy = exportAgents({ agentsPath, policy: "策略二：只要策略段。", projectRules: false });
  assert.equal(onlyPolicy.ok, true);
  assert.equal(onlyPolicy.changed, true);
  assert.equal(onlyPolicy.actions.rules, "removed");
  assert.equal(onlyPolicy.sections.rules.present, false);
  assert.ok(onlyPolicy.removedRulesSection, "摘除时必须回报 removedRulesSection（字节数与 sha256）");
  assert.equal(typeof onlyPolicy.removedRulesSection.sha256, "string");
  assert.ok(onlyPolicy.removedRulesSection.bytes > 0);

  const text = readText(agentsPath);
  assert.ok(text.startsWith(prefix), "用户前缀必须逐字节保留");
  assert.ok(text.endsWith("\n## 尾注\n\n装后自己写的内容。\n"), "用户尾注必须逐字节保留");
  assert.ok(!text.includes("BEGIN zcode-rules"), "规则段必须被摘除");
  assert.ok(!text.includes("deny-rm"), "旧规则文本不得残留");
  assert.ok(text.includes("策略二：只要策略段。"));
  assert.ok(!text.includes("策略一"));
  assert.ok(Buffer.byteLength(text, "utf8") < beforeBytes, "摘段后文件应变小");
});

test("projectRules:false + 不传 rules → 仍然成功（该模式下规则不读也不校验）", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const result = exportAgents({ agentsPath, policy: "只要策略", projectRules: false });
  assert.equal(result.ok, true);
  assert.equal(result.ruleCount, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.sections.rules.present, false);
});

test("projectRules:false 时非法 rules 被忽略（不校验、不写）", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const result = exportAgents({
    agentsPath,
    policy: "策略",
    projectRules: false,
    rules: { version: 1, name: "坏规则", rules: [{ id: "x", tool: "", decision: "maybe" }] },
  });
  assert.equal(result.ok, true, "规则不参与投影，就不该因规则非法而失败");
  assert.equal(result.sections.rules.present, false);
});

test("projectRules:true 与不传参数逐字节一致（向后兼容）", () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const pathA = join(dirA, "AGENTS.md");
  const pathB = join(dirB, "AGENTS.md");

  const explicit = exportAgents({ agentsPath: pathA, policy: POLICY, rules: RULES, projectRules: true });
  const omitted = exportAgents({ agentsPath: pathB, policy: POLICY, rules: RULES });

  assert.equal(explicit.ok, true);
  assert.equal(omitted.ok, true);
  assert.equal(explicit.projectRules, true);
  assert.equal(omitted.projectRules, true);
  assert.deepEqual(explicit.actions, { policy: "appended", rules: "appended" });
  assert.deepEqual(omitted.actions, explicit.actions);
  assert.equal(readText(pathA), readText(pathB), "true 与不传必须产出完全相同的字节");
  assert.equal(explicit.sha256, omitted.sha256);
  assert.equal(explicit.ruleCount, RULES.rules.length);

  const text = readText(pathB);
  const normalized = validateRules(RULES);
  assert.equal(normalized.ok, true);
  const loc = locateNamedSection(text, SECTION_NAMES.RULES);
  assert.ok(loc, "缺省路径必须仍有规则段");
  assert.equal(text.slice(loc.begin, loc.end), renderAgentsSection(normalized.rules));
});

test("幂等：连续两次 projectRules:false，第二次 changed=false 且字节不变", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const first = exportAgents({ agentsPath, policy: POLICY, rules: RULES, projectRules: false });
  assert.equal(first.ok, true);
  const bytesAfterFirst = readText(agentsPath);
  const second = exportAgents({ agentsPath, policy: POLICY, rules: RULES, projectRules: false });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.actions.rules, "absent");
  assert.equal(second.actions.policy, "replaced");
  assert.equal(readText(agentsPath), bytesAfterFirst);
  assert.equal(second.sha256, first.sha256);
});

test("fail-closed：规则段哨兵残缺 + projectRules:false → ok=false，文件一个字节都不动", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const broken = "用户原文\n<!-- BEGIN zcode-rules (generated from JSON, DO NOT EDIT) -->\n没有 END 的半段\n";
  writeFileSync(agentsPath, broken, "utf8");

  const result = exportAgents({ agentsPath, policy: "策略", projectRules: false });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0], /哨兵结构异常/);
  assert.equal(readText(agentsPath), broken, "拒绝摘除时不得写文件");
});

test("CRLF 文档：摘段后仍保持 CRLF，且不出现裸 LF", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# 标题\r\n\r\n说明。\r\n", "utf8");

  assert.equal(exportAgents({ agentsPath, policy: "策略一", rules: RULES }).ok, true);
  const withBoth = readText(agentsPath);
  assert.ok(withBoth.includes("\r\n"));

  const result = exportAgents({ agentsPath, policy: "策略二", projectRules: false });
  assert.equal(result.ok, true);
  const text = readText(agentsPath);
  assert.ok(!text.includes("BEGIN zcode-rules"));
  assert.ok(text.includes("BEGIN zcode-content-policy"));
  assert.ok(!/(^|[^\r])\n/.test(text), "CRLF 文档里不应出现裸 LF");
});

test("自检口径：默认（开着）缺段是 warn；显式 projectRules:false 时是 info，policy-section 均为 ok", () => {
  const dir = tempDir();
  const paths = resolveDataPaths(dir);
  const agentsPath = join(dir, "AGENTS.md");
  assert.equal(saveRules(paths.rulesPath, RULES).ok, true);
  assert.equal(savePolicy(paths.policyPath, POLICY).ok, true);
  assert.equal(exportAgents({ agentsPath, policy: POLICY, projectRules: false }).ok, true);

  // 默认（projectRules=true，即 0.4.2 的既有语义）：缺段仍是 warn —— 信号不能丢
  const withRulesMode = runSelfcheck({ agentsPath, configPath: join(dir, "config.json"), dataDir: dir });
  assert.equal(withRulesMode.ok, true, "缺规则段只是 warn，不得变成 error");
  const warn = Object.fromEntries(withRulesMode.checks.map((check) => [check.id, check]));
  assert.equal(warn["rules-section"].level, "warn");
  assert.equal(warn["rules-section"].absent, true, "干净缺失必须带 absent 标记（面板据此不弹手改横幅）");
  assert.equal(warn["policy-section"].level, "ok");
  assert.equal(withRulesMode.summary.errors, 0);

  // v0.4.3：配置里关掉投影时，缺段是预期态 → info，不吓人
  const offMode = runSelfcheck({
    agentsPath,
    configPath: join(dir, "config.json"),
    dataDir: dir,
    projectRules: false,
  });
  const info = Object.fromEntries(offMode.checks.map((check) => [check.id, check]));
  assert.equal(info["rules-section"].level, "info");
  assert.equal(info["rules-section"].absent, true);
  assert.match(info["rules-section"].message, /按配置关闭/);
  assert.equal(info["policy-section"].level, "ok");
  assert.equal(offMode.summary.projectRules, false);
});

test("projectRules:false + CJK 多行策略：正文逐字写入且顺序不变", () => {
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const text = "第一条：提交信息一律中文。\n第二条：回答先给结论，再给依据。\n第三条：不要编造命令输出。";
  const result = exportAgents({ agentsPath, policy: text, projectRules: false });
  assert.equal(result.ok, true);
  const written = readText(agentsPath);
  assert.ok(written.includes(text), "多行 CJK 策略必须逐字保留（含换行）");
  assert.equal(result.policyBytes, Buffer.byteLength(text, "utf8"));
});

test("仓库公开签名未变：导出函数仍可被 scripts/proof 与 smoke-upgrade 的既有调用方式使用", () => {
  // 既有调用点（scripts/proof/*、scripts/smoke-upgrade.mjs、panel）都不传 projectRules：
  // 这里用同样形状的调用做一次回归，防止把默认值改成"关"。
  const dir = tempDir();
  const agentsPath = join(dir, "AGENTS.md");
  const result = exportAgents({
    agentsPath,
    rules: JSON.parse(readFileSync(join(REPO_ROOT, "rules.default.json"), "utf8")),
    policy: "",
  });
  assert.equal(result.ok, true);
  assert.equal(result.projectRules, true);
  assert.equal(result.sections.rules.present, true);
  assert.equal(result.sections.policy.present, true);
  assert.ok(existsSync(agentsPath));
});
