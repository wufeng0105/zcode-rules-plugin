// 命名哨兵双段引擎单测（被测：src/rules/sections.mjs）
//
// 夹具全部内联 / 临时目录，不读取 ZCode 检出、不读真实 home。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
  renderAgentsSection,
} from "../src/rules/rules-engine.mjs";
import {
  KNOWN_SECTION_NAMES,
  SECTION_NAMES,
  composeNamedSection,
  locateNamedSection,
  removeNamedSection,
  sectionSnapshot,
  sentinelsFor,
  upsertNamedSection,
} from "../src/rules/sections.mjs";

const RULES_A = {
  version: 1,
  name: "测试规则 A",
  unmatched: "abstain",
  rules: [
    { id: "deny-rm", tool: "Bash", decision: "deny", commandPattern: "^rm -rf", comment: "禁止递归删除" },
    { id: "allow-read", tool: "Read", decision: "allow", comment: "读文件放行" },
  ],
};

const RULES_B = {
  version: 1,
  name: "测试规则 B",
  unmatched: "deny",
  rules: [
    { id: "deny-git-push", tool: "Bash", decision: "deny", commandPattern: "git push" },
  ],
};

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

test("zcode-rules 哨兵与 rules-engine 常量逐字一致（格式兼容）", () => {
  const sentinels = sentinelsFor(SECTION_NAMES.RULES);
  assert.equal(sentinels.begin, AGENTS_SECTION_BEGIN);
  assert.equal(sentinels.end, AGENTS_SECTION_END);

  const rendered = renderAgentsSection(RULES_A);
  assert.ok(rendered.startsWith(AGENTS_SECTION_BEGIN));
  assert.ok(rendered.endsWith(AGENTS_SECTION_END));
  assert.deepEqual(locateNamedSection(rendered, SECTION_NAMES.RULES), {
    begin: 0,
    end: rendered.length,
    bodyStart: AGENTS_SECTION_BEGIN.length,
    bodyEnd: rendered.length - AGENTS_SECTION_END.length,
  });
});

test("zcode-content-policy 哨兵为固定字面量，空正文不伪造默认指令", () => {
  const sentinels = sentinelsFor(SECTION_NAMES.CONTENT_POLICY);
  assert.equal(
    sentinels.begin,
    "<!-- BEGIN zcode-content-policy (free text, DO NOT EDIT) -->",
  );
  assert.equal(sentinels.end, "<!-- END zcode-content-policy -->");
  assert.deepEqual([...KNOWN_SECTION_NAMES].sort(), [
    "zcode-content-policy",
    "zcode-rules",
  ]);
  // 空正文 = 哨兵之间只有一个空行；没有任何标题/默认策略文本。
  assert.equal(
    composeNamedSection(SECTION_NAMES.CONTENT_POLICY, ""),
    `${sentinels.begin}\n\n${sentinels.end}`,
  );
});

test("locateNamedSection 对缺失/残缺/乱序/重复哨兵一律返回 null", () => {
  assert.equal(locateNamedSection("普通文本，没有任何段", SECTION_NAMES.RULES), null);
  assert.equal(
    locateNamedSection(`前缀\n${AGENTS_SECTION_BEGIN}\n正文\n`, SECTION_NAMES.RULES),
    null,
  );
  assert.equal(
    locateNamedSection(`${AGENTS_SECTION_END}\n${AGENTS_SECTION_BEGIN}\n`, SECTION_NAMES.RULES),
    null,
  );
  assert.equal(
    locateNamedSection(
      `${AGENTS_SECTION_BEGIN}\nA\n${AGENTS_SECTION_END}\n${AGENTS_SECTION_BEGIN}\nB\n${AGENTS_SECTION_END}`,
      SECTION_NAMES.RULES,
    ),
    null,
  );
});

test("upsert 从空文本生成两个哨兵段：段外无任何伪造字节", () => {
  const rulesStep = upsertNamedSection("", SECTION_NAMES.RULES, renderAgentsSection(RULES_A));
  assert.equal(rulesStep.action, "appended");
  const policyStep = upsertNamedSection(
    rulesStep.content,
    SECTION_NAMES.CONTENT_POLICY,
    "策略：不得把密钥写进日志。",
  );
  assert.equal(policyStep.action, "appended");

  const text = policyStep.content;
  const rules = locateNamedSection(text, SECTION_NAMES.RULES);
  const policy = locateNamedSection(text, SECTION_NAMES.CONTENT_POLICY);
  assert.ok(rules && policy);
  assert.ok(rules.begin < policy.begin);

  const outside = `${text.slice(0, rules.begin)}${text.slice(rules.end, policy.begin)}${text.slice(policy.end)}`;
  assert.equal(outside.trim(), "");
  assert.equal(text.slice(rules.begin, rules.end), renderAgentsSection(RULES_A));
});

test("upsert 替换只动段内：用户前缀与尾注逐字节不变", () => {
  const prefix = "# 我的 AGENTS.md\n\n个人说明：保留我。\n";
  const suffix = "\n## 尾注\n\n装后自己写的内容。\n";
  const text = `${prefix}${renderAgentsSection(RULES_A)}\n${suffix}`;

  const replaced = upsertNamedSection(text, SECTION_NAMES.RULES, renderAgentsSection(RULES_B));
  assert.equal(replaced.action, "replaced");
  assert.ok(replaced.content.startsWith(prefix));
  assert.ok(replaced.content.endsWith(suffix));
  assert.ok(replaced.content.includes("测试规则 B"));
  assert.ok(!replaced.content.includes("测试规则 A"));
});

test("upsert 幂等：同一输入二次导出字节完全相同", () => {
  const first = upsertNamedSection("用户前缀\n", SECTION_NAMES.RULES, renderAgentsSection(RULES_A));
  const second = upsertNamedSection(first.content, SECTION_NAMES.RULES, renderAgentsSection(RULES_A));
  assert.equal(second.action, "replaced");
  assert.equal(second.content, first.content);

  const policyFirst = upsertNamedSection(second.content, SECTION_NAMES.CONTENT_POLICY, "策略：保持克制。");
  const policySecond = upsertNamedSection(
    policyFirst.content,
    SECTION_NAMES.CONTENT_POLICY,
    "策略：保持克制。",
  );
  assert.equal(policySecond.content, policyFirst.content);
});

test("删除只摘段：哨兵零残留、审计值可复核、段外原样", () => {
  const prefix = "# 用户内容\n\n";
  const appended = upsertNamedSection(prefix, SECTION_NAMES.RULES, renderAgentsSection(RULES_A));
  const section = renderAgentsSection(RULES_A);

  const removed = removeNamedSection(appended.content, SECTION_NAMES.RULES);
  assert.equal(removed.action, "removed");
  assert.equal(removed.content, prefix);
  assert.ok(!removed.content.includes(AGENTS_SECTION_BEGIN));
  assert.equal(removed.removedBytes, Buffer.byteLength(section, "utf8"));
  assert.equal(removed.removedSha256, sha256(section));
  assert.equal(removed.removedSection, section);
});

test("删除对残缺/乱序哨兵返回 refused，内容原样不盲删", () => {
  const broken = `用户前缀\n${AGENTS_SECTION_BEGIN}\n正文没有结束哨兵\n`;
  const refused = removeNamedSection(broken, SECTION_NAMES.RULES);
  assert.equal(refused.action, "refused");
  assert.equal(refused.content, broken);
  assert.match(refused.reason, /END/);

  const inverted = `${AGENTS_SECTION_END}\n${AGENTS_SECTION_BEGIN}\n`;
  assert.equal(removeNamedSection(inverted, SECTION_NAMES.RULES).action, "refused");

  const duplicated = `${AGENTS_SECTION_BEGIN}\nA\n${AGENTS_SECTION_END}\n${AGENTS_SECTION_BEGIN}\nB\n${AGENTS_SECTION_END}`;
  assert.equal(removeNamedSection(duplicated, SECTION_NAMES.RULES).action, "refused");
});

test("删除对无段文档返回 absent，内容不变", () => {
  const text = "没有命名的段。\n";
  assert.deepEqual(removeNamedSection(text, SECTION_NAMES.RULES), { action: "absent", content: text });
});

test("CRLF 文档：段外原貌保留、新段沿用 CRLF、二次导出幂等", () => {
  const prefix = "# 用户 CRLF 文档\r\n\r\n正文一行\r\n";
  const appended = upsertNamedSection(prefix, SECTION_NAMES.CONTENT_POLICY, "策略一");
  assert.equal(appended.action, "appended");
  assert.ok(appended.content.startsWith(prefix));

  const loc = locateNamedSection(appended.content, SECTION_NAMES.CONTENT_POLICY);
  assert.ok(loc);
  const section = appended.content.slice(loc.begin, loc.end);
  assert.ok(section.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(section), "段内不应出现裸 LF");

  const again = upsertNamedSection(appended.content, SECTION_NAMES.CONTENT_POLICY, "策略一");
  assert.equal(again.content, appended.content);
});

test("CJK 正文：removedBytes 为 UTF-8 字节数，哈希可独立复核", () => {
  const body = "策略：禁止把密钥写入日志，禁止外传。";
  const appended = upsertNamedSection("", SECTION_NAMES.CONTENT_POLICY, body);
  const removed = removeNamedSection(appended.content, SECTION_NAMES.CONTENT_POLICY);
  assert.equal(removed.action, "removed");
  assert.ok(removed.removedBytes > body.length, "含 CJK 时字节数应大于 UTF-16 码元数");
  assert.equal(
    removed.removedSha256,
    createHash("sha256").update(Buffer.from(removed.removedSection, "utf8")).digest("hex"),
  );
  assert.equal(removed.content, "");
});

test("未知段名抛错，零依赖不发散格式", () => {
  assert.throws(() => sentinelsFor("zcode-unknown"), /未知段名/);
  assert.throws(() => locateNamedSection("", "zcode-unknown"), /未知段名/);
  assert.throws(() => upsertNamedSection("", "zcode-unknown", "x"), /未知段名/);
  assert.throws(() => removeNamedSection("", "zcode-unknown"), /未知段名/);
  assert.throws(() => sectionSnapshot("", "zcode-unknown"), /未知段名/);
});

test("sectionSnapshot 区分缺失/残缺/正常，并报告尺寸与哈希", () => {
  const appended = upsertNamedSection("", SECTION_NAMES.RULES, renderAgentsSection(RULES_A));
  const section = renderAgentsSection(RULES_A);
  const snapshot = sectionSnapshot(appended.content, SECTION_NAMES.RULES);
  assert.equal(snapshot.present, true);
  assert.equal(snapshot.malformed, false);
  assert.equal(snapshot.bytes, Buffer.byteLength(section, "utf8"));
  assert.equal(snapshot.sha256, sha256(section));
  assert.equal(snapshot.beginsAtLineStart, true);
  assert.equal(snapshot.endsAtLineEnd, true);

  const missing = sectionSnapshot("普通文本", SECTION_NAMES.RULES);
  assert.equal(missing.present, false);
  assert.equal(missing.malformed, false);

  const broken = sectionSnapshot(`${AGENTS_SECTION_BEGIN}\n正文\n`, SECTION_NAMES.RULES);
  assert.equal(broken.present, false);
  assert.equal(broken.malformed, true);
  assert.match(broken.reason, /END/);
});

test("规则段与 renderAgentsSection 输出逐字符一致（逐字兼容）", () => {
  const rendered = renderAgentsSection(RULES_A);
  const appended = upsertNamedSection("用户内容\n", SECTION_NAMES.RULES, rendered);
  const loc = locateNamedSection(appended.content, SECTION_NAMES.RULES);
  assert.ok(loc);
  assert.equal(appended.content.slice(loc.begin, loc.end), rendered);
});
