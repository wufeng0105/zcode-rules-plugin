// 从 AGENTS.md 哨兵段反解真源（src/mcp/agents-backfill.mjs）单测
//
// 全部在本地字符串上跑（不读磁盘、不写临时文件）：反解器的输入就是 AGENTS.md 文本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAgentsSection, validateRules } from "../src/rules/rules-engine.mjs";
import {
  SECTION_NAMES,
  composeNamedSection,
  upsertNamedSection,
} from "../src/rules/sections.mjs";
import {
  RULES_EMPTY_LINE,
  RULES_FOOTER_NOTE,
  RULES_HEADER_NOTE,
  normalizeEol,
  parseRulesSectionBody,
  readPolicySection,
  readRulesSection,
  stripComposedEol,
} from "../src/mcp/agents-backfill.mjs";

const RULES = {
  version: 1,
  name: "回填规则",
  unmatched: "abstain",
  rules: [
    { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
    { id: "allow-read", tool: "Read", decision: "allow", comment: "读文件放行" },
    { id: "ask-net", tool: "*", decision: "ask" },
  ],
};

const EMPTY_RULES = { version: 1, name: "空规则", rules: [] };

function agentsWith(rules, policy) {
  const validated = validateRules(rules);
  assert.equal(validated.ok, true, `夹具必须合法：${validated.errors.join(" ; ")}`);
  let text = upsertNamedSection("", SECTION_NAMES.RULES, renderAgentsSection(validated.rules)).content;
  text = upsertNamedSection(text, SECTION_NAMES.CONTENT_POLICY, policy).content;
  return text;
}

test("反解：自定义规则（allow/deny/ask、tool=*、无 comment）逐字段还原", () => {
  const agents = agentsWith(RULES, "");
  const result = readRulesSection(agents);
  assert.equal(result.present, true);
  assert.equal(result.malformed, false);
  assert.equal(result.ok, true, `应可无损回填：${result.errors.join(" ; ")}`);
  assert.equal(result.roundTrip, true);
  assert.equal(result.rules.name, "回填规则");
  assert.equal(result.rules.unmatched, "abstain");
  assert.equal(result.rules.onTimeout, "deny");
  assert.equal(result.rules.watchdogMs, 120000);
  assert.equal(result.rules.rules.length, 3);
  // 投影按 decision 分组（允许 → 询问 → 禁止），所以段内次序是分组后的次序，不是真源次序。
  assert.deepEqual(
    result.rules.rules.map((rule) => [rule.id, rule.tool, rule.decision, rule.commandPattern ?? null]),
    [
      ["allow-read", "Read", "allow", null],
      ["ask-net", "*", "ask", null],
      ["deny-rm", "Bash", "deny", "^rm -rf"],
    ],
  );
  assert.equal(result.rules.rules[2].comment, "禁止递归删除");
});

test("次序还原：给了当前真源则保持真源次序，并报 orderChanged（first-match-wins 有语义）", () => {
  const agents = agentsWith(RULES, "");
  const current = validateRules(RULES).rules;
  const result = readRulesSection(agents, current);
  assert.equal(result.ok, true);
  assert.equal(result.suggested.ok, true, result.suggested.errors.join(" ; "));
  assert.deepEqual(
    result.suggested.rules.rules.map((rule) => rule.id),
    ["deny-rm", "allow-read", "ask-net"],
    "回填结果必须保持 rules.json 的原次序",
  );
  assert.equal(result.suggested.orderChanged, true, "段内分组次序与真源不同 → 必须提示");
  assert.deepEqual(result.suggested.droppedIds, []);
  assert.deepEqual(result.suggested.appendedIds, []);
});

test("次序还原：段里新增的规则追加在末尾，段里删掉的规则进 droppedIds", () => {
  const current = validateRules(RULES).rules;
  const handEdited = {
    ...RULES,
    rules: [
      { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
      { id: "allow-read", tool: "Read", decision: "allow", comment: "读文件放行" },
      { id: "new-rule", tool: "Write", decision: "deny", comment: "手改新增" },
    ],
  };
  const result = readRulesSection(agentsWith(handEdited, ""), current);
  assert.equal(result.ok, true, result.errors.join(" ; "));
  assert.deepEqual(result.suggested.rules.rules.map((rule) => rule.id), ["deny-rm", "allow-read", "new-rule"]);
  assert.deepEqual(result.suggested.appendedIds, ["new-rule"]);
  assert.deepEqual(result.suggested.droppedIds, ["ask-net"]);
});

test("次序还原：不给当前真源时不合并，suggested 用段内次序", () => {
  const result = readRulesSection(agentsWith(RULES, ""), null);
  assert.equal(result.ok, true);
  assert.equal(result.suggested.ok, true);
  assert.deepEqual(
    result.suggested.rules.rules.map((rule) => rule.id),
    ["allow-read", "ask-net", "deny-rm"],
  );
});

test("反解：空规则集（占位行）也能还原成 rules: []", () => {
  const agents = agentsWith(EMPTY_RULES, "");
  assert.ok(agents.includes(RULES_EMPTY_LINE), "夹具应含空规则占位行");
  const result = readRulesSection(agents);
  assert.equal(result.ok, true, `应可无损回填：${result.errors.join(" ; ")}`);
  assert.deepEqual(result.rules.rules, []);
  assert.equal(result.rules.name, "空规则");
});

test("反解：CRLF 文档与 LF 文档都 ok，且 roundTrip 只按行尾归一化比较", () => {
  const lf = agentsWith(RULES, "");
  const crlf = lf.replaceAll("\n", "\r\n");
  const lfResult = readRulesSection(lf);
  const crlfResult = readRulesSection(crlf);
  assert.equal(lfResult.ok, true);
  assert.equal(crlfResult.ok, true);
  assert.deepEqual(crlfResult.rules, lfResult.rules);
});

test("反解：段缺失 → present=false / ok=false（不伪造候选）", () => {
  const result = readRulesSection("# 无关文件\n\n随便写点什么。\n");
  assert.equal(result.present, false);
  assert.equal(result.malformed, false);
  assert.equal(result.ok, false);
  assert.equal(result.rules, null);
});

test("反解：哨兵残缺 → malformed=true，仍不给候选", () => {
  const broken = agentsWith(RULES, "").replace("<!-- END zcode-rules -->", "");
  const result = readRulesSection(broken);
  assert.equal(result.present, false);
  assert.equal(result.malformed, true);
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /END/);
});

test("反解：格式仍然合法的「手改」是合法真源（改 id 会体现为 dropped+appended）", () => {
  const current = validateRules(RULES).rules;
  const agents = agentsWith(RULES, "").replace("[`deny-rm`]", "[`deny-rm-hand`]");
  const result = readRulesSection(agents, current);
  assert.equal(result.ok, true, "改 id 但格式没坏 —— 这是可回填的合法真源");
  assert.deepEqual(result.suggested.droppedIds, ["deny-rm"]);
  assert.deepEqual(result.suggested.appendedIds, ["deny-rm-hand"]);
  assert.deepEqual(
    result.suggested.rules.rules.map((rule) => rule.id),
    ["allow-read", "ask-net", "deny-rm-hand"],
  );
});

test("反解：段内被手改坏格式（条目改成散文）→ ok=false，绝不给半成品规则", () => {
  const agents = agentsWith(RULES, "").replace(
    "- [`allow-read`] `Read` —— 读文件放行",
    "- 读文件我觉得应该放行（手写的一句话）",
  );
  const result = readRulesSection(agents);
  assert.equal(result.present, true);
  assert.equal(result.ok, false);
  assert.equal(result.rules, null);
  assert.equal(result.suggested, null);
  assert.ok(result.errors.length > 0, "坏格式必须体现在 errors 上");
});

test("反解：条目数与分组声明不一致 → 明确报错", () => {
  const agents = agentsWith(RULES, "").replace("### 禁止（1 条）", "### 禁止（2 条）");
  const result = readRulesSection(agents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("声明 2 条")), result.errors.join(" ; "));
});

test("反解：段尾说明被删 → 明确报错（不静默接受）", () => {
  const agents = agentsWith(RULES, "").replace(RULES_FOOTER_NOTE, "> 我自己写的说明");
  const result = readRulesSection(agents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("反解：正则合法时修复回渲；注释含分隔符时拒绝而非误解析", () => {
  const withCommentDashes = {
    version: 1,
    name: "难缠规则",
    rules: [
      { id: "x", tool: "Bash", decision: "deny", commandPattern: "^echo a/b$", comment: "a —— b" },
    ],
  };
  const agents = agentsWith(withCommentDashes, "");
  const result = readRulesSection(agents);
  // 注释自身含 " —— " 会导致回渲不一致（投影把 comment 原样接在 " —— " 之后，
  // 而反解按第一个 " —— " 切分后拼回是一样的）；这里断言语义：要么无损，要么明确拒绝。
  if (result.ok) {
    assert.equal(result.rules.rules[0].comment, "a —— b");
    assert.equal(result.rules.rules[0].commandPattern, "^echo a/b$");
  } else {
    assert.equal(result.rules, null);
    assert.ok(result.errors.length > 0);
  }
});

test("反解：policy 段逐字往返（含空策略、多行、中文）", () => {
  for (const policy of ["", "第一行\n第二行", " 前后空格保留  ", "含 `反引号` 与 —— 破折号"]) {
    const agents = agentsWith(EMPTY_RULES, policy);
    const result = readPolicySection(agents);
    assert.equal(result.present, true, `policy=${JSON.stringify(policy)} 应存在`);
    assert.equal(result.ok, true, `policy=${JSON.stringify(policy)} 应可回填`);
    assert.equal(result.roundTrip, true);
    assert.equal(result.text, policy);
  }
});

test("反解：policy 段缺失 → present=false / text=''", () => {
  const result = readPolicySection("<!-- BEGIN zcode-rules (generated from JSON, DO NOT EDIT) -->\nx\n<!-- END zcode-rules -->\n");
  assert.equal(result.present, false);
  assert.equal(result.ok, false);
  assert.equal(result.text, "");
});

test("格式常量与 rules-engine 投影一致（引擎文案改动时本测试报红）", () => {
  const agents = agentsWith(RULES, "");
  assert.ok(agents.includes(RULES_HEADER_NOTE), "生成说明常量与引擎输出不一致");
  assert.ok(agents.includes(RULES_FOOTER_NOTE), "段尾说明常量与引擎输出不一致");
  const empty = agentsWith(EMPTY_RULES, "");
  assert.ok(empty.includes(RULES_EMPTY_LINE), "空规则占位常量与引擎输出不一致");
});

test("parseRulesSectionBody：段标题缺失 → 报错而非猜测", () => {
  const result = parseRulesSectionBody("没有标题\n");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /段标题/);
});

test("stripComposedEol：逆操作精确（CRLF/LF 都只剥一层）", () => {
  assert.equal(stripComposedEol("\nabc\n"), "abc");
  assert.equal(stripComposedEol("\r\nabc\r\n"), "abc");
  assert.equal(stripComposedEol(""), "");
  assert.equal(stripComposedEol("\n"), "");
  assert.equal(stripComposedEol("\n\na\n\n"), "\na\n");
});

test("normalizeEol：只归一化 CRLF，不碰孤立 CR", () => {
  assert.equal(normalizeEol("a\r\nb"), "a\nb");
  assert.equal(normalizeEol("a\rb"), "a\rb");
});

test("composeNamedSection 与反解协同：段内正文被逐字还原", () => {
  const policy = "多行\n策略\n";
  const section = composeNamedSection(SECTION_NAMES.CONTENT_POLICY, policy, "\n");
  const agents = `# 头\n\n${section}\n`;
  const result = readPolicySection(agents);
  assert.equal(result.ok, true);
  assert.equal(result.text, policy);
});
