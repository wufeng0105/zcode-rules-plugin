// 规则引擎单元测试：node:test + node:assert/strict，零依赖、离线可跑。
//
// 纪律：
//   · 夹具全部内联在本文件里（不读取 ZCode 检出、不读真实 home、不写盘）；
//   · 断言落在可观察行为上（返回值/字符串/分组），不写恒真断言；
//   · 用例覆盖 brief-WP23 C3 要求的五个面：schema 接受/拒绝、投影哨兵与确定性、
//     upsert 幂等、哨兵摘除与 refused、以及（在 agents-section.test.mjs 里）CJK 单位换算。
import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
  RULE_SCHEMA_VERSION,
  consistencyCheck,
  evaluate,
  fingerprintRules,
  renderAgentsSection,
  validateRules,
} from "../src/rules/rules-engine.mjs";

// ---------------------------------------------------------------------------
// 内联夹具
// ---------------------------------------------------------------------------
const EMPTY_RULES = {
  version: 1,
  name: "空模板（未启用任何放行策略）",
  description: "空模板：默认不放行任何东西。",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [],
};

const SAMPLE_RULES = {
  version: 1,
  name: "示例：只读与低危命令",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [
    {
      id: "ro-git-status",
      tool: "Bash",
      commandPattern: "^git status$",
      decision: "allow",
      comment: "只读查询",
    },
    {
      id: "ask-publish",
      tool: "Bash",
      commandPattern: "^npm publish$",
      decision: "ask",
      comment: "发布类命令应询问",
    },
    {
      id: "deny-rm-root",
      tool: "Bash",
      commandPattern: "^rm -rf /$",
      decision: "deny",
      comment: "禁止删除根目录",
    },
    {
      id: "any-tool",
      tool: "*",
      decision: "allow",
      comment: "任意工具（演示 tool=* 与无 commandPattern）",
    },
  ],
};

/** 断言校验通过并返回归一化后的规则对象 */
function accept(raw) {
  const result = validateRules(raw);
  assert.equal(result.ok, true, `期望接受，实际错误：${result.errors.join(" | ")}`);
  assert.deepEqual(result.errors, []);
  assert.ok(result.rules !== null);
  return result.rules;
}

// ---------------------------------------------------------------------------
// 1. schema：接受合法输入
// ---------------------------------------------------------------------------
test("validateRules 接受合法空模板，并归一化默认值", () => {
  const rules = accept(EMPTY_RULES);
  assert.equal(rules.version, RULE_SCHEMA_VERSION);
  assert.equal(rules.unmatched, "abstain");
  assert.equal(rules.onTimeout, "deny");
  assert.equal(rules.watchdogMs, 120000);
  assert.deepEqual(rules.rules, []);
  assert.equal(rules.name, EMPTY_RULES.name);
  assert.equal(rules.description, EMPTY_RULES.description);
});

test("validateRules 接受含三类 decision 的合法规则集，保序保留字段", () => {
  const rules = accept(SAMPLE_RULES);
  assert.equal(rules.rules.length, 4);
  assert.deepEqual(
    rules.rules.map((rule) => rule.decision),
    ["allow", "ask", "deny", "allow"],
  );
  assert.deepEqual(
    rules.rules.map((rule) => rule.id),
    ["ro-git-status", "ask-publish", "deny-rm-root", "any-tool"],
  );
  assert.equal(rules.rules[0].commandPattern, "^git status$");
  assert.equal(rules.rules[3].tool, "*");
});

// ---------------------------------------------------------------------------
// 2. schema：拒绝非法输入（错误信息带字段路径）
// ---------------------------------------------------------------------------
test("validateRules 拒绝非法规则并指出字段路径", () => {
  const cases = [
    { field: "version", raw: { ...EMPTY_RULES, version: 2 } },
    { field: "name", raw: { ...EMPTY_RULES, name: "   " } },
    { field: "unmatched", raw: { ...EMPTY_RULES, unmatched: "allow" } },
    { field: "onTimeout", raw: { ...EMPTY_RULES, onTimeout: "ask" } },
    { field: "watchdogMs", raw: { ...EMPTY_RULES, watchdogMs: -5 } },
    { field: "rules", raw: { version: 1, name: "缺 rules 字段" } },
    {
      field: "rules[0].decision",
      raw: { ...EMPTY_RULES, rules: [{ id: "a", tool: "Bash", decision: "maybe" }] },
    },
    {
      field: "rules[0].id",
      raw: { ...EMPTY_RULES, rules: [{ id: "", tool: "", decision: "allow", comment: "x" }] },
    },
    {
      field: "rules[1].id",
      raw: {
        ...EMPTY_RULES,
        rules: [
          { id: "dup", tool: "Bash", decision: "allow", comment: "x" },
          { id: "dup", tool: "Bash", decision: "deny", comment: "y" },
        ],
      },
    },
    {
      field: "rules[0].commandPattern",
      raw: {
        ...EMPTY_RULES,
        rules: [
          { id: "bad-re", tool: "Bash", decision: "deny", comment: "x", commandPattern: "(" },
        ],
      },
    },
  ];

  for (const { field, raw } of cases) {
    const result = validateRules(raw);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
    assert.equal(result.rules, null, "校验失败时不得返回归一化结果");
    assert.ok(
      result.errors.some((message) => message.includes(field)),
      `错误应提到 ${field}，实际：${result.errors.join(" | ")}`,
    );
  }
});

test("validateRules 拒绝非对象输入", () => {
  for (const raw of [null, undefined, [], "rules", 42]) {
    const result = validateRules(raw);
    assert.equal(result.ok, false, `应拒绝：${String(raw)}`);
    assert.deepEqual(result.errors, ["规则必须是 JSON 对象"]);
    assert.equal(result.rules, null);
  }
});

test("validateRules 对高危默认值/越界配置给警告但不阻断", () => {
  const allowWithoutComment = validateRules({
    version: 1,
    name: "无 comment 的 allow",
    rules: [{ id: "a", tool: "Bash", decision: "allow" }],
  });
  assert.equal(allowWithoutComment.ok, true);
  assert.ok(allowWithoutComment.warnings.some((w) => w.includes("allow 但没写 comment")));

  const tooShort = validateRules({ version: 1, name: "x", watchdogMs: 500, rules: [] });
  assert.equal(tooShort.ok, true);
  assert.ok(tooShort.warnings.some((w) => w.includes("过短")));

  const tooLong = validateRules({ version: 1, name: "x", watchdogMs: 700000, rules: [] });
  assert.equal(tooLong.ok, true);
  assert.ok(tooLong.warnings.some((w) => w.includes("超过 10 分钟")));
});

// ---------------------------------------------------------------------------
// 3. AGENTS.md 段投影：哨兵、分组、确定性
// ---------------------------------------------------------------------------
test("renderAgentsSection 输出以 BEGIN/END 哨兵包裹，并按 decision 分组", () => {
  const rules = accept(SAMPLE_RULES);
  const section = renderAgentsSection(rules);

  assert.ok(section.startsWith(AGENTS_SECTION_BEGIN), "首行必须是 BEGIN 哨兵");
  assert.ok(section.endsWith(AGENTS_SECTION_END), "末行必须是 END 哨兵");
  assert.ok(section.includes(`## ${rules.name}`));
  assert.ok(section.includes("### 允许（2 条）"));
  assert.ok(section.includes("### 询问（1 条）"));
  assert.ok(section.includes("### 禁止（1 条）"));
  assert.ok(section.includes("任意工具"), "tool=* 应渲染为「任意工具」");
  assert.ok(section.includes("/^git status$/"), "commandPattern 应原文露出");
  assert.ok(section.includes("[`ro-git-status`]"));
});

test("renderAgentsSection 对同一输入确定性输出（两次调用逐字符相同且不含时间戳）", () => {
  const rules = accept(SAMPLE_RULES);
  const first = renderAgentsSection(rules);
  const second = renderAgentsSection(rules);
  const cloned = renderAgentsSection(structuredClone(rules));

  assert.equal(first, second);
  assert.equal(first, cloned);
  assert.equal(first.length, second.length);
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first), false, "投影不得含运行时刻，否则不确定");
});

test("renderAgentsSection 对空规则集给显式空集提示，且不产生分组标题", () => {
  const rules = accept(EMPTY_RULES);
  const section = renderAgentsSection(rules);

  assert.ok(section.startsWith(AGENTS_SECTION_BEGIN));
  assert.ok(section.endsWith(AGENTS_SECTION_END));
  assert.ok(section.includes("（当前规则集为空：所有请求都按产品原行为处理。）"));
  assert.equal(section.includes("### "), false);
  assert.ok(section.includes("`abstain`"), "未命中策略应写入段");
  assert.ok(section.includes("`deny`"), "超时策略应写入段");
});

// ---------------------------------------------------------------------------
// 4. hook 判定：三态显式可区分 + first-match-wins + unmatched 语义
// ---------------------------------------------------------------------------
test("evaluate 命中 allow / ask / deny 三条规则时给出对应 kind", () => {
  const rules = accept(SAMPLE_RULES);

  const allowed = evaluate(rules, { toolName: "Bash", toolInput: { command: "git status" } });
  assert.equal(allowed.kind, "allow");
  assert.equal(allowed.rule.id, "ro-git-status");
  assert.equal(allowed.command, "git status");

  const asked = evaluate(rules, { toolName: "Bash", toolInput: { command: "npm publish" } });
  assert.equal(asked.kind, "ask");
  assert.equal(asked.rule.id, "ask-publish");
  assert.ok(asked.reason.includes("本版本 hook 无法表达 ask"));

  const denied = evaluate(rules, { toolName: "Bash", toolInput: { command: "rm -rf /" } });
  assert.equal(denied.kind, "deny");
  assert.equal(denied.rule.id, "deny-rm-root");

  const anyTool = evaluate(rules, { toolName: "Read", toolInput: { command: "README.md" } });
  assert.equal(anyTool.kind, "allow", "tool=* 应命中任意工具");
  assert.equal(anyTool.rule.id, "any-tool");
});

test("evaluate 未命中时按 unmatched 退回 abstain 或显式 deny", () => {
  const allowOne = accept({
    ...EMPTY_RULES,
    rules: [
      { id: "only-ls", tool: "Bash", commandPattern: "^ls$", decision: "allow", comment: "x" },
    ],
  });
  const miss = evaluate(allowOne, { toolName: "Bash", toolInput: { command: "cat /etc/passwd" } });
  assert.equal(miss.kind, "abstain");
  assert.equal(miss.rule, null);
  assert.ok(miss.reason.includes("unmatched=abstain"));

  const failClosed = accept({ ...EMPTY_RULES, unmatched: "deny", rules: [] });
  const blocked = evaluate(failClosed, { toolName: "Bash", toolInput: { command: "anything" } });
  assert.equal(blocked.kind, "deny");
  assert.equal(blocked.rule, null);
  assert.ok(blocked.reason.includes("unmatched=deny"));
});

test("evaluate 遵循 first-match-wins，并兼容 snake_case 的 hook 输入", () => {
  const rules = accept({
    ...EMPTY_RULES,
    rules: [
      { id: "deny-rm", tool: "Bash", commandPattern: "^rm\\s", decision: "deny", comment: "x" },
      { id: "allow-all-bash", tool: "Bash", decision: "allow", comment: "y" },
    ],
  });

  const denied = evaluate(rules, { tool_name: "Bash", tool_input: { command: "rm -rf tmp" } });
  assert.equal(denied.kind, "deny");
  assert.equal(denied.rule.id, "deny-rm", "先命中的 deny 必须胜出");

  const allowed = evaluate(rules, { toolName: "Bash", toolInput: { command: "git status" } });
  assert.equal(allowed.kind, "allow");
  assert.equal(allowed.rule.id, "allow-all-bash");

  const otherTool = evaluate(rules, { toolName: "Read", toolInput: { command: "git status" } });
  assert.equal(otherTool.kind, "abstain", "工具不匹配时不得被 Bash 规则命中");
  assert.equal(otherTool.command, "git status", "command 只是原样带出，不参与匹配");
});

// ---------------------------------------------------------------------------
// 5. 单一性自检与指纹
// ---------------------------------------------------------------------------
test("consistencyCheck 判定投影一致/手改/缺段，fingerprintRules 确定且敏感", () => {
  const rules = accept(SAMPLE_RULES);
  const section = renderAgentsSection(rules);

  const consistent = consistencyCheck(rules, `# 用户文件\n\n${section}\n\n## 尾注\n`);
  assert.deepEqual(consistent, { ok: true, problems: [] });

  const tampered = consistencyCheck(rules, section.replace("### 允许（2 条）", "### 允许（1 条）"));
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.length >= 1);
  assert.ok(tampered.problems.some((p) => p.includes("不一致")));

  const missing = consistencyCheck(rules, "# 没有任何规则段\n");
  assert.equal(missing.ok, false);
  assert.ok(missing.problems[0].includes("没有 zcode-rules 段"));

  assert.equal(fingerprintRules(rules), fingerprintRules(structuredClone(rules)));
  assert.equal(fingerprintRules(rules).length, 16);
  assert.notEqual(
    fingerprintRules(rules),
    fingerprintRules(accept({ ...SAMPLE_RULES, name: "另一个名称" })),
  );
});
